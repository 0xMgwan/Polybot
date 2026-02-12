import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;

// Ultra-fast polling interval for trade detection (milliseconds)
const FAST_POLL_INTERVAL_MS = 200;

if (!USER_ADDRESSES || USER_ADDRESSES.length === 0) {
    throw new Error('USER_ADDRESSES is not defined or empty');
}

// Create activity and position models for each user
const userModels = USER_ADDRESSES.map((address) => ({
    address,
    UserActivity: getUserActivityModel(address),
    UserPosition: getUserPositionModel(address),
}));

// Track if monitor should continue running
let isRunning = true;

/**
 * Get cached order book for an asset (if fresh enough)
 * NOTE: Currently not used - WebSocket disabled due to auth requirements
 */
export const getCachedOrderBook = (assetId: string, maxAgeMs: number = 5000) => {
    return null; // Disabled for now
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

                Logger.info(
                    `⚡ NEW TRADE from ${address.slice(0, 6)}...${address.slice(-4)}: ${activity.side} $${activity.usdcSize?.toFixed(2)} on ${activity.slug || activity.asset}`
                );
            }

            // Also fetch and update positions (less frequently - every 5th poll)
            if (Math.random() < 0.2) {
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
                const positions = await fetchData(positionsUrl);

                if (Array.isArray(positions) && positions.length > 0) {
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

// Track if this is the first run
let isFirstRun = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopWsTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
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

    Logger.success(
        `⚡ Ultra-fast trade monitor active: polling every ${FAST_POLL_INTERVAL_MS}ms`
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
