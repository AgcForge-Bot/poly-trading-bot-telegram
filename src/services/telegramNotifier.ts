import { ENV } from '../config/env';
import axios from 'axios';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED = ENV.TELEGRAM_NOTIFICATIONS_ENABLED;
const BOT_TOKEN = ENV.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = ENV.TELEGRAM_CHAT_ID ?? '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Minimum gap between sends to stay under Telegram's 1 msg/sec/chat limit */
const MIN_SEND_INTERVAL_MS = 1500;

/** Max characters per Telegram message (4096 for HTML mode) */
const MAX_MSG_LENGTH = 4000; // conservative — leave room for entity overhead

export const esc = (s: unknown): string =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

// ─── Rate-limit queue (BUG-5 FIX) ────────────────────────────────────────────



const queue: TelegramQueueItem[] = [];
let draining = false;

const drainQueue = async (): Promise<void> => {
    if (draining) return;
    draining = true;

    while (queue.length > 0) {
        const item = queue.shift()!;
        const ok = await sendRaw(item.html);
        item.resolve(ok);
        if (queue.length > 0) {
            await sleep(MIN_SEND_INTERVAL_MS);
        }
    }

    draining = false;
};

const enqueue = (html: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
        queue.push({ html, resolve });
        drainQueue().catch(() => resolve(false));
    });

// ─── Raw HTTP send with retry (BUG-2 + BUG-7 FIX) ───────────────────────────

const sendRaw = async (html: string, attempt = 1): Promise<boolean> => {
    if (!ENABLED || !BOT_TOKEN || !CHAT_ID) return false;

    // Truncate if necessary (BUG-2: was relying on URL length)
    const text =
        html.length > MAX_MSG_LENGTH
            ? html.slice(0, MAX_MSG_LENGTH) + '\n\n<i>...message truncated</i>'
            : html;

    try {
        // BUG-2 FIX: POST + JSON body — no URL length limit
        const resp = await axios.post(
            `${API_BASE}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text,
                parse_mode: 'HTML', // BUG-1 FIX: stable HTML, not Markdown
                disable_web_page_preview: true,
            },
            { timeout: 10_000 }
        );

        return resp.data?.ok === true;
    } catch (err) {
        if (!axios.isAxiosError(err)) {
            console.error('[Telegram] Unexpected error:', err);
            return false;
        }

        const status = err.response?.status ?? 0;

        // BUG-7 FIX: retry on 429 (rate limit) and 5xx (server error)
        if ((status === 429 || status >= 500) && attempt < 3) {
            const retryAfterMs =
                status === 429
                    ? (err.response?.data?.parameters?.retry_after ?? 5) * 1000
                    : 2000 * attempt;

            console.warn(
                `[Telegram] HTTP ${status} — retry in ${retryAfterMs}ms (attempt ${attempt}/3)`
            );
            await sleep(retryAfterMs);
            return sendRaw(html, attempt + 1);
        }

        // Log non-retryable errors without crashing the bot
        const detail = err.response?.data?.description ?? err.message;
        console.error(`[Telegram] Send failed (HTTP ${status}): ${detail}`);
        return false;
    }
};

// ─── Message formatter (BUG-6 FIX) ───────────────────────────────────────────

const LEVEL_ICON: Record<NotifLevel, string> = {
    error: '🚨',
    warning: '⚠️',
    info: 'ℹ️',
    success: '✅',
};

const LEVEL_LABEL: Record<NotifLevel, string> = {
    error: 'ERROR',
    warning: 'WARNING',
    info: 'INFO',
    success: 'SUCCESS',
};

export const formatMessage = (payload: TelegramPayload): string => {
    const icon = LEVEL_ICON[payload.level];
    const label = LEVEL_LABEL[payload.level];
    const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });

    let html = `${icon} <b>[${label}] ${esc(payload.title)}</b>\n`;
    html += `<i>${time} WIB</i>\n`;
    html += `\n${payload.body}`;

    if (payload.footer) {
        html += `\n\n<i>${esc(payload.footer)}</i>`;
    }

    return html;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a formatted notification. Returns true if sent successfully.
 * Never throws — all errors are caught and logged to console only.
 * Safe to call from any async context without awaiting.
 */
export const sendNotification = (payload: TelegramPayload): Promise<boolean> => {
    if (!ENABLED) return Promise.resolve(false);
    const html = formatMessage(payload);
    return enqueue(html);
};

/**
 * Send a plain pre-formatted HTML string directly.
 * Use sendNotification() for structured messages.
 */
export const sendRawHtml = (html: string): Promise<boolean> => {
    if (!ENABLED) return Promise.resolve(false);
    return enqueue(html);
};

/**
 * Whether Telegram notifications are configured and active.
 */
export const isTelegramEnabled = (): boolean => ENABLED && Boolean(BOT_TOKEN) && Boolean(CHAT_ID);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
