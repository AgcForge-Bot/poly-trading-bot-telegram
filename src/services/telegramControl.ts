import axios from 'axios';
import { spawn } from 'node:child_process';
import { ENV } from '../config/env';
import { esc } from './telegramNotifier';
import { findByKey, getSetupConfig, updateByKey } from '../models/setupConfig';
import { isTradingEnabled, setTradingEnabled } from './runtimeState';
import getMyBalance from '../utils/getMyBalance';
import { performHealthCheck } from '../utils/healthCheck';
import { getActiveAddresses, loadPersistedTraders } from './leaderboardScanner';

type TelegramUpdate = {
    update_id: number;
    message?: {
        message_id: number;
        chat: { id: number };
        text?: string;
    };
    callback_query?: {
        id: string;
        from: { id: number };
        message?: { message_id: number; chat: { id: number } };
        data?: string;
    };
};

const BOT_TOKEN = ENV.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID_CONTROL = ENV.TELEGRAM_CHAT_ID_CONTROL ?? '';
const ENABLED = ENV.TELEGRAM_CONTROL_ENABLED === true;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const authorizedPm2Chats = new Map<number, number>();
const PM2_AUTH_TTL_MS = 30 * 60_000;

let maintenanceRunning = false;

type PendingInput =
    | { type: 'user_addresses'; startedAtMs: number }
    | { type: 'none'; startedAtMs: number };

const pendingByChat = new Map<number, PendingInput>();
const INPUT_TTL_MS = 10 * 60_000;

const allowedChatIds = (() => {
    const ids: number[] = [];
    const primary = Number(TELEGRAM_CHAT_ID_CONTROL);
    if (Number.isFinite(primary)) ids.push(primary);

    for (const raw of ENV.TELEGRAM_ADMIN_CHAT_IDS ?? []) {
        const n = Number(raw);
        if (Number.isFinite(n)) ids.push(n);
    }

    return Array.from(new Set(ids));
})();

const isAllowedChat = (chatId: number): boolean => allowedChatIds.includes(chatId);

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const parseUserAddressesInput = (raw: string): string[] => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];

    const normalizeList = (items: unknown[]): string[] => {
        const addresses = items
            .map((v) => String(v).trim().toLowerCase())
            .filter((v) => v.length > 0);

        const unique: string[] = [];
        const seen = new Set<string>();
        for (const a of addresses) {
            if (!ADDR_RE.test(a)) {
                throw new Error(`Invalid address: ${a}`);
            }
            if (!seen.has(a)) {
                unique.push(a);
                seen.add(a);
            }
        }
        return unique;
    };

    if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error('JSON must be an array');
        return normalizeList(parsed);
    }

    const parts = trimmed
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean);

    return normalizeList(parts);
};

const getPending = (chatId: number): PendingInput | null => {
    const p = pendingByChat.get(chatId);
    if (!p) return null;
    if (Date.now() - p.startedAtMs > INPUT_TTL_MS) {
        pendingByChat.delete(chatId);
        return null;
    }
    return p;
};

const normalizeChatId = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
};

const getAdminChatIds = (cfg: SetupConfig): number[] => {
    const ids = (cfg.TELEGRAM_ADMIN_CHAT_IDS ?? [])
        .map((s) => normalizeChatId(s))
        .filter((v): v is number => v !== null);
    if (ids.length > 0) return ids;
    const fallback = normalizeChatId(cfg.TELEGRAM_CHAT_ID_CONTROL);
    return fallback === null ? [] : [fallback];
};

const isPm2Authorized = (chatId: number, cfg: SetupConfig): boolean => {
    const admins = getAdminChatIds(cfg);
    if (!admins.includes(chatId)) return false;
    const pin = (cfg.TELEGRAM_PM2_PIN ?? '').trim();
    if (!pin) return true;
    const until = authorizedPm2Chats.get(chatId) ?? 0;
    return until > Date.now();
};

const setPm2Authorized = (chatId: number): void => {
    authorizedPm2Chats.set(chatId, Date.now() + PM2_AUTH_TTL_MS);
};

const send = async (chatId: number, html: string, replyMarkup?: unknown): Promise<void> => {
    await axios.post(
        `${API_BASE}/sendMessage`,
        {
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: replyMarkup,
        },
        { timeout: 20_000 }
    );
};

const edit = async (chatId: number, messageId: number, html: string, replyMarkup?: unknown): Promise<void> => {
    await axios.post(
        `${API_BASE}/editMessageText`,
        {
            chat_id: chatId,
            message_id: messageId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: replyMarkup,
        },
        { timeout: 20_000 }
    );
};

const answerCallback = async (id: string, text?: string): Promise<void> => {
    await axios.post(
        `${API_BASE}/answerCallbackQuery`,
        { callback_query_id: id, text },
        { timeout: 20_000 }
    );
};

const mainMenuMarkup = (opts?: { showRestart?: boolean }): unknown => ({
    inline_keyboard: [
        [
            { text: '🩺 Health', callback_data: 'health' },
            { text: '💰 Balance', callback_data: 'balance' },
            { text: isTradingEnabled() ? '⏸ Pause' : '▶️ Resume', callback_data: isTradingEnabled() ? 'pause' : 'resume' },
        ],
        [
            { text: '⚙️ Config', callback_data: 'config' },
            { text: '📌 Status', callback_data: 'status' },
            { text: '📃 Addresses', callback_data: 'addresses' },
        ],
        [
            { text: '🛠 Maintenance', callback_data: 'maint' },
        ],
        ...(opts?.showRestart ? [[{ text: '♻️ Restart (PM2)', callback_data: 'pm2:restart' }]] : []),
    ],
});

const maintenanceMenuMarkup = (): unknown => ({
    inline_keyboard: [
        [
            { text: 'Run Close Stale', callback_data: 'run:close-stale' },
            { text: 'Run Close Resolved', callback_data: 'run:close-resolved' },
        ],
        [
            { text: 'Run Redeem', callback_data: 'run:redeem' },
        ],
        [{ text: '⬅️ Back', callback_data: 'back:main' }],
    ],
});

const configMenuMarkup = (cfg: SetupConfig): unknown => {
    const rows: unknown[] = [
        [
            { text: 'Strategy', callback_data: 'cfg:menu:strategy' },
            { text: 'Slippage', callback_data: 'cfg:menu:slippage' },
        ],
        [
            { text: 'Own Custom $', callback_data: 'cfg:menu:own' },
            {
                text: cfg.USE_AUTO_TRADE_ADDRESS_FROM_API ? 'AUTO: ON' : 'AUTO: OFF',
                callback_data: cfg.USE_AUTO_TRADE_ADDRESS_FROM_API ? 'cfg:auto:0' : 'cfg:auto:1',
            },
        ],
    ];

    if (!cfg.USE_AUTO_TRADE_ADDRESS_FROM_API) {
        rows.push([
            { text: 'USER_ADDRESSES', callback_data: 'cfg:menu:editaddresses' },
            { text: 'LEADERBOARD_PERIOD', callback_data: 'cfg:menu:leaderboardperiod' },
        ]);
    }

    rows.push([{ text: '⬅️ Back', callback_data: 'back:main' }]);

    return { inline_keyboard: rows };
};

const strategyMenuMarkup = (current: string): unknown => ({
    inline_keyboard: [
        [
            { text: current === 'PERCENTAGE' ? '✅ PERCENTAGE' : 'PERCENTAGE', callback_data: 'cfg:strategy:PERCENTAGE' },
        ],
        [
            { text: current === 'FIXED' ? '✅ FIXED' : 'FIXED', callback_data: 'cfg:strategy:FIXED' },
            { text: current === 'ADAPTIVE' ? '✅ ADAPTIVE' : 'ADAPTIVE', callback_data: 'cfg:strategy:ADAPTIVE' },
        ],
        [
            { text: current === 'OWN_CUSTOM' ? '✅ OWN_CUSTOM' : 'OWN_CUSTOM', callback_data: 'cfg:strategy:OWN_CUSTOM' },
        ],
        [{ text: '⬅️ Back', callback_data: 'config' }],
    ],
});

const slippageMenuMarkup = (currentPercent: number): unknown => {
    const options = [5, 10, 15, 20, 30];
    return {
        inline_keyboard: [
            options.map((p) => ({
                text: currentPercent === p ? `✅ ${p}%` : `${p}%`,
                callback_data: `cfg:slip:${p}`,
            })),
            [{ text: '⬅️ Back', callback_data: 'config' }],
        ],
    };
};

const ownCustomMenuMarkup = (current: number): unknown => {
    const options = [0.5, 1, 2, 5, 10];
    return {
        inline_keyboard: [
            options.map((v) => ({
                text: current === v ? `✅ $${v}` : `$${v}`,
                callback_data: `cfg:own:${v}`,
            })),
            [{ text: '⬅️ Back', callback_data: 'config' }],
        ],
    };
};

const editAddressesMenuMarkup = (cfg: SetupConfig): unknown => {
    const auto = cfg.USE_AUTO_TRADE_ADDRESS_FROM_API === true;
    const buttons = auto
        ? [[{ text: 'AUTO ON — disable first', callback_data: 'noop' }]]
        : [[
            { text: 'Use Persisted', callback_data: 'cfg:addr:from-active' },
            { text: 'Clear', callback_data: 'cfg:addr:clear' },
        ],
        [
            { text: 'Paste Manual', callback_data: 'cfg:addr:manual' },
        ]];
    return {
        inline_keyboard: [
            ...buttons,
            [{ text: '⬅️ Back', callback_data: 'config' }],
        ],
    };
};

const leaderboardPeriodMenuMarkup = (current?: string): unknown => ({
    inline_keyboard: [
        [
            { text: current === 'ALL' ? '✅ ALL' : 'ALL', callback_data: 'cfg:lperiod:ALL' },
            { text: current === 'MONTH' ? '✅ MONTH' : 'MONTH', callback_data: 'cfg:lperiod:MONTH' },
        ],
        [
            { text: current === 'WEEK' ? '✅ WEEK' : 'WEEK', callback_data: 'cfg:lperiod:WEEK' },
            { text: current === 'DAY' ? '✅ DAY' : 'DAY', callback_data: 'cfg:lperiod:DAY' },
        ],
        [{ text: '⬅️ Back', callback_data: 'config' }],
    ],
});

const statusText = async (): Promise<string> => {
    const cfg = await getSetupConfig();
    const mode = cfg.USE_AUTO_TRADE_ADDRESS_FROM_API ? 'AUTO' : 'MANUAL';
    const tradeState = isTradingEnabled() ? 'RUNNING' : 'PAUSED';
    const copyStrategy = String(cfg.COPY_STRATEGY_CONFIG?.strategy ?? 'PERCENTAGE');
    const ownCustom = cfg.OWN_CUSTOM_AMOUNT_USD;

    return (
        `<b>Bot Status</b>\n` +
        `Mode: <b>${esc(mode)}</b>\n` +
        `Trading: <b>${esc(tradeState)}</b>\n` +
        `Copy strategy: <b>${esc(copyStrategy)}</b>\n` +
        `Own custom amount: <b>$${esc(ownCustom)}</b>\n` +
        `PM2 control: <b>${esc(cfg.TELEGRAM_PM2_CONTROL_ENABLED)}</b>\n` +
        `Trading enabled (db): <b>${esc(cfg.TRADING_ENABLED)}</b>\n`
    );
};

const healthText = async (): Promise<string> => {
    const res = await performHealthCheck();
    const icon = res.healthy ? '✅' : '❌';
    const db = res.checks.database.status === 'ok' ? '✅' : '❌';
    const rpc = res.checks.rpc.status === 'ok' ? '✅' : '❌';
    const bal =
        res.checks.balance.status === 'ok'
            ? '✅'
            : res.checks.balance.status === 'warning'
                ? '⚠️'
                : '❌';
    const api = res.checks.polymarketApi.status === 'ok' ? '✅' : '❌';

    return (
        `<b>Health</b> ${icon}\n` +
        `Database: ${db} ${esc(res.checks.database.message)}\n` +
        `RPC: ${rpc} ${esc(res.checks.rpc.message)}\n` +
        `Balance: ${bal} ${esc(res.checks.balance.message)}\n` +
        `Polymarket API: ${api} ${esc(res.checks.polymarketApi.message)}\n`
    );
};

const balanceText = async (): Promise<string> => {
    const wallet = ENV.PROXY_WALLET;
    const bal = await getMyBalance(wallet).catch(() => 0);
    return `<b>Balance</b>\nProxy wallet: <code>${esc(wallet)}</code>\nUSDC: <b>$${esc(bal.toFixed(2))}</b>`;
};

const addressesText = async (): Promise<string> => {
    const cfg = await getSetupConfig();
    const manual = cfg.USER_ADDRESSES;

    const active = cfg.USE_AUTO_TRADE_ADDRESS_FROM_API
        ? (() => {
            const live = getActiveAddresses();
            return live.length > 0 ? live : [];
        })()
        : manual;

    const fallback = cfg.USE_AUTO_TRADE_ADDRESS_FROM_API && active.length === 0
        ? await loadPersistedTraders().catch(() => [])
        : [];

    const list = (active.length > 0 ? active : fallback).slice(0, 20);
    const header = cfg.USE_AUTO_TRADE_ADDRESS_FROM_API
        ? `Mode: <b>AUTO</b>\nActive: <b>${esc(String(active.length || fallback.length))}</b>`
        : `Mode: <b>MANUAL</b>\nConfigured: <b>${esc(String(manual.length))}</b>`;

    const lines = list.map((a, i) => `${i + 1}. <code>${esc(a)}</code>`).join('\n');
    const extra = (active.length > 20 || fallback.length > 20 || manual.length > 20) ? `\n\n<i>Menampilkan 20 pertama.</i>` : '';
    return `<b>Addresses</b>\n${header}\n\n${lines || '<i>(empty)</i>'}${extra}`;
};

const restartViaPm2 = async (chatId: number): Promise<void> => {
    const cfg = await getSetupConfig();
    if (!cfg.TELEGRAM_PM2_CONTROL_ENABLED) {
        await send(chatId, 'PM2 control belum diaktifkan. Set <code>TELEGRAM_PM2_CONTROL_ENABLED=true</code>');
        return;
    }

    if (!isPm2Authorized(chatId, cfg)) {
        const pinHint = (cfg.TELEGRAM_PM2_PIN ?? '').trim() ? 'Gunakan <code>/auth PIN</code> dulu.' : 'Pastikan chat ID ada di whitelist.';
        await send(chatId, `❌ Tidak punya akses restart. ${pinHint}`);
        return;
    }

    const procName = cfg.PM2_PROCESS_NAME || 'copy-bot-poly';

    await send(chatId, `♻️ Restarting PM2 process: <code>${esc(procName)}</code> ...`);

    await new Promise<void>((resolve) => {
        const child = spawn('pm2', ['restart', procName], { stdio: 'pipe' });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (err += String(d)));
        child.on('close', async (code) => {
            const successByOutput = out.includes('Applying action restartProcessId') || out.includes('Applying action restart');
            if (code === 0 || (code === null && successByOutput && err.trim().length === 0)) {
                await send(chatId, `✅ PM2 restarted <code>${esc(procName)}</code>\n<pre>${esc(out).slice(0, 1500)}</pre>`);
            } else {
                await send(chatId, `❌ PM2 restart failed (code ${esc(String(code))})\n<pre>${esc((err || out)).slice(0, 1500)}</pre>`);
            }
            resolve();
        });
        child.on('error', async (e) => {
            await send(chatId, `❌ PM2 restart error: <code>${esc(e.message)}</code>`);
            resolve();
        });
    });
};

const runMaintenanceScript = async (
    chatId: number,
    which: 'close-stale' | 'close-resolved' | 'redeem'
): Promise<void> => {
    const cfg = await getSetupConfig();
    if (!cfg.TELEGRAM_PM2_CONTROL_ENABLED || !isPm2Authorized(chatId, cfg)) {
        const pinHint = (cfg.TELEGRAM_PM2_PIN ?? '').trim() ? 'Gunakan <code>/auth PIN</code> dulu.' : 'Pastikan chat ID ada di whitelist admin.';
        await send(chatId, `❌ Tidak punya akses maintenance. ${pinHint}`);
        return;
    }

    if (maintenanceRunning) {
        await send(chatId, '⏳ Maintenance sedang berjalan. Coba lagi sebentar.');
        return;
    }

    maintenanceRunning = true;
    const file =
        which === 'close-stale'
            ? 'dist/scripts/closeStalePositions.js'
            : which === 'close-resolved'
                ? 'dist/scripts/closeResolvedPositions.js'
                : 'dist/scripts/redeemResolvedPositions.js';

    await send(chatId, `🛠 Running <b>${esc(which)}</b>...`);

    await new Promise<void>((resolve) => {
        const child = spawn('node', [file], { stdio: 'pipe' });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (err += String(d)));
        child.on('close', async (code) => {
            const combined = (err ? `${err}\n${out}` : out).trim();
            const snippet = esc(combined).slice(0, 3500);
            if (code === 0) {
                await send(chatId, `✅ Done <b>${esc(which)}</b>\n<pre>${snippet}</pre>`);
            } else {
                await send(chatId, `❌ Failed <b>${esc(which)}</b> (code ${esc(String(code))})\n<pre>${snippet}</pre>`);
            }
            resolve();
        });
        child.on('error', async (e) => {
            await send(chatId, `❌ Error running script: <code>${esc(e.message)}</code>`);
            resolve();
        });
    });

    maintenanceRunning = false;
};

const configText = async (): Promise<string> => {
    const cfg = await getSetupConfig();
    const strategy = String(cfg.COPY_STRATEGY_CONFIG?.strategy ?? 'PERCENTAGE');

    return (
        `<b>Config</b>\n` +
        `COPY_STRATEGY: <b>${esc(strategy)}</b>\n` +
        `OWN_CUSTOM_AMOUNT_USD: <b>${esc(cfg.OWN_CUSTOM_AMOUNT_USD)}</b>\n` +
        `FETCH_INTERVAL: <b>${esc(cfg.FETCH_INTERVAL)}</b>s\n` +
        `RETRY_LIMIT: <b>${esc(cfg.RETRY_LIMIT)}</b>\n` +
        `MAX_SLIPPAGE_PERCENT: <b>${esc(cfg.MAX_SLIPPAGE_PERCENT)}</b>\n` +
        `AUTO_MODE: <b>${esc(cfg.USE_AUTO_TRADE_ADDRESS_FROM_API)}</b>\n` +
        `MAX_LIST_TRADE_ADDRESS_FROM_API: <b>${esc(cfg.MAX_LIST_TRADE_ADDRESS_FROM_API)}</b>\n` +
        `INTERVAL_REFETCHING_ADDRESS_LIST: <b>${esc(cfg.INTERVAL_REFETCHING_ADDRESS_LIST)}</b>ms\n` +
        `\n<i>Update via:</i>\n` +
        `<code>/set KEY VALUE</code>\n` +
        `<i>Contoh:</i> <code>/set COPY_STRATEGY OWN_CUSTOM</code>\n` +
        `<i>Contoh:</i> <code>/set OWN_CUSTOM_AMOUNT_USD 1.0</code>\n` +
        `<i>Contoh:</i> <code>/set USER_ADDRESSES ["0x123...", "0x456..."]</code>\n` +
        `<i>Contoh:</i> <code>/set PROXY_WALLET 0x789...</code>\n` +
        `<i>Contoh:</i> <code>/set PRIVATE_KEY "0x12345...."</code>\n` +
        `<i>Contoh:</i> <code>/set MAX_ORDER_SIZE_USD 3.0</code>\n` +
        `<i>Contoh:</i> <code>/set MIN_ORDER_SIZE_USD 1.0</code>`
    );
};

const setConfig = async (chatId: number, key: string, value: string): Promise<void> => {
    const normalizedKey = key.trim().toUpperCase();
    await updateByKey(normalizedKey, value.trim());
    await send(chatId, `✅ Updated <b>${esc(normalizedKey)}</b> = <code>${esc(value)}</code>\n\n<i>Note:</i> sebagian setting butuh restart bot untuk apply.`);
};

const pauseTrading = async (chatId: number): Promise<void> => {
    setTradingEnabled(false);
    await updateByKey('TRADING_ENABLED', 'false');
    await send(chatId, '⏸ Trading paused.');
};

const resumeTrading = async (chatId: number): Promise<void> => {
    setTradingEnabled(true);
    await updateByKey('TRADING_ENABLED', 'true');
    await send(chatId, '▶️ Trading resumed.');
};

const handleCommand = async (chatId: number, text: string): Promise<void> => {
    const trimmed = text.trim();

    const pending = getPending(chatId);
    if (pending?.type === 'user_addresses') {
        if (trimmed === '/cancel') {
            pendingByChat.delete(chatId);
            await send(chatId, '✅ Dibatalkan.');
            return;
        }

        if (trimmed.startsWith('/')) {
            pendingByChat.delete(chatId);
        } else {
            const cfg = await getSetupConfig();
            if (cfg.USE_AUTO_TRADE_ADDRESS_FROM_API) {
                pendingByChat.delete(chatId);
                await send(chatId, 'AUTO masih ON. Matikan AUTO dulu untuk edit USER_ADDRESSES.');
                return;
            }

            try {
                const list = parseUserAddressesInput(trimmed).slice(0, 50);
                await updateByKey('USER_ADDRESSES', JSON.stringify(list));
                pendingByChat.delete(chatId);
                await send(
                    chatId,
                    `✅ USER_ADDRESSES di-update: <b>${esc(String(list.length))}</b> alamat.`
                );
                return;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                await send(
                    chatId,
                    `❌ Gagal parse USER_ADDRESSES: <code>${esc(msg)}</code>\n\nKirim ulang list address, atau <code>/cancel</code>.`
                );
                return;
            }
        }
    }
    if (trimmed === '/start' || trimmed === '/menu') {
        const cfg = await getSetupConfig();
        await send(
            chatId,
            '<b>Control Panel</b>\nPilih menu:',
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (trimmed === '/health') {
        const cfg = await getSetupConfig();
        await send(
            chatId,
            await healthText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (trimmed === '/status') {
        const cfg = await getSetupConfig();
        await send(
            chatId,
            await statusText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (trimmed === '/config') {
        const cfg = await getSetupConfig();
        await send(chatId, await configText(), configMenuMarkup(cfg));
        return;
    }

    if (trimmed === '/balance') {
        const cfg = await getSetupConfig();
        await send(
            chatId,
            await balanceText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (trimmed === '/addresses') {
        const cfg = await getSetupConfig();
        await send(
            chatId,
            await addressesText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (trimmed === '/restart') {
        await restartViaPm2(chatId);
        return;
    }

    if (trimmed === '/maintenance') {
        await send(chatId, '<b>Maintenance</b>', maintenanceMenuMarkup());
        return;
    }

    if (trimmed.startsWith('/run ')) {
        const arg = trimmed.slice(5).trim().toLowerCase();
        if (arg === 'close-stale') {
            await runMaintenanceScript(chatId, 'close-stale');
            return;
        }
        if (arg === 'close-resolved') {
            await runMaintenanceScript(chatId, 'close-resolved');
            return;
        }
        if (arg === 'redeem') {
            await runMaintenanceScript(chatId, 'redeem');
            return;
        }
        await send(chatId, 'Format: <code>/run close-stale</code> | <code>/run close-resolved</code> | <code>/run redeem</code>');
        return;
    }

    if (trimmed.startsWith('/auth')) {
        const cfg = await getSetupConfig();
        const admins = getAdminChatIds(cfg);
        if (!admins.includes(chatId)) {
            await send(chatId, '❌ Chat ini tidak ada di whitelist admin.');
            return;
        }

        const parts = trimmed.split(' ').filter(Boolean);
        const pin = (cfg.TELEGRAM_PM2_PIN ?? '').trim();
        if (!pin) {
            setPm2Authorized(chatId);
            await send(chatId, '✅ PM2 access enabled (no PIN configured).');
            return;
        }

        const provided = (parts[1] ?? '').trim();
        if (!provided) {
            await send(chatId, 'Format: <code>/auth PIN</code>');
            return;
        }

        if (provided !== pin) {
            await send(chatId, '❌ PIN salah.');
            return;
        }

        setPm2Authorized(chatId);
        await send(chatId, '✅ PM2 access authorized (30 menit).');
        return;
    }

    if (trimmed === '/pause') {
        await pauseTrading(chatId);
        return;
    }

    if (trimmed === '/resume') {
        await resumeTrading(chatId);
        return;
    }

    if (trimmed.startsWith('/set ')) {
        const parts = trimmed.split(' ').filter(Boolean);
        if (parts.length < 3) {
            await send(chatId, 'Format: <code>/set KEY VALUE</code>');
            return;
        }
        const key = parts[1] as string;
        const value = parts.slice(2).join(' ');
        await setConfig(chatId, key, value);
        return;
    }

    if (trimmed === '/cancel') {
        pendingByChat.delete(chatId);
        await send(chatId, '✅ Tidak ada input yang menunggu.');
        return;
    }

    await send(chatId, 'Command tidak dikenal. Pakai <code>/menu</code>');
};

const handleCallback = async (
    chatId: number,
    messageId: number,
    callbackId: string,
    data: string
): Promise<void> => {
    if (data === 'health') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(
            chatId,
            messageId,
            await healthText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (data === 'status') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(
            chatId,
            messageId,
            await statusText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (data === 'config') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, await configText(), configMenuMarkup(cfg));
        return;
    }

    if (data === 'balance') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(
            chatId,
            messageId,
            await balanceText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (data === 'addresses') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(
            chatId,
            messageId,
            await addressesText(),
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (data === 'pause') {
        await answerCallback(callbackId);
        await pauseTrading(chatId);
        return;
    }

    if (data === 'resume') {
        await answerCallback(callbackId);
        await resumeTrading(chatId);
        return;
    }

    if (data === 'back:main') {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        await edit(
            chatId,
            messageId,
            '<b>Control Panel</b>\nPilih menu:',
            mainMenuMarkup({ showRestart: cfg.TELEGRAM_PM2_CONTROL_ENABLED && isPm2Authorized(chatId, cfg) })
        );
        return;
    }

    if (data === 'maint') {
        await answerCallback(callbackId);
        await edit(chatId, messageId, '<b>Maintenance</b>', maintenanceMenuMarkup());
        return;
    }

    if (data === 'run:close-stale') {
        await answerCallback(callbackId);
        await runMaintenanceScript(chatId, 'close-stale');
        return;
    }

    if (data === 'run:close-resolved') {
        await answerCallback(callbackId);
        await runMaintenanceScript(chatId, 'close-resolved');
        return;
    }

    if (data === 'run:redeem') {
        await answerCallback(callbackId);
        await runMaintenanceScript(chatId, 'redeem');
        return;
    }

    if (data === 'pm2:restart') {
        await answerCallback(callbackId);
        await restartViaPm2(chatId);
        return;
    }

    if (data.startsWith('cfg:menu:')) {
        await answerCallback(callbackId);
        const cfg = await getSetupConfig();
        const strategy = String(cfg.COPY_STRATEGY_CONFIG?.strategy ?? 'PERCENTAGE');
        const slipPct = Math.round((cfg.MAX_SLIPPAGE_PERCENT ?? 0.15) * 100);
        const ownAmt = cfg.OWN_CUSTOM_AMOUNT_USD;
        const editAddresses = cfg.USER_ADDRESSES?.join(', ') ?? '';
        const leaderboardPeriod = cfg.LEADERBOARD_TIME_PERIOD ?? 'WEEK';
        const menu = data.split(':')[2];
        if (menu === 'strategy') {
            await edit(chatId, messageId, await configText(), strategyMenuMarkup(strategy));
            return;
        }
        if (menu === 'slippage') {
            await edit(chatId, messageId, await configText(), slippageMenuMarkup(slipPct));
            return;
        }
        if (menu === 'own') {
            await edit(chatId, messageId, await configText(), ownCustomMenuMarkup(ownAmt));
            return;
        }
        if (menu === 'editaddresses') {
            await edit(chatId, messageId, await configText(), editAddressesMenuMarkup(cfg));
            return;
        }
        if (menu === 'leaderboardperiod') {
            await edit(chatId, messageId, await configText(), leaderboardPeriodMenuMarkup(leaderboardPeriod));
            return;
        }
        await edit(chatId, messageId, await configText(), configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:strategy:')) {
        await answerCallback(callbackId);
        const strat = data.split(':')[2] as string;
        await updateByKey('COPY_STRATEGY', strat);
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, `✅ Strategy set to <b>${esc(strat)}</b>\n\n${await configText()}`, configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:slip:')) {
        await answerCallback(callbackId);
        const pct = data.split(':')[2] as string;
        await updateByKey('MAX_SLIPPAGE_PERCENT', pct);
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, `✅ MAX_SLIPPAGE_PERCENT set to <b>${esc(pct)}%</b>\n\n${await configText()}`, configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:own:')) {
        await answerCallback(callbackId);
        const amt = data.split(':')[2] as string;
        await updateByKey('OWN_CUSTOM_AMOUNT_USD', amt);
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, `✅ OWN_CUSTOM_AMOUNT_USD set to <b>$${esc(amt)}</b>\n\n${await configText()}`, configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:auto:')) {
        await answerCallback(callbackId);
        const v = data.split(':')[2] as string;
        await updateByKey('USE_AUTO_TRADE_ADDRESS_FROM_API', v === '1' ? 'true' : 'false');
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, `✅ AUTO_MODE set to <b>${esc(v === '1' ? 'true' : 'false')}</b>\n\n${await configText()}`, configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:addr:')) {
        await answerCallback(callbackId);
        const action = data.split(':')[2] as string;
        const cfg = await getSetupConfig();
        if (cfg.USE_AUTO_TRADE_ADDRESS_FROM_API) {
            await edit(chatId, messageId, `AUTO ON — matikan dulu untuk edit USER_ADDRESSES.`, configMenuMarkup(cfg));
            return;
        }
        if (action === 'from-active') {
            const live = getActiveAddresses();
            const list = (live.length > 0 ? live : await loadPersistedTraders().catch(() => [])).slice(0, 50);
            await updateByKey('USER_ADDRESSES', JSON.stringify(list));
            await edit(chatId, messageId, `✅ USER_ADDRESSES di-set (${list.length} alamat).`, configMenuMarkup(await getSetupConfig()));
            return;
        }
        if (action === 'clear') {
            await updateByKey('USER_ADDRESSES', '[]');
            await edit(chatId, messageId, `✅ USER_ADDRESSES dikosongkan.`, configMenuMarkup(await getSetupConfig()));
            return;
        }
        if (action === 'manual') {
            pendingByChat.set(chatId, { type: 'user_addresses', startedAtMs: Date.now() });
            await send(
                chatId,
                `<b>Paste USER_ADDRESSES</b>\n` +
                `Kirim list address (max 50) dalam salah satu format:\n` +
                `- JSON array: <code>["0x...","0x..."]</code>\n` +
                `- Newline / comma separated\n\n` +
                `Ketik <code>/cancel</code> untuk batal.`
            );
            await edit(chatId, messageId, await configText(), editAddressesMenuMarkup(cfg));
            return;
        }
        await edit(chatId, messageId, await configText(), configMenuMarkup(cfg));
        return;
    }

    if (data.startsWith('cfg:lperiod:')) {
        await answerCallback(callbackId);
        const period = data.split(':')[2] as 'ALL' | 'MONTH' | 'WEEK' | 'DAY';
        await updateByKey('LEADERBOARD_TIME_PERIOD', period);
        const cfg = await getSetupConfig();
        await edit(chatId, messageId, `✅ LEADERBOARD_TIME_PERIOD set to <b>${esc(period)}</b>\n\n${await configText()}`, configMenuMarkup(cfg));
        return;
    }

    if (data === 'noop') {
        await answerCallback(callbackId);
        return;
    }

    await answerCallback(callbackId, 'Unknown action');
};

export const startTelegramControl = (): (() => void) => {
    if (!ENABLED || !BOT_TOKEN || !TELEGRAM_CHAT_ID_CONTROL) {
        return () => { };
    }

    let running = true;
    let offset = 0;

    const loop = async (): Promise<void> => {
        while (running) {
            try {
                const resp = await axios.get(`${API_BASE}/getUpdates`, {
                    timeout: 70_000,
                    params: { offset, timeout: 60, allowed_updates: ['message', 'callback_query'] },
                });

                const updates: TelegramUpdate[] = resp.data?.result ?? [];
                for (const u of updates) {
                    offset = Math.max(offset, (u.update_id ?? 0) + 1);

                    const msg = u.message;
                    if (msg?.text) {
                        if (!isAllowedChat(msg.chat.id)) continue;
                        await handleCommand(msg.chat.id, msg.text);
                    }

                    const cb = u.callback_query;
                    if (cb?.data && cb.message) {
                        if (!isAllowedChat(cb.message.chat.id)) continue;
                        await handleCallback(cb.message.chat.id, cb.message.message_id, cb.id, cb.data);
                    }
                }
            } catch (e) {
                if (axios.isAxiosError(e)) {
                    const desc = (e.response?.data as { description?: string } | undefined)?.description;
                    const msg = desc ?? e.message;
                    if (typeof msg === 'string' && msg.toLowerCase().includes('webhook')) {
                        console.warn(
                            `[TelegramControl] getUpdates blocked by webhook. Run: curl -s "${API_BASE}/deleteWebhook"`
                        );
                    }
                    if (typeof msg === 'string' && msg.toLowerCase().includes('conflict')) {
                        console.warn(
                            `[TelegramControl] getUpdates conflict (another instance running?): ${msg}`
                        );
                    }
                }
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
    };

    loop().catch(() => { });

    const primary = Number(TELEGRAM_CHAT_ID_CONTROL);
    if (Number.isFinite(primary) && isAllowedChat(primary)) {
        send(primary, '✅ Telegram control connected. Ketik <code>/menu</code> untuk mulai.').catch(() => { });
    }

    return () => {
        running = false;
    };
};

export const getTradingEnabledFromDb = async (): Promise<boolean> => {
    const row = await findByKey('TRADING_ENABLED');
    if (!row?.value) return true;
    return row.value === 'true' || row.value === '1' || row.value.toLowerCase() === 'yes';
};
