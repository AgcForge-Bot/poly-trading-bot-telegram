export { };

declare global {
    interface SetupConfig {
        USER_ADDRESSES: string[];
        PROXY_WALLET: string;
        PRIVATE_KEY: string;
        CLOB_HTTP_URL: string;
        CLOB_WS_URL: string;
        FETCH_INTERVAL: number;
        TOO_OLD_TIMESTAMP: number;
        RETRY_LIMIT: number;
        TRADE_MULTIPLIER: number;
        MAX_ORDER_SIZE_USD: number;
        MIN_ORDER_SIZE_USD: number;
        MAX_POSITION_SIZE_USD: number;
        MAX_DAILY_VOLUME_USD: number;
        COPY_PERCENTAGE: number;
        COPY_SIZE: number;
        COPY_STRATEGY_CONFIG: CopyStrategyConfig;
        REQUEST_TIMEOUT_MS: number;
        NETWORK_RETRY_LIMIT: number;
        TRADE_AGGREGATION_ENABLED: boolean;
        TRADE_AGGREGATION_WINDOW_SECONDS: number;
        MAX_SLIPPAGE_PERCENT: number;
        ADAPTIVE_MIN_PERCENT: number;
        ADAPTIVE_MAX_PERCENT: number;
        ADAPTIVE_THRESHOLD_USD: number;
        TIERED_MULTIPLIERS: MultiplierTier[];
        DATABASE_URL: string;
        RPC_URL: string;
        USDC_CONTRACT_ADDRESS: string;
        USE_AUTO_TRADE_ADDRESS_FROM_API: boolean;
        MAX_LIST_TRADE_ADDRESS_FROM_API: number;
        INTERVAL_REFETCHING_ADDRESS_LIST: number;
        LEADERBOARD_TIME_PERIOD: "ALL" | "MONTH" | "WEEK" | "DAY";
        LEADERBOARD_MIN_PROFIT_USD: number;
        LEADERBOARD_MIN_VOLUME_USD: number;
        LEADERBOARD_MIN_WIN_RATE: number;
        LEADERBOARD_SCORE_WEIGHT_PROFIT: number;
        LEADERBOARD_SCORE_WEIGHT_VOLUME: number;
        LEADERBOARD_SCORE_WEIGHT_ACTIVITY: number;
        LEADERBOARD_SCORE_WEIGHT_WINRATE: number;
        LEADERBOARD_SCORER: leaderboardScored;
        LEADERBOARD_FILTER: leaderboardFilter;
        TELEGRAM_NOTIFICATIONS_ENABLED: boolean;
        TELEGRAM_BOT_TOKEN: string;
        TELEGRAM_CHAT_ID: string;
        TELEGRAM_DAILY_REPORT_HOUR: number;
    }

    interface leaderboardScored {
        weightProfit: number;
        weightVolume: number;
        weightActivity: number;
        weightWinRate: number;
    }

    interface leaderboardFilter {
        minProfitUSD: number;
        minVolumeUSD: number;
        minWinRate: number;
    }


    const enum CopyStrategy {
        PERCENTAGE = "PERCENTAGE",
        FIXED = "FIXED",
        ADAPTIVE = "ADAPTIVE",
    }
    /**
     * Tier definition for tiered multipliers
     * Example: { min: 100, max: 500, multiplier: 0.2 }
     * means trades between $100-$500 use 0.2x multiplier
     */
    interface MultiplierTier {
        min: number;          // Minimum trade size in USD (inclusive)
        max: number | null;   // Maximum trade size in USD (exclusive), null = infinity
        multiplier: number;   // Multiplier to apply
    }

    interface CopyStrategyConfig {
        // Core strategy
        strategy: CopyStrategy;

        // Main parameter (meaning depends on strategy)
        // PERCENTAGE: Percentage of trader's order (e.g., 10.0 = 10%)
        // FIXED: Fixed dollar amount per trade (e.g., 50.0 = $50)
        // ADAPTIVE: Base percentage for adaptive scaling
        copySize: number;

        // Adaptive strategy parameters (only used if strategy = ADAPTIVE)
        adaptiveMinPercent?: number; // Minimum percentage for large orders
        adaptiveMaxPercent?: number; // Maximum percentage for small orders
        adaptiveThreshold?: number; // Threshold in USD to trigger adaptation

        // Tiered multipliers (optional - applies to all strategies)
        // If set, multiplier is applied based on trader's order size
        tieredMultipliers?: MultiplierTier[];

        // Legacy single multiplier (for backward compatibility)
        // Ignored if tieredMultipliers is set
        tradeMultiplier?: number;

        // Safety limits
        maxOrderSizeUSD: number; // Maximum size for a single order
        minOrderSizeUSD: number; // Minimum size for a single order
        maxPositionSizeUSD?: number; // Maximum total size for a position (optional)
        maxDailyVolumeUSD?: number; // Maximum total volume per day (optional)
    }

    interface OrderSizeCalculation {
        traderOrderSize: number; // Original trader's order size
        baseAmount: number; // Calculated amount before limits
        finalAmount: number; // Final amount after applying limits
        strategy: CopyStrategy; // Strategy used
        cappedByMax: boolean; // Whether capped by MAX_ORDER_SIZE
        reducedByBalance: boolean; // Whether reduced due to balance
        belowMinimum: boolean; // Whether below minimum threshold
        reasoning: string; // Human-readable explanation
    }
    interface LeaderboardEntry {
        proxyWallet: string;
        userName?: string;
        vol?: number;
        pnl?: number;
    }

    interface TraderCandidate {
        address: string;
        userName?: string;
        pnl: number;
        vol: number;
        activityCount: number;
    }

    interface ScoredTrader extends TraderCandidate {
        score: number;
    }

    interface ScanCycleResult {
        addresses: string[];
        metadata: { address: string; userName?: string; pnl: number; vol: number; score: number }[];
    }


    type NotifLevel = 'error' | 'warning' | 'info' | 'success';

    interface TelegramPayload {
        level: NotifLevel;
        title: string;
        body: string;
        footer?: string;
    }

    interface TelegramQueueItem {
        html: string;
        resolve: (ok: boolean) => void;
    }

    interface OrderFilledParams {
        side: 'BUY' | 'SELL';
        marketTitle: string;
        eventSlug?: string;
        outcome: string;
        amountUSD: number;
        price: number;
        tokensFilled: number;
        traderAddress: string;
        txHash?: string;
    }

    interface PnLResultParams {
        marketTitle: string;
        eventSlug?: string;
        outcome: string;
        avgBuyPrice: number; // price we paid per token
        sellPrice: number; // price we received per token
        tokensSold: number;
        realizedPnlUSD: number; // (sellPrice - avgBuyPrice) * tokensSold
        isFullClose: boolean; // true = closed entire position
    }

    interface DailyReportStats {
        date: string; // "2025-01-01"
        totalTrades: number;
        winTrades: number;
        lossTrades: number;
        totalPnlUSD: number;
        totalVolumeUSD: number;
        currentBalance: number;
        openPositions: number;
    }

    /// Daily report database stats
    type DailyReportDbStats = {
        totalTrades: number;
        winTrades: number;
        lossTrades: number;
        totalPnlUSD: number;
        totalVolumeUSD: number;
        openPositions: number;
    };

    interface HealthCheckResult {
        healthy: boolean;
        checks: {
            database: { status: 'ok' | 'error'; message: string };
            rpc: { status: 'ok' | 'error'; message: string };
            balance: { status: 'ok' | 'error' | 'warning'; message: string; balance?: number };
            polymarketApi: { status: 'ok' | 'error'; message: string };
        };
        timestamp: number;
    }

    interface TradersSnapshot {
        updatedAt: string;          // ISO timestamp
        timePeriod: string;
        count: number;
        addresses: string[];
        metadata: { address: string; userName?: string; pnl: number; vol: number; score: number }[];
    }

}
