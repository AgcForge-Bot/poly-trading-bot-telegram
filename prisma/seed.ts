import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const CONFIG_DEFAULTS: Record<string, string> = {
    FETCH_INTERVAL: "1",
    TOO_OLD_TIMESTAMP: "24",
    RETRY_LIMIT: "3",
    REQUEST_TIMEOUT_MS: "10000",
    NETWORK_RETRY_LIMIT: "3",
    COPY_STRATEGY: "OWN_CUSTOM",
    COPY_SIZE: "10.0",
    MAX_ORDER_SIZE_USD: "100.0",
    MIN_ORDER_SIZE_USD: "1.0",
    MAX_SLIPPAGE_PERCENT: "15",
    OWN_CUSTOM_AMOUNT_USD: "1.0",
    TAKER_FEE_BPS: "0",
    ADAPTIVE_MIN_PERCENT: "5.0",
    ADAPTIVE_MAX_PERCENT: "20.0",
    ADAPTIVE_THRESHOLD_USD: "500.0",
    TRADE_AGGREGATION_ENABLED: "false",
    TRADE_AGGREGATION_WINDOW_SECONDS: "300",
    MAX_PENDING_TRADE_AGE_SECONDS: "300",
    USE_AUTO_TRADE_ADDRESS_FROM_API: "false",
    MAX_LIST_TRADE_ADDRESS_FROM_API: "10",
    INTERVAL_REFETCHING_ADDRESS_LIST: String(4 * 3_600_000),
    LEADERBOARD_TIME_PERIOD: "MONTH",
    LEADERBOARD_MIN_PROFIT_USD: "500.0",
    LEADERBOARD_MIN_VOLUME_USD: "1000.0",
    LEADERBOARD_MIN_WIN_RATE: "0.5",
    LEADERBOARD_SCORE_WEIGHT_PROFIT: "0.50",
    LEADERBOARD_SCORE_WEIGHT_VOLUME: "0.30",
    LEADERBOARD_SCORE_WEIGHT_ACTIVITY: "0.20",
    LEADERBOARD_SCORE_WEIGHT_WINRATE: "0.00",
    TELEGRAM_NOTIFICATIONS_ENABLED: "false",
    TELEGRAM_CONTROL_ENABLED: "false",
    TELEGRAM_PM2_CONTROL_ENABLED: "false",
    TELEGRAM_ADMIN_CHAT_IDS: "[]",
    TELEGRAM_PM2_PIN: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    TELEGRAM_DAILY_REPORT_HOUR: "8",
    TELEGRAM_CHAT_ID_CONTROL: "",
    TRADING_ENABLED: "true",
    PM2_PROCESS_NAME: "copy-bot-poly",
    TAKER_FEE_CACHE: "{}",
};

const CONFIG_KEYS: string[] = [
    "USER_ADDRESSES",
    "PROXY_WALLET",
    "PRIVATE_KEY",
    "CLOB_HTTP_URL",
    "CLOB_WS_URL",
    "RPC_URL",
    "USDC_CONTRACT_ADDRESS",
    "FETCH_INTERVAL",
    "TOO_OLD_TIMESTAMP",
    "RETRY_LIMIT",
    "REQUEST_TIMEOUT_MS",
    "NETWORK_RETRY_LIMIT",
    "COPY_STRATEGY",
    "COPY_SIZE",
    "COPY_PERCENTAGE",
    "TRADE_MULTIPLIER",
    "MAX_ORDER_SIZE_USD",
    "MIN_ORDER_SIZE_USD",
    "MAX_POSITION_SIZE_USD",
    "MAX_DAILY_VOLUME_USD",
    "MAX_SLIPPAGE_PERCENT",
    "OWN_CUSTOM_AMOUNT_USD",
    "TAKER_FEE_BPS",
    "ADAPTIVE_MIN_PERCENT",
    "ADAPTIVE_MAX_PERCENT",
    "ADAPTIVE_THRESHOLD_USD",
    "TIERED_MULTIPLIERS",
    "TRADE_AGGREGATION_ENABLED",
    "TRADE_AGGREGATION_WINDOW_SECONDS",
    "MAX_PENDING_TRADE_AGE_SECONDS",
    "USE_AUTO_TRADE_ADDRESS_FROM_API",
    "MAX_LIST_TRADE_ADDRESS_FROM_API",
    "INTERVAL_REFETCHING_ADDRESS_LIST",
    "LEADERBOARD_TIME_PERIOD",
    "LEADERBOARD_MIN_PROFIT_USD",
    "LEADERBOARD_MIN_VOLUME_USD",
    "LEADERBOARD_MIN_WIN_RATE",
    "LEADERBOARD_SCORE_WEIGHT_PROFIT",
    "LEADERBOARD_SCORE_WEIGHT_VOLUME",
    "LEADERBOARD_SCORE_WEIGHT_ACTIVITY",
    "LEADERBOARD_SCORE_WEIGHT_WINRATE",
    "TELEGRAM_NOTIFICATIONS_ENABLED",
    "TELEGRAM_CONTROL_ENABLED",
    "TELEGRAM_PM2_CONTROL_ENABLED",
    "TELEGRAM_ADMIN_CHAT_IDS",
    "TELEGRAM_PM2_PIN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_DAILY_REPORT_HOUR",
    "TELEGRAM_CHAT_ID_CONTROL",
    "TRADING_ENABLED",
    "PM2_PROCESS_NAME",
    "TAKER_FEE_CACHE",
];

const getSeedValue = (key: string): string | undefined => {
    return process.env[key] ?? CONFIG_DEFAULTS[key];
};

const seed = async (): Promise<void> => {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is not set (required to seed Config table)");
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    try {
        for (const key of CONFIG_KEYS) {
            if (key === "DATABASE_URL") continue;

            const value = getSeedValue(key);
            if (value === undefined) {
                skipped++;
                continue;
            }

            const existing = await prisma.config.findFirst({ where: { key } });
            if (existing) {
                await prisma.config.update({ where: { id: existing.id }, data: { value } });
                updated++;
            } else {
                await prisma.config.create({ data: { key, value } });
                created++;
            }
        }
    } catch (error) {
        console.error("Error seeding Config table:", error);
        throw error;
    }

    console.log(`Seeded Config: created=${created}, updated=${updated}, skipped=${skipped}`);
};

seed()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

