import "dotenv/config";
import { getSetupConfig } from "../models/setupConfig";

const isValidEthereumAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address);

const isHttpish = (v: string): boolean =>
    v.startsWith("http://") ||
    v.startsWith("https://") ||
    v.startsWith("postgres://") ||
    v.startsWith("postgresql://") ||
    v.startsWith("prisma://") ||
    v.startsWith("mongodb://") ||
    v.startsWith("mongodb+srv://");

const validateEnv = (cfg: SetupConfig): void => {
    const missing: string[] = [];

    if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
    if (!cfg.USE_AUTO_TRADE_ADDRESS_FROM_API && cfg.USER_ADDRESSES.length === 0) {
        missing.push("USER_ADDRESSES");
    }

    for (const k of [
        "PROXY_WALLET",
        "PRIVATE_KEY",
        "CLOB_HTTP_URL",
        "CLOB_WS_URL",
        "RPC_URL",
        "USDC_CONTRACT_ADDRESS",
    ] as const) {
        if (!cfg[k]) missing.push(k);
    }

    if (missing.length > 0) {
        throw new Error(`Missing required configuration: ${missing.join(", ")}`);
    }

    if (!isValidEthereumAddress(cfg.PROXY_WALLET)) {
        throw new Error(`Invalid PROXY_WALLET address format: ${cfg.PROXY_WALLET}`);
    }

    if (!isValidEthereumAddress(cfg.USDC_CONTRACT_ADDRESS)) {
        throw new Error(`Invalid USDC_CONTRACT_ADDRESS format: ${cfg.USDC_CONTRACT_ADDRESS}`);
    }

    for (const a of cfg.USER_ADDRESSES) {
        if (!isValidEthereumAddress(a)) {
            throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${a}`);
        }
    }

    if (!isHttpish(cfg.CLOB_HTTP_URL)) throw new Error(`Invalid CLOB_HTTP_URL: ${cfg.CLOB_HTTP_URL}`);
    if (!cfg.CLOB_WS_URL.startsWith("ws")) throw new Error(`Invalid CLOB_WS_URL: ${cfg.CLOB_WS_URL}`);
    if (!isHttpish(cfg.RPC_URL)) throw new Error(`Invalid RPC_URL: ${cfg.RPC_URL}`);

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl || !isHttpish(dbUrl)) throw new Error(`Invalid DATABASE_URL: ${dbUrl ?? ""}`);

    const intChecks: Array<[string, number, number, number]> = [
        ["FETCH_INTERVAL", cfg.FETCH_INTERVAL, 1, Number.POSITIVE_INFINITY],
        ["RETRY_LIMIT", cfg.RETRY_LIMIT, 1, 10],
        ["TOO_OLD_TIMESTAMP", cfg.TOO_OLD_TIMESTAMP, 1, Number.POSITIVE_INFINITY],
        ["REQUEST_TIMEOUT_MS", cfg.REQUEST_TIMEOUT_MS, 1000, Number.POSITIVE_INFINITY],
        ["NETWORK_RETRY_LIMIT", cfg.NETWORK_RETRY_LIMIT, 1, 10],
        ["TRADE_AGGREGATION_WINDOW_SECONDS", cfg.TRADE_AGGREGATION_WINDOW_SECONDS, 1, Number.POSITIVE_INFINITY],
        ["TELEGRAM_DAILY_REPORT_HOUR", cfg.TELEGRAM_DAILY_REPORT_HOUR, 0, 23],
        ["MAX_LIST_TRADE_ADDRESS_FROM_API", cfg.MAX_LIST_TRADE_ADDRESS_FROM_API, 1, 50],
        ["INTERVAL_REFETCHING_ADDRESS_LIST", cfg.INTERVAL_REFETCHING_ADDRESS_LIST, 60_000, Number.POSITIVE_INFINITY],
    ];

    for (const [k, v, min, max] of intChecks) {
        if (!Number.isFinite(v) || v < min || v > max) {
            throw new Error(`Invalid ${k}: ${v}. Must be between ${min} and ${max}.`);
        }
    }

    if (!Number.isFinite(cfg.MAX_SLIPPAGE_PERCENT) || cfg.MAX_SLIPPAGE_PERCENT < 0 || cfg.MAX_SLIPPAGE_PERCENT > 1) {
        throw new Error(`Invalid MAX_SLIPPAGE_PERCENT: ${cfg.MAX_SLIPPAGE_PERCENT}. Must be between 0 and 1.`);
    }

    for (const [k, v] of [
        ["LEADERBOARD_SCORE_WEIGHT_PROFIT", cfg.LEADERBOARD_SCORE_WEIGHT_PROFIT],
        ["LEADERBOARD_SCORE_WEIGHT_VOLUME", cfg.LEADERBOARD_SCORE_WEIGHT_VOLUME],
        ["LEADERBOARD_SCORE_WEIGHT_ACTIVITY", cfg.LEADERBOARD_SCORE_WEIGHT_ACTIVITY],
        ["LEADERBOARD_SCORE_WEIGHT_WINRATE", cfg.LEADERBOARD_SCORE_WEIGHT_WINRATE],
    ] as const) {
        if (!Number.isFinite(v) || v < 0 || v > 1) {
            throw new Error(`Invalid ${k}: ${v}. Must be a number between 0 and 1.`);
        }
    }
};

const normalize = (cfg: SetupConfig): SetupConfig => {
    const maxList = Math.min(Math.max(1, cfg.MAX_LIST_TRADE_ADDRESS_FROM_API), 50);
    const refetch = Math.max(60_000, cfg.INTERVAL_REFETCHING_ADDRESS_LIST);

    return {
        ...cfg,
        MAX_LIST_TRADE_ADDRESS_FROM_API: maxList,
        INTERVAL_REFETCHING_ADDRESS_LIST: refetch,
        DATABASE_URL: process.env.DATABASE_URL ?? cfg.DATABASE_URL,
    };
};

const loaded = normalize(await getSetupConfig());
validateEnv(loaded);

export const ENV = loaded;
