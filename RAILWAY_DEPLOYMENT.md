# Railway.app Deployment Guide

## Quick Deploy to Railway

### Step 1: Sign up for Railway
1. Go to https://railway.app
2. Sign up with your GitHub account
3. Authorize Railway to access your repositories

### Step 2: Create New Project
1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose `0xMgwan/Polybot` repository
4. Railway will automatically detect it's a Node.js project

### Step 3: Configure Environment Variables
Click on your project → Variables → Add all these variables:

**Required Variables:**
```
USER_ADDRESSES=0xe9c6312464b52aa3eff13d822b003282075995c9,0xe00740bce98a594e26861838885ab310ec3b548c
PROXY_WALLET=0xabd602d487ecf5e227f875bc31a6fdd2489daba8
PRIVATE_KEY=<your-private-key>
MONGODB_URI=<your-mongodb-uri>
```

**Optional Variables (use defaults or customize):**
```
COPY_STRATEGY=FIXED
COPY_SIZE=2.0
MAX_ORDER_SIZE_USD=5.0
MIN_ORDER_SIZE_USD=1.0
FETCH_INTERVAL=1
POLYMARKET_API_URL=https://clob.polymarket.com
POLYGON_RPC_URL=https://polygon-rpc.com
```

### Step 4: Deploy
1. Railway will automatically build and deploy
2. Wait for build to complete (~2-3 minutes)
3. Check logs to verify bot is running

### Step 5: Monitor Your Bot
- View logs: Click on your service → Logs
- Check status: Service should show "Active"
- Monitor trades: Bot will log all detected and executed trades

## Important Notes

✅ **24/7 Operation:** Bot runs continuously on Railway servers
✅ **Auto-restart:** Railway automatically restarts if bot crashes
✅ **Free Tier:** $5 free credit per month (should be enough for this bot)
✅ **Logs:** Full access to bot logs for monitoring

## Troubleshooting

**Bot not starting?**
- Check environment variables are set correctly
- Verify PRIVATE_KEY and MONGODB_URI are valid
- Check logs for error messages

**Bot not executing trades?**
- Verify you have USDC balance in your Polymarket wallet
- Check traders are making new trades
- Ensure markets have liquidity

**Need to update code?**
- Push changes to GitHub
- Railway auto-deploys on every push to main branch

## Cost Estimate
- Free tier: $5/month credit (enough for this bot)
- If exceeded: ~$5-10/month for basic usage
- No credit card required for free tier

## Support
- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
