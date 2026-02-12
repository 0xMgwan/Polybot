import WebSocket from 'ws';
import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const WS_URL = ENV.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com';

// Ultra-fast polling interval for trade detection (milliseconds)
const FAST_POLL_INTERVAL_MS = 200;

// WebSocket reconnect settings
const WS_RECONNECT_DELAY_MS = 2000;
const WS_PING_INTERVAL_MS = 10000;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Create activity and position models for each user
const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

// Cache of known asset IDs from trader positions (for WebSocket market subscriptions)
let subscribedAssets: Set<string> = new Set();

// Order book cache from WebSocket (asset_id -> order book data)
const orderBookCache: Map<string, { asks: any[]; bids: any[]; timestamp: number }> = new Map();

// Track if monitor should continue running
let isRunning = true;

// WebSocket connection
let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;

/**
 * Get cached order book for an asset (if fresh enough)
 */
export const getCachedOrderBook = (assetId: string, maxAgeMs: number = 5000) => {
    const cached = orderBookCache.get(assetId);
    if (cached && Date.now() - cached.timestamp < maxAgeMs) {
        return cached;
    }
    return null;
};

/**
 * Connect to Polymarket WebSocket for real-time market data
 */
const connectWebSocket = () => {
    if (!isRunning) return;

    const wsUrl = `${WS_URL}/ws/market`;
    Logger.info(`🔌 Connecting to WebSocket: ${wsUrl}`);

    try {
        ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            Logger.success('🔌 WebSocket connected - real-time market data active');

            // Subscribe to known assets
            if (subscribedAssets.size > 0) {
                const assetIds = Array.from(subscribedAssets);
                Logger.info(`📡 Subscribing to ${assetIds.length} market assets...`);
                ws!.send(JSON.stringify({
                    assets_ids: assetIds,
                    type: 'market',
                }));
            }

            // Start ping to keep connection alive
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send('PING');
                }
            }, WS_PING_INTERVAL_MS);
        });

        ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = data.toString();
                if (message === 'PONG') return;

                const parsed = JSON.parse(message);

                // Update order book cache from market channel messages
                if (parsed.asset_id) {
                    const existing = orderBookCache.get(parsed.asset_id) || { asks: [], bids: [], timestamp: 0 };

                    if (parsed.event_type === 'book') {
                        // Full book snapshot
                        orderBookCache.set(parsed.asset_id, {
                            asks: parsed.asks || [],
                            bids: parsed.bids || [],
                            timestamp: Date.now(),
                        });
                    } else if (parsed.event_type === 'price_change' || parsed.event_type === 'tick_size_change') {
                        // Price update - update timestamp to keep cache fresh
                        existing.timestamp = Date.now();
                        if (parsed.changes) {
                            // Apply incremental changes
                            for (const change of parsed.changes) {
                                if (change.side === 'BUY') {
                                    existing.bids = updateOrderBookSide(existing.bids, change);
                                } else {
                                    existing.asks = updateOrderBookSide(existing.asks, change);
                                }
                            }
                        }
                        orderBookCache.set(parsed.asset_id, existing);
                    } else if (parsed.event_type === 'last_trade_price') {
                        // Trade happened - keep cache fresh
                        existing.timestamp = Date.now();
                        orderBookCache.set(parsed.asset_id, existing);
                    }
                }
            } catch {
                // Ignore parse errors for non-JSON messages
            }
        });

        ws.on('error', (error: Error) => {
            Logger.warning(`🔌 WebSocket error: ${error.message}`);
        });

        ws.on('close', (code: number, reason: Buffer) => {
            Logger.warning(`🔌 WebSocket closed (code: ${code}). Reconnecting in ${WS_RECONNECT_DELAY_MS / 1000}s...`);
            if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
            }
            ws = null;

            // Reconnect after delay
            if (isRunning) {
                setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS);
            }
        });
    } catch (error: any) {
        Logger.warning(`🔌 WebSocket connection failed: ${error.message}. Retrying in ${WS_RECONNECT_DELAY_MS / 1000}s...`);
        if (isRunning) {
            setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS);
        }
    }
};

/**
 * Update one side of the order book with incremental changes
 */
const updateOrderBookSide = (side: any[], change: any): any[] => {
    const price = change.price;
    const size = change.size;

    // Remove existing entry at this price
    const filtered = side.filter((entry) => entry.price !== price);

    // Add new entry if size > 0
    if (parseFloat(size) > 0) {
        filtered.push({ price, size });
    }

    // Sort: asks ascending, bids descending
    return filtered.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
};

/**
 * Subscribe to new asset IDs on the WebSocket
 */
const subscribeToAssets = (assetIds: string[]) => {
    const newAssets = assetIds.filter((id) => !subscribedAssets.has(id));
    if (newAssets.length === 0) return;

    for (const id of newAssets) {
        subscribedAssets.add(id);
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        Logger.info(`📡 Subscribing to ${newAssets.length} new market assets via WebSocket`);
        ws.send(JSON.stringify({
            assets_ids: newAssets,
            type: 'market',
        }));
    }
};

/**
 * Ultra-fast trade detection via HTTP polling
 * Polls every 200ms for new trades from monitored traders
 */
const fastPollTradeData = async () => {
    const fetchPromises = userModels.map(async ({ address, UserActivity, UserPosition }) => {
        try {
            // Fetch trade activities from Polymarket API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                return;
            }

            let newTradeCount = 0;

            // Process each activity
            for (const activity of activities) {
                // Skip if too old
                if (activity.timestamp < TOO_OLD_TIMESTAMP) {
                    continue;
                }

                // Check if this trade already exists in database
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already processed this trade
                }

                // Save new trade to database
                const newActivity = new UserActivity({
                    proxyWallet: activity.proxyWallet,
                    timestamp: activity.timestamp,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: activity.asset,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: false,
                    botExcutedTime: 0,
                });

                await newActivity.save();
                newTradeCount++;

                // Subscribe to this asset on WebSocket for real-time order book data
                if (activity.asset) {
                    subscribeToAssets([activity.asset]);
                }

                Logger.info(
                    `⚡ NEW TRADE from ${address.slice(0, 6)}...${address.slice(-4)}: ${activity.side} $${activity.usdcSize?.toFixed(2)} on ${activity.slug || activity.asset}`
                );
            }

            // Also fetch and update positions (less frequently - every 5th poll)
            if (Math.random() < 0.2) {
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
                const positions = await fetchData(positionsUrl);

                if (Array.isArray(positions) && positions.length > 0) {
                    // Subscribe to all trader's active assets for WebSocket market data
                    const assetIds = positions
                        .map((p: any) => p.asset)
                        .filter((id: string) => id);
                    subscribeToAssets(assetIds);

                    for (const position of positions) {
                        await UserPosition.findOneAndUpdate(
                            { asset: position.asset, conditionId: position.conditionId },
                            {
                                proxyWallet: position.proxyWallet,
                                asset: position.asset,
                                conditionId: position.conditionId,
                                size: position.size,
                                avgPrice: position.avgPrice,
                                initialValue: position.initialValue,
                                currentValue: position.currentValue,
                                cashPnl: position.cashPnl,
                                percentPnl: position.percentPnl,
                                totalBought: position.totalBought,
                                realizedPnl: position.realizedPnl,
                                percentRealizedPnl: position.percentRealizedPnl,
                                curPrice: position.curPrice,
                                redeemable: position.redeemable,
                                mergeable: position.mergeable,
                                title: position.title,
                                slug: position.slug,
                                icon: position.icon,
                                eventSlug: position.eventSlug,
                                outcome: position.outcome,
                                outcomeIndex: position.outcomeIndex,
                                oppositeOutcome: position.oppositeOutcome,
                                oppositeAsset: position.oppositeAsset,
                                endDate: position.endDate,
                                negativeRisk: position.negativeRisk,
                            },
                            { upsert: true }
                        );
                    }
                }
            }
        } catch (error) {
            // Silently handle errors to avoid spamming logs at 200ms intervals
            // Only log if it's not a network timeout
            if (error instanceof Error && !error.message.includes('timeout')) {
                Logger.error(
                    `Error polling ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
                );
            }
        }
    });

    // Poll all traders in parallel for maximum speed
    await Promise.all(fetchPromises);
};

/**
 * Initialize: fetch trader positions and subscribe to their markets
 */
const initTraderSubscriptions = async () => {
    Logger.info('📡 Initializing trader market subscriptions...');

    for (const { address } of userModels) {
        try {
            const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
            const positions = await fetchData(positionsUrl);

            if (Array.isArray(positions) && positions.length > 0) {
                const assetIds = positions
                    .map((p: any) => p.asset)
                    .filter((id: string) => id);
                subscribeToAssets(assetIds);
                Logger.info(
                    `📡 ${address.slice(0, 6)}...${address.slice(-4)}: subscribed to ${assetIds.length} market assets`
                );
            }
        } catch (error) {
            Logger.warning(`Failed to fetch positions for ${address.slice(0, 6)}...${address.slice(-4)}`);
        }
    }
};

// Track if this is the first run
let isFirstRun = true;

/**
 * Stop the WebSocket trade monitor gracefully
 */
export const stopWsTradeMonitor = () => {
    isRunning = false;
    Logger.info('WebSocket trade monitor shutdown requested...');

    if (ws) {
        ws.close();
        ws = null;
    }
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
};

/**
 * Main WebSocket trade monitor
 * Uses WebSocket for real-time market data + ultra-fast HTTP polling for trade detection
 */
const wsTradeMonitor = async () => {
    // Run the same init as the original trade monitor
    const counts: number[] = [];
    for (const { address, UserActivity } of userModels) {
        const count = await UserActivity.countDocuments();
        counts.push(count);
    }
    Logger.clearLine();
    Logger.dbConnection(USER_ADDRESSES, counts);

    // Show your own positions first
    try {
        const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
        const myPositions = await fetchData(myPositionsUrl);

        const getMyBalance = (await import('../utils/getMyBalance')).default;
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            let totalValue = 0;
            let initialValue = 0;
            let weightedPnl = 0;
            myPositions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const initial = pos.initialValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                initialValue += initial;
                weightedPnl += value * pnl;
            });
            const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

            const myTopPositions = myPositions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                myTopPositions,
                myOverallPnl,
                totalValue,
                initialValue,
                currentBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
        }
    } catch (error) {
        Logger.error(`Failed to fetch your positions: ${error}`);
    }

    // Show trader positions
    const positionCounts: number[] = [];
    const positionDetails: any[][] = [];
    const profitabilities: number[] = [];
    for (const { address, UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        let totalValue = 0;
        let weightedPnl = 0;
        positions.forEach((pos) => {
            const value = pos.currentValue || 0;
            const pnl = pos.percentPnl || 0;
            totalValue += value;
            weightedPnl += value * pnl;
        });
        const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
        profitabilities.push(overallPnl);

        const topPositions = positions
            .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
            .slice(0, 3)
            .map((p) => p.toObject());
        positionDetails.push(topPositions);
    }
    Logger.clearLine();
    Logger.tradersPositions(USER_ADDRESSES, positionCounts, positionDetails, profitabilities);

    // Connect WebSocket for real-time market data
    connectWebSocket();

    // Initialize trader market subscriptions
    await initTraderSubscriptions();

    Logger.success(
        `⚡ WebSocket monitor active: polling every ${FAST_POLL_INTERVAL_MS}ms + real-time market data`
    );
    Logger.separator();

    // On first run, mark all existing historical trades as already processed
    if (isFirstRun) {
        Logger.info('First run: marking all historical trades as processed...');
        for (const { address, UserActivity } of userModels) {
            const count = await UserActivity.updateMany(
                { bot: false },
                { $set: { bot: true, botExcutedTime: 999 } }
            );
            if (count.modifiedCount > 0) {
                Logger.info(
                    `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                );
            }
        }
        isFirstRun = false;
        Logger.success('\nHistorical trades processed. Now monitoring for new trades only.');
        Logger.separator();
    }

    // Ultra-fast polling loop
    while (isRunning) {
        await fastPollTradeData();
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FAST_POLL_INTERVAL_MS));
    }

    Logger.info('WebSocket trade monitor stopped');
};

export default wsTradeMonitor;
