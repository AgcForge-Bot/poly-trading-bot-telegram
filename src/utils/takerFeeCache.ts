import { prisma } from '../lib/prisma';
import Logger from './logger';

const KEY = 'TAKER_FEE_CACHE';
const MAX_ENTRIES = 2000;

let loaded = false;
let inMemory = new Map<string, number>();
let flushTimer: NodeJS.Timeout | null = null;

const loadOnce = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;

    try {
        const row = await prisma.config.findFirst({ where: { key: KEY } });
        if (!row?.value) return;
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        const next = new Map<string, number>();
        for (const [k, v] of Object.entries(parsed)) {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) next.set(k, n);
        }
        inMemory = next;
    } catch (e) {
        Logger.warning(`Failed to load ${KEY}: ${e instanceof Error ? e.message : String(e)}`);
    }
};

const flushSoon = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush().catch(() => {});
    }, 2000);
};

const flush = async (): Promise<void> => {
    try {
        const obj: Record<string, number> = {};
        for (const [k, v] of inMemory.entries()) obj[k] = v;
        const value = JSON.stringify(obj);

        const existing = await prisma.config.findFirst({ where: { key: KEY } });
        if (existing) {
            await prisma.config.update({ where: { id: existing.id }, data: { value } });
        } else {
            await prisma.config.create({ data: { key: KEY, value } });
        }
    } catch (e) {
        Logger.warning(`Failed to persist ${KEY}: ${e instanceof Error ? e.message : String(e)}`);
    }
};

export const getCachedTakerFeeBps = async (tokenId: string, fallback: number): Promise<number> => {
    await loadOnce();
    return inMemory.get(tokenId) ?? fallback;
};

export const setCachedTakerFeeBps = async (tokenId: string, feeBps: number): Promise<void> => {
    await loadOnce();
    if (!Number.isFinite(feeBps) || feeBps < 0) return;

    inMemory.set(tokenId, feeBps);
    if (inMemory.size > MAX_ENTRIES) {
        const first = inMemory.keys().next().value as string | undefined;
        if (first) inMemory.delete(first);
    }

    flushSoon();
};

export const getTakerFeeCacheSnapshot = async (): Promise<Array<{ tokenId: string; feeBps: number }>> => {
    await loadOnce();
    return Array.from(inMemory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([tokenId, feeBps]) => ({ tokenId, feeBps }));
};

export const clearTakerFeeCache = async (): Promise<void> => {
    await loadOnce();
    inMemory = new Map<string, number>();
    await flush();
};
