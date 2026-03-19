import * as fs from 'fs';
import * as path from 'path';
import { sendNotification, esc } from './telegramNotifier';
import { ENV } from '../config/env';
import { getDailyReportDbStats } from '../models/userHistory';

const usd = (n: number): string => `$${Math.abs(n).toFixed(2)}`;
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const short = (addr: string): string => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—');
const polyUrl = (eventSlug: string): string =>
    eventSlug ? `https://polymarket.com/event/${eventSlug}` : '';

// ─── Address resolver for daily report (BUG-2 FIX) ───────────────────────────
// ENV.USER_ADDRESSES is empty in auto-discovery mode.
// Priority: JSON cache (written by leaderboardScanner) → ENV.USER_ADDRESSES fallback.

const TRADERS_FILE = path.join(process.cwd(), 'data', 'active_traders.json');

const resolveTrackedAddresses = (): string[] => {
    try {
        if (fs.existsSync(TRADERS_FILE)) {
            const snapshot = JSON.parse(fs.readFileSync(TRADERS_FILE, 'utf8')) as {
                addresses: string[];
            };
            if (Array.isArray(snapshot.addresses) && snapshot.addresses.length > 0) {
                return snapshot.addresses;
            }
        }
    } catch {
        // Fall through to ENV fallback
    }
    return ENV.USER_ADDRESSES;
};

// ─── 1. Bot lifecycle ─────────────────────────────────────────────────────────

/**
 * Sent once when the bot finishes startup and both services are running.
 */
export const notifyBotStarted = (
    addresses: string[],
    proxyWallet: string,
    autoMode: boolean
): Promise<boolean> => {
    const addrList =
        addresses.length === 0
            ? '<i>Scanning leaderboard…</i>'
            : addresses.map((a, i) => `  ${i + 1}. <code>${a}</code>`).join('\n');

    return sendNotification({
        level: 'success',
        title: 'Bot Started',
        body: [
            `<b>Wallet:</b> <code>${esc(proxyWallet)}</code>`,
            `<b>Mode:</b> ${autoMode ? '🤖 Auto (leaderboard)' : '📋 Manual'}`,
            `<b>Tracking ${addresses.length} trader(s):</b>`,
            addrList,
        ].join('\n'),
        footer: 'Bot is now live and monitoring for trades.',
    });
};

/**
 * Sent on graceful shutdown (SIGTERM, SIGINT, or manual stop).
 */
export const notifyBotStopped = (signal: string): Promise<boolean> =>
    sendNotification({
        level: 'warning',
        title: 'Bot Stopped',
        body: `Received <b>${esc(signal)}</b> — bot shut down gracefully.`,
        footer: 'Restart with: systemctl start polybot  or  pm2 start',
    });

/**
 * Sent on uncaughtException / unhandledRejection — bot is about to exit.
 */
export const notifyFatalError = (
    error: Error | unknown,
    context = 'uncaughtException'
): Promise<boolean> => {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack?.split('\n').slice(0, 6).join('\n') ?? '';

    return sendNotification({
        level: 'error',
        title: 'Fatal Error — Bot Crashed',
        body: [
            `<b>Context:</b> ${esc(context)}`,
            `<b>Message:</b> ${esc(err.message)}`,
            stack ? `\n<b>Stack:</b>\n<pre>${esc(stack)}</pre>` : '',
        ]
            .filter(Boolean)
            .join('\n'),
        footer: '⚡ systemd/pm2 will auto-restart the bot.',
    });
};

// ─── 2. Order execution ───────────────────────────────────────────────────────

/**
 * Sent immediately after every successful BUY or SELL order fill.
 */
export const notifyOrderFilled = (p: OrderFilledParams): Promise<boolean> => {
    const isBuy = p.side === 'BUY';
    const icon = isBuy ? '🟢' : '🔴';
    const url = p.eventSlug ? polyUrl(p.eventSlug) : '';
    const txLine = p.txHash
        ? `\n<b>TX:</b> <a href="https://polygonscan.com/tx/${p.txHash}">View on Polygonscan</a>`
        : '';
    const marketLine = url ? `<a href="${url}">${esc(p.marketTitle)}</a>` : esc(p.marketTitle);

    return sendNotification({
        level: 'success',
        title: `Order Filled — ${p.side}`,
        body: [
            `${icon} <b>${p.side}</b> executed`,
            `<b>Market:</b> ${marketLine}`,
            `<b>Outcome:</b> ${esc(p.outcome)}`,
            `<b>Amount:</b> ${usd(p.amountUSD)}`,
            `<b>Price:</b> ${p.price.toFixed(4)} (${(p.price * 100).toFixed(1)}¢)`,
            `<b>Tokens:</b> ${p.tokensFilled.toFixed(2)}`,
            `<b>Copying:</b> <code>${short(p.traderAddress)}</code>`,
            txLine,
        ]
            .filter(Boolean)
            .join('\n'),
    });
};

// ─── 3. PnL result on SELL ────────────────────────────────────────────────────

/**
 * Sent after a SELL order completes — reports win/loss with P&L.
 */
export const notifyPnLResult = (p: PnLResultParams): Promise<boolean> => {
    const isWin = p.realizedPnlUSD >= 0;
    const pnlSign = isWin ? '📈' : '📉';
    const pnlDisplay = `${isWin ? '+' : '-'}${usd(p.realizedPnlUSD)}`;
    const pnlPct = p.avgBuyPrice > 0 ? ((p.sellPrice - p.avgBuyPrice) / p.avgBuyPrice) * 100 : 0;
    const url = p.eventSlug ? polyUrl(p.eventSlug) : '';
    const marketLine = url ? `<a href="${url}">${esc(p.marketTitle)}</a>` : esc(p.marketTitle);

    return sendNotification({
        level: isWin ? 'success' : 'warning',
        title: isWin ? 'Position Closed — WIN 🏆' : 'Position Closed — LOSS 💀',
        body: [
            `${pnlSign} <b>Realized P&amp;L: ${pnlDisplay} (${pct(pnlPct)})</b>`,
            ``,
            `<b>Market:</b> ${marketLine}`,
            `<b>Outcome:</b> ${esc(p.outcome)}`,
            `<b>Avg buy price:</b> ${p.avgBuyPrice.toFixed(4)}`,
            `<b>Sell price:</b>    ${p.sellPrice.toFixed(4)}`,
            `<b>Tokens sold:</b>   ${p.tokensSold.toFixed(2)}`,
            p.isFullClose ? `<b>Position:</b> Fully closed` : `<b>Position:</b> Partially closed`,
        ].join('\n'),
    });
};

// ─── 4. Order failures ────────────────────────────────────────────────────────

/**
 * Sent when an order exhausts all retries without filling.
 */
export const notifyOrderFailed = (
    side: 'BUY' | 'SELL' | 'MERGE',
    marketTitle: string,
    reason: string,
    retries: number
): Promise<boolean> =>
    sendNotification({
        level: 'warning',
        title: `Order Failed — ${side}`,
        body: [
            `<b>Market:</b> ${esc(marketTitle)}`,
            `<b>Reason:</b> ${esc(reason)}`,
            `<b>Retries exhausted:</b> ${retries}`,
        ].join('\n'),
        footer: 'Trade skipped. Bot continues monitoring.',
    });

/**
 * Sent when Polymarket rejects an order due to insufficient balance or allowance.
 * Critical — requires human action.
 */
export const notifyInsufficientFunds = (
    currentBalance: number,
    requiredAmount: number,
    marketTitle: string
): Promise<boolean> =>
    sendNotification({
        level: 'error',
        title: '⛔ Insufficient Funds — Action Required',
        body: [
            `<b>Market:</b> ${esc(marketTitle)}`,
            `<b>Your balance:</b> ${usd(currentBalance)}`,
            `<b>Required:</b>     ${usd(requiredAmount)}`,
            ``,
            `Top up USDC to your proxy wallet or run:`,
            `<code>npm run check-allowance</code>`,
        ].join('\n'),
        footer: 'Bot will resume trading once funds are added.',
    });

/**
 * Sent when a trade is skipped due to price slippage being too high.
 */
export const notifySlippageSkipped = (
    marketTitle: string,
    outcome: string,
    slippagePct: number,
    maxSlippagePct: number,
    traderPrice: number,
    currentAsk: number
): Promise<boolean> =>
    sendNotification({
        level: 'info',
        title: 'Trade Skipped — High Slippage',
        body: [
            `<b>Market:</b> ${esc(marketTitle)} (${esc(outcome)})`,
            `<b>Trader price:</b> ${traderPrice.toFixed(4)}`,
            `<b>Current ask:</b>  ${currentAsk.toFixed(4)}`,
            `<b>Slippage:</b>     ${slippagePct.toFixed(1)}% (max: ${maxSlippagePct.toFixed(0)}%)`,
        ].join('\n'),
        footer: 'Increase MAX_SLIPPAGE_PERCENT in .env to copy trades with wider spreads.',
    });

// ─── 5. Leaderboard scanner ───────────────────────────────────────────────────

/**
 * Sent when the auto-discovery scanner refreshes the trader address list.
 */
export const notifyAddressListUpdated = (
    added: string[],
    removed: string[],
    current: string[]
): Promise<boolean> => {
    if (added.length === 0 && removed.length === 0) return Promise.resolve(false);

    const addedLines = added.map((a) => `  ➕ <code>${a}</code>`).join('\n');
    const removedLines = removed.map((a) => `  ➖ <code>${a}</code>`).join('\n');

    return sendNotification({
        level: 'info',
        title: '🔄 Trader List Updated',
        body: [
            addedLines ? `<b>Added (${added.length}):</b>\n${addedLines}` : '',
            removedLines ? `<b>Removed (${removed.length}):</b>\n${removedLines}` : '',
            ``,
            `<b>Now tracking ${current.length} trader(s)</b>`,
        ]
            .filter(Boolean)
            .join('\n'),
    });
};

// ─── 6. Daily report ─────────────────────────────────────────────────────────

/**
 * Builds and sends the daily performance report.
 * Called by scheduleHourlyDailyReport() at the configured hour.
 */
export const notifyDailyReport = (s: DailyReportStats): Promise<boolean> => {
    const winRate = s.totalTrades > 0 ? ((s.winTrades / s.totalTrades) * 100).toFixed(1) : '—';
    const pnlSign = s.totalPnlUSD >= 0 ? '📈' : '📉';
    const pnlColor = s.totalPnlUSD >= 0 ? '✅' : '❌';

    return sendNotification({
        level: s.totalPnlUSD >= 0 ? 'success' : 'warning',
        title: `📊 Daily Report — ${s.date}`,
        body: [
            `<b>── P&amp;L Summary ──</b>`,
            `${pnlSign} <b>Net P&amp;L:</b>     ${s.totalPnlUSD >= 0 ? '+' : ''}${usd(s.totalPnlUSD)}`,
            `${pnlColor} <b>Volume:</b>       ${usd(s.totalVolumeUSD)}`,
            `<b>Balance:</b>      ${usd(s.currentBalance)}`,
            ``,
            `<b>── Trade Activity ──</b>`,
            `<b>Total trades:</b>  ${s.totalTrades}`,
            `<b>Wins:</b>          ${s.winTrades}`,
            `<b>Losses:</b>        ${s.lossTrades}`,
            `<b>Win rate:</b>      ${winRate}%`,
            ``,
            `<b>── Portfolio ──</b>`,
            `<b>Open positions:</b> ${s.openPositions}`,
        ].join('\n'),
        footer: `Next report in 24h`,
    });
};

// ─── 7. Daily report scheduler ───────────────────────────────────────────────

/**
 * Starts a background timer that fires notifyDailyReport() once per day
 * at TELEGRAM_DAILY_REPORT_HOUR (default 08:00 WIB / UTC+7).
 *
 * Call this from index.ts after bot startup.
 * Returns a cleanup function that clears the interval.
 */
export const scheduleHourlyDailyReport = (getBalance: () => Promise<number>): (() => void) => {
    const targetHour = ENV.TELEGRAM_DAILY_REPORT_HOUR;
    let lastReportDate = '';

    const check = async (): Promise<void> => {
        const now = new Date();
        const wibHour = (now.getUTCHours() + 7) % 24;
        const today = now.toISOString().slice(0, 10);

        if (wibHour !== targetHour || lastReportDate === today) return;
        lastReportDate = today || '';

        try {
            // BUG-2 FIX: resolveTrackedAddresses() reads from data/active_traders.json
            // (written by leaderboardScanner on every refresh) so the report always
            // covers the CURRENT trader list, not the empty ENV.USER_ADDRESSES from auto-mode.
            const addresses = resolveTrackedAddresses();

            const stats = await getDailyReportDbStats(addresses, today);

            const balance = await getBalance().catch(() => 0);

            await notifyDailyReport({
                date: today,
                totalTrades: stats.totalTrades,
                winTrades: stats.winTrades,
                lossTrades: stats.lossTrades,
                totalPnlUSD: stats.totalPnlUSD,
                totalVolumeUSD: stats.totalVolumeUSD,
                currentBalance: balance,
                openPositions: stats.openPositions,
            });
        } catch (err) {
            console.error('[Notifications] Daily report failed:', err);
        }
    };

    // Check every 60 seconds whether it's report time
    const interval = setInterval(check, 60_000);

    // Run once immediately in case bot started at exactly the right hour
    check().catch(console.error);

    // Return cleanup function
    return () => clearInterval(interval);
};
