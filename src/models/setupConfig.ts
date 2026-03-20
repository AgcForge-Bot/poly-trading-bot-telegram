import { prisma } from '../lib/prisma';
import type { Config } from '../types/prisma/client';
import Logger from '../utils/logger';
import { parseTieredMultipliers } from '../config/copyStrategy';

type ConfigRow = Pick<Config, 'key' | 'value'> & { updated_at?: Date };

const CONFIG_DEFAULTS: Record<string, string> = {
    FETCH_INTERVAL: '1',
    TOO_OLD_TIMESTAMP: '24',
    RETRY_LIMIT: '3',
    TRADE_MULTIPLIER: '1.0',
    MAX_ORDER_SIZE_USD: '100.0',
    MIN_ORDER_SIZE_USD: '1.0',
    MAX_POSITION_SIZE_USD: '0',
    MAX_DAILY_VOLUME_USD: '0',
    COPY_PERCENTAGE: '10.0',
    COPY_SIZE: '10.0',
    COPY_STRATEGY: 'PERCENTAGE',
    REQUEST_TIMEOUT_MS: '10000',
    NETWORK_RETRY_LIMIT: '3',
    TRADE_AGGREGATION_ENABLED: 'false',
    TRADE_AGGREGATION_WINDOW_SECONDS: '300',
    MAX_SLIPPAGE_PERCENT: '15',
    OWN_CUSTOM_AMOUNT_USD: '1.0',
    ADAPTIVE_MIN_PERCENT: '5.0',
    ADAPTIVE_MAX_PERCENT: '20.0',
    ADAPTIVE_THRESHOLD_USD: '500.0',
    USE_AUTO_TRADE_ADDRESS_FROM_API: 'false',
    MAX_LIST_TRADE_ADDRESS_FROM_API: '10',
    INTERVAL_REFETCHING_ADDRESS_LIST: String(4 * 3_600_000),
    LEADERBOARD_TIME_PERIOD: 'MONTH',
    LEADERBOARD_MIN_PROFIT_USD: '500.0',
    LEADERBOARD_MIN_VOLUME_USD: '1000.0',
    LEADERBOARD_MIN_WIN_RATE: '0.5',
    LEADERBOARD_SCORE_WEIGHT_PROFIT: '0.50',
    LEADERBOARD_SCORE_WEIGHT_VOLUME: '0.30',
    LEADERBOARD_SCORE_WEIGHT_ACTIVITY: '0.20',
    LEADERBOARD_SCORE_WEIGHT_WINRATE: '0.00',
    TELEGRAM_NOTIFICATIONS_ENABLED: 'false',
    TELEGRAM_CONTROL_ENABLED: 'false',
    TELEGRAM_PM2_CONTROL_ENABLED: 'false',
    TELEGRAM_ADMIN_CHAT_IDS: '[]',
    TELEGRAM_PM2_PIN: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_DAILY_REPORT_HOUR: '8',
    TELEGRAM_CHAT_ID_CONTROL: '',
    TRADING_ENABLED: 'true',

    PM2_PROCESS_NAME: 'copy-bot-poly',
};

const normalizeScalar = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    let v = raw.trim();
    if (v.length >= 2) {
        const first = v[0];
        const last = v[v.length - 1];
        if ((first === last && (first === '"' || first === "'" || first === '`'))) {
            v = v.slice(1, -1).trim();
        }
    }
    return v;
};

const parseNumber = (raw: string | undefined, fallback: number): number => {
    const v = normalizeScalar(raw);
    if (v === undefined || v.length === 0) return fallback;
    const cleaned = v.replace(/[$,%_\s]/g, '').replace(/,/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
};

const parseIntSafe = (raw: string | undefined, fallback: number): number => {
    const v = normalizeScalar(raw);
    if (v === undefined || v.length === 0) return fallback;
    const cleaned = v.replace(/[$,%_\s]/g, '').replace(/,/g, '');
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : fallback;
};

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    const v = normalizeScalar(raw);
    if (v === undefined) return fallback;
    return v === 'true' || v === '1' || v.toLowerCase() === 'yes';
};

const parseUserAddresses = (input: string | undefined): string[] => {
    const trimmed = normalizeScalar(input) ?? '';
    if (trimmed.length === 0) return [];

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((a) => String(a).toLowerCase().trim()).filter(Boolean);
            }
        } catch {
            return [];
        }
    }

    return trimmed
        .split(',')
        .map((a) => a.toLowerCase().trim())
        .filter(Boolean);
};

const parseStringList = (input: string | undefined): string[] => {
    const trimmed = normalizeScalar(input) ?? '';
    if (trimmed.length === 0) return [];

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((v) => String(v).trim()).filter(Boolean);
            }
        } catch {
            return [];
        }
    }

    return trimmed
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
};

const buildConfigMap = (rows: ConfigRow[]): Map<string, string> => {
    const sorted = [...rows].sort((a, b) => {
        const ta = a.updated_at?.getTime() ?? 0;
        const tb = b.updated_at?.getTime() ?? 0;
        return ta - tb;
    });
    return new Map(sorted.map((r) => [r.key, r.value]));
};

const getCfg = (m: Map<string, string>, key: string): string | undefined => {
    return normalizeScalar(m.get(key) ?? CONFIG_DEFAULTS[key]);
};

const parseCopyStrategyConfig = (m: Map<string, string>): CopyStrategyConfig => {
    const copyStrategyRaw = (getCfg(m, 'COPY_STRATEGY') ?? 'PERCENTAGE').toUpperCase();
    const strategyKey: 'PERCENTAGE' | 'FIXED' | 'ADAPTIVE' | 'OWN_CUSTOM' =
        copyStrategyRaw === 'ADAPTIVE'
            ? 'ADAPTIVE'
            : copyStrategyRaw === 'FIXED'
                ? 'FIXED'
                : copyStrategyRaw === 'OWN_CUSTOM'
                    ? 'OWN_CUSTOM'
                    : 'PERCENTAGE';
    const strategy = strategyKey as unknown as CopyStrategy;

    const ownCustomAmountUSD = parseNumber(getCfg(m, 'OWN_CUSTOM_AMOUNT_USD'), 1.0);

    const base: CopyStrategyConfig = {
        strategy,
        copySize:
            strategyKey === 'OWN_CUSTOM'
                ? ownCustomAmountUSD
                : parseNumber(getCfg(m, 'COPY_SIZE'), 10.0),
        maxOrderSizeUSD: parseNumber(getCfg(m, 'MAX_ORDER_SIZE_USD'), 100.0),
        minOrderSizeUSD: parseNumber(getCfg(m, 'MIN_ORDER_SIZE_USD'), 1.0),
    };

    if (strategyKey === 'OWN_CUSTOM') {
        base.ownCustomAmountUSD = ownCustomAmountUSD;
    }

    const maxPosition = parseNumber(getCfg(m, 'MAX_POSITION_SIZE_USD'), 0);
    if (maxPosition > 0) base.maxPositionSizeUSD = maxPosition;

    const maxDaily = parseNumber(getCfg(m, 'MAX_DAILY_VOLUME_USD'), 0);
    if (maxDaily > 0) base.maxDailyVolumeUSD = maxDaily;

    const tiersRaw = getCfg(m, 'TIERED_MULTIPLIERS');
    if (tiersRaw) {
        base.tieredMultipliers = parseTieredMultipliers(tiersRaw);
    } else {
        const tradeMultiplier = parseNumber(getCfg(m, 'TRADE_MULTIPLIER'), 1.0);
        if (tradeMultiplier !== 1.0) base.tradeMultiplier = tradeMultiplier;
    }

    if (strategyKey === 'ADAPTIVE') {
        base.adaptiveMinPercent = parseNumber(getCfg(m, 'ADAPTIVE_MIN_PERCENT'), base.copySize);
        base.adaptiveMaxPercent = parseNumber(getCfg(m, 'ADAPTIVE_MAX_PERCENT'), base.copySize);
        base.adaptiveThreshold = parseNumber(getCfg(m, 'ADAPTIVE_THRESHOLD_USD'), 500);
    }

    return base;
};

export const getAppConfig = async (): Promise<ConfigRow[]> => {
    try {
        return (await prisma.config.findMany({ select: { key: true, value: true, updated_at: true } })) as ConfigRow[];
    } catch (error) {
        Logger.error(`Failed to get app config: ${error}`);
        return [];
    }
};

export const findByKey = async (key: string): Promise<Pick<Config, 'key' | 'value'> | null> => {
    try {
        return await prisma.config.findFirst({
            where: { key },
            orderBy: { updated_at: 'desc' },
            select: { key: true, value: true },
        });
    } catch (error) {
        Logger.error(`Failed to get app config: ${error}`);
        return null;
    }
};

export const updateByKey = async (key: string, value: string): Promise<void> => {
    try {
        const res = await prisma.config.updateMany({ where: { key }, data: { value } });
        if (res.count === 0) {
            await prisma.config.create({ data: { key, value } });
        }
    } catch (error) {
        Logger.error(`Failed to update config: ${error}`);
        throw error;
    }
};

export const getSetupConfig = async (): Promise<SetupConfig> => {
    const rows = await getAppConfig();
    const m = buildConfigMap(rows);

    const userAddresses = parseUserAddresses(getCfg(m, 'USER_ADDRESSES'));
    const maxSlippagePercent = parseNumber(getCfg(m, 'MAX_SLIPPAGE_PERCENT'), 15) / 100;
    const ownCustomAmountUSD = parseNumber(getCfg(m, 'OWN_CUSTOM_AMOUNT_USD'), 1.0);
    const adaptiveMin = parseNumber(getCfg(m, 'ADAPTIVE_MIN_PERCENT'), 5.0);
    const adaptiveMax = parseNumber(getCfg(m, 'ADAPTIVE_MAX_PERCENT'), 20.0);
    const adaptiveThreshold = parseNumber(getCfg(m, 'ADAPTIVE_THRESHOLD_USD'), 500.0);
    const tiered = getCfg(m, 'TIERED_MULTIPLIERS') ? parseTieredMultipliers(getCfg(m, 'TIERED_MULTIPLIERS') as string) : [];

    const leaderboardTime = (getCfg(m, 'LEADERBOARD_TIME_PERIOD') ?? 'MONTH').toUpperCase();
    const leaderboardPeriod: SetupConfig['LEADERBOARD_TIME_PERIOD'] =
        leaderboardTime === 'ALL'
            ? 'ALL'
            : leaderboardTime === 'WEEK'
                ? 'WEEK'
                : leaderboardTime === 'DAY'
                    ? 'DAY'
                    : 'MONTH';

    return {
        USER_ADDRESSES: userAddresses,
        PROXY_WALLET: getCfg(m, 'PROXY_WALLET') ?? '',
        PRIVATE_KEY: getCfg(m, 'PRIVATE_KEY') ?? '',
        CLOB_HTTP_URL: getCfg(m, 'CLOB_HTTP_URL') ?? '',
        CLOB_WS_URL: getCfg(m, 'CLOB_WS_URL') ?? '',
        FETCH_INTERVAL: parseIntSafe(getCfg(m, 'FETCH_INTERVAL'), 1),
        TOO_OLD_TIMESTAMP: parseIntSafe(getCfg(m, 'TOO_OLD_TIMESTAMP'), 24),
        RETRY_LIMIT: parseIntSafe(getCfg(m, 'RETRY_LIMIT'), 3),
        TRADE_MULTIPLIER: parseNumber(getCfg(m, 'TRADE_MULTIPLIER'), 1.0),
        MAX_ORDER_SIZE_USD: parseNumber(getCfg(m, 'MAX_ORDER_SIZE_USD'), 100.0),
        MIN_ORDER_SIZE_USD: parseNumber(getCfg(m, 'MIN_ORDER_SIZE_USD'), 1.0),
        MAX_POSITION_SIZE_USD: parseNumber(getCfg(m, 'MAX_POSITION_SIZE_USD'), 0),
        MAX_DAILY_VOLUME_USD: parseNumber(getCfg(m, 'MAX_DAILY_VOLUME_USD'), 0),
        COPY_PERCENTAGE: parseNumber(getCfg(m, 'COPY_PERCENTAGE'), 10.0),
        COPY_SIZE: parseNumber(getCfg(m, 'COPY_SIZE'), 10.0),
        COPY_STRATEGY_CONFIG: parseCopyStrategyConfig(m),
        REQUEST_TIMEOUT_MS: parseIntSafe(getCfg(m, 'REQUEST_TIMEOUT_MS'), 10_000),
        NETWORK_RETRY_LIMIT: parseIntSafe(getCfg(m, 'NETWORK_RETRY_LIMIT'), 3),
        TRADE_AGGREGATION_ENABLED: parseBool(getCfg(m, 'TRADE_AGGREGATION_ENABLED'), false),
        TRADE_AGGREGATION_WINDOW_SECONDS: parseIntSafe(getCfg(m, 'TRADE_AGGREGATION_WINDOW_SECONDS'), 300),
        MAX_SLIPPAGE_PERCENT: maxSlippagePercent,
        OWN_CUSTOM_AMOUNT_USD: ownCustomAmountUSD,
        ADAPTIVE_MIN_PERCENT: adaptiveMin,
        ADAPTIVE_MAX_PERCENT: adaptiveMax,
        ADAPTIVE_THRESHOLD_USD: adaptiveThreshold,
        TIERED_MULTIPLIERS: tiered,
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        RPC_URL: getCfg(m, 'RPC_URL') ?? '',
        USDC_CONTRACT_ADDRESS: getCfg(m, 'USDC_CONTRACT_ADDRESS') ?? '',
        USE_AUTO_TRADE_ADDRESS_FROM_API: parseBool(getCfg(m, 'USE_AUTO_TRADE_ADDRESS_FROM_API'), false),
        MAX_LIST_TRADE_ADDRESS_FROM_API: parseIntSafe(getCfg(m, 'MAX_LIST_TRADE_ADDRESS_FROM_API'), 10),
        INTERVAL_REFETCHING_ADDRESS_LIST: parseIntSafe(getCfg(m, 'INTERVAL_REFETCHING_ADDRESS_LIST'), 4 * 3_600_000),
        LEADERBOARD_TIME_PERIOD: leaderboardPeriod,
        LEADERBOARD_MIN_PROFIT_USD: parseNumber(getCfg(m, 'LEADERBOARD_MIN_PROFIT_USD'), 500.0),
        LEADERBOARD_MIN_VOLUME_USD: parseNumber(getCfg(m, 'LEADERBOARD_MIN_VOLUME_USD'), 1000.0),
        LEADERBOARD_MIN_WIN_RATE: parseNumber(getCfg(m, 'LEADERBOARD_MIN_WIN_RATE'), 0.5),
        LEADERBOARD_SCORE_WEIGHT_PROFIT: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_PROFIT'), 0.5),
        LEADERBOARD_SCORE_WEIGHT_VOLUME: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_VOLUME'), 0.3),
        LEADERBOARD_SCORE_WEIGHT_ACTIVITY: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_ACTIVITY'), 0.2),
        LEADERBOARD_SCORE_WEIGHT_WINRATE: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_WINRATE'), 0.0),
        LEADERBOARD_SCORER: {
            weightProfit: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_PROFIT'), 0.5),
            weightVolume: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_VOLUME'), 0.3),
            weightActivity: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_ACTIVITY'), 0.2),
            weightWinRate: parseNumber(getCfg(m, 'LEADERBOARD_SCORE_WEIGHT_WINRATE'), 0.0),
        },
        LEADERBOARD_FILTER: {
            minProfitUSD: parseNumber(getCfg(m, 'LEADERBOARD_MIN_PROFIT_USD'), 0),
            minVolumeUSD: parseNumber(getCfg(m, 'LEADERBOARD_MIN_VOLUME_USD'), 0),
            minWinRate: parseNumber(getCfg(m, 'LEADERBOARD_MIN_WIN_RATE'), 0),
        } as SetupConfig['LEADERBOARD_FILTER'],
        TELEGRAM_NOTIFICATIONS_ENABLED: parseBool(getCfg(m, 'TELEGRAM_NOTIFICATIONS_ENABLED'), false),
        TELEGRAM_CONTROL_ENABLED: parseBool(getCfg(m, 'TELEGRAM_CONTROL_ENABLED'), false),
        TELEGRAM_PM2_CONTROL_ENABLED: parseBool(getCfg(m, 'TELEGRAM_PM2_CONTROL_ENABLED'), false),
        TELEGRAM_ADMIN_CHAT_IDS: parseStringList(getCfg(m, 'TELEGRAM_ADMIN_CHAT_IDS')),
        TELEGRAM_PM2_PIN: getCfg(m, 'TELEGRAM_PM2_PIN') ?? '',
        TELEGRAM_BOT_TOKEN: getCfg(m, 'TELEGRAM_BOT_TOKEN') ?? '',
        TELEGRAM_CHAT_ID: getCfg(m, 'TELEGRAM_CHAT_ID') ?? '',
        TELEGRAM_DAILY_REPORT_HOUR: parseIntSafe(getCfg(m, 'TELEGRAM_DAILY_REPORT_HOUR'), 8),
        TELEGRAM_CHAT_ID_CONTROL: getCfg(m, 'TELEGRAM_CHAT_ID_CONTROL') ?? '',
        TRADING_ENABLED: parseBool(getCfg(m, 'TRADING_ENABLED'), true),
        PM2_PROCESS_NAME: getCfg(m, 'PM2_PROCESS_NAME') ?? 'copy-bot-poly',
    };
};
