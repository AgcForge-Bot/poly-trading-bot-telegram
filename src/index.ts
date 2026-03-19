import { prisma } from "./lib/prisma";
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import leaderboardScanner, {
    stopLeaderboardScanner,
    getActiveAddresses,
} from './services/leaderboardScanner';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import getMyBalance from './utils/getMyBalance';
import {
    notifyBotStarted,
    notifyBotStopped,
    notifyFatalError,
    scheduleHourlyDailyReport,
} from './services/notifications';
import { isTelegramEnabled } from './services/telegramNotifier';
import { initTradingEnabled } from './services/runtimeState';
import { startTelegramControl } from './services/telegramControl';

const PROXY_WALLET = ENV.PROXY_WALLET;
const AUTO_MODE = ENV.USE_AUTO_TRADE_ADDRESS_FROM_API;

let isShuttingDown = false;
let stopDailyReport: (() => void) | null = null;
let stopTelegramControl: (() => void) | null = null;

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const gracefulShutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress — forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    stopDailyReport?.();
    stopTelegramControl?.();

    // Give Telegram 3s to send the shutdown notification before exiting
    await Promise.race([
        notifyBotStopped(signal),
        new Promise(r => setTimeout(r, 3000)),
    ]).catch(() => { });

    try {
        stopLeaderboardScanner();
        stopTradeMonitor();
        stopTradeExecutor();
        await new Promise(r => setTimeout(r, 2000));
        await prisma.$disconnect();
        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// ─── Process-level error handlers ────────────────────────────────────────────

process.on('unhandledRejection', (reason: unknown) => {
    Logger.error(`Unhandled promise rejection: ${reason}`);
    notifyFatalError(reason, 'unhandledRejection').catch(() => { });
});

process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught exception: ${error.message}`);
    notifyFatalError(error, 'uncaughtException')
        .catch(() => { })
        .finally(() =>
            gracefulShutdown('uncaughtException').catch(() => process.exit(1))
        );
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Main ─────────────────────────────────────────────────────────────────────

export const main = async (): Promise<void> => {
    try {
        console.log('\n\x1b[33m💡 First time running the bot?\x1b[0m');
        console.log('   Read the guide: \x1b[36mGETTING_STARTED.md\x1b[0m');
        console.log('   Run health check: \x1b[36mnpm run health-check\x1b[0m\n');

        await prisma.$connect();

        Logger.info(
            isTelegramEnabled()
                ? 'Telegram notifications: ENABLED ✓'
                : 'Telegram notifications: DISABLED (set TELEGRAM_ENABLED=true to activate)'
        );

        Logger.startup(
            AUTO_MODE
                ? ['(auto-discovery mode — scanning leaderboard on startup...)']
                : ENV.USER_ADDRESSES,
            PROXY_WALLET
        );

        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);
        if (!healthResult.healthy) {
            Logger.warning('Health check reported issues — continuing with caution...');
        }

        Logger.info('Initializing CLOB client...');
        const clobClient = await createClobClient();
        Logger.success('CLOB client ready');
        Logger.separator();

        initTradingEnabled(ENV.TRADING_ENABLED);

        if (ENV.TELEGRAM_CONTROL_ENABLED && isTelegramEnabled()) {
            stopTelegramControl = startTelegramControl();
            Logger.info('Telegram control: ENABLED ✓');
        } else {
            Logger.info('Telegram control: DISABLED');
        }

        // ── Auto-discovery ────────────────────────────────────────────────────
        if (AUTO_MODE) {
            Logger.info(
                `Auto-discovery ON — top ${ENV.MAX_LIST_TRADE_ADDRESS_FROM_API} traders, ` +
                `refresh every ${(ENV.INTERVAL_REFETCHING_ADDRESS_LIST / 3_600_000).toFixed(1)}h`
            );
            Logger.info('Running initial leaderboard scan (may take ~30s)...');

            leaderboardScanner().catch((err) => {
                Logger.error(`Leaderboard scanner crashed: ${err}`);
                notifyFatalError(err, 'leaderboardScanner-crash')
                    .catch(() => { })
                    .finally(() =>
                        gracefulShutdown('leaderboardScanner-crash').catch(() => process.exit(1))
                    );
            });

            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                if (getActiveAddresses().length > 0) break;
                await new Promise(r => setTimeout(r, 500));
            }

            const addrs = getActiveAddresses();
            if (addrs.length === 0) {
                Logger.warning('Initial scan timed out — starting with empty list.');
            } else {
                Logger.success(`Scan complete — ${addrs.length} trader(s) selected:`);
                addrs.forEach((a, i) => Logger.info(`  ${i + 1}. ${a}`));
            }

            Logger.separator();
        }

        // ── Services ──────────────────────────────────────────────────────────

        Logger.info('Starting trade monitor...');
        tradeMonitor().catch((err) => {
            Logger.error(`Trade monitor crashed: ${err}`);
            notifyFatalError(err, 'tradeMonitor-crash')
                .catch(() => { })
                .finally(() =>
                    gracefulShutdown('tradeMonitor-crash').catch(() => process.exit(1))
                );
        });

        Logger.info('Starting trade executor...');
        tradeExecutor(clobClient, AUTO_MODE ? getActiveAddresses : undefined).catch((err) => {
            Logger.error(`Trade executor crashed: ${err}`);
            notifyFatalError(err, 'tradeExecutor-crash')
                .catch(() => { })
                .finally(() =>
                    gracefulShutdown('tradeExecutor-crash').catch(() => process.exit(1))
                );
        });

        // ── Daily report ──────────────────────────────────────────────────────
        if (isTelegramEnabled()) {
            stopDailyReport = scheduleHourlyDailyReport(() => getMyBalance(PROXY_WALLET));
            Logger.info(
                `Daily report: ${ENV.TELEGRAM_DAILY_REPORT_HOUR}:00 WIB`
            );
        }

        // ── Startup notification ──────────────────────────────────────────────
        const active = AUTO_MODE ? getActiveAddresses() : ENV.USER_ADDRESSES;
        notifyBotStarted(active, PROXY_WALLET, AUTO_MODE).catch(() => { });

    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await notifyFatalError(error, 'startup').catch(() => { });
        await gracefulShutdown('startup-error');
    }
};

main();
