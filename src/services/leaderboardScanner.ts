import { findByKey, updateByKey } from '../models/setupConfig';
import * as fs from 'fs';
import * as path from 'path';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { ENV } from '../config/env';
import { notifyAddressListUpdated } from '../services/notifications';

const LEADERBOARD_URL = 'https://data-api.polymarket.com/v1/leaderboard';
const ACTIVITY_URL = 'https://data-api.polymarket.com/activity';
const MAX_PAGE_SIZE = 50;           // hard limit from the Polymarket API
const ADDR_RE = /^0x[a-f0-9]{40}$/;

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADERS_FILE = path.join(DATA_DIR, 'active_traders.json');

const ACTIVE_TRADERS_SNAPSHOT_KEY = 'ACTIVE_TRADERS_SNAPSHOT';
const ACTIVE_ADDRESSES_KEY = 'ACTIVE_ADDRESSES';

const persistTraders = async (
    addresses: string[],
    metadata: TradersSnapshot['metadata'],
    timePeriod: string
): Promise<void> => {
    const snapshot: TradersSnapshot = {
        updatedAt: new Date().toISOString(),
        timePeriod,
        count: addresses.length,
        addresses,
        metadata,
    };

    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        const tmp = TRADERS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
        fs.renameSync(tmp, TRADERS_FILE);

        Logger.info(`📄 Trader list persisted → ${TRADERS_FILE}`);
    } catch (err) {
        // Non-fatal — in-memory state is still correct
        Logger.warning(`Failed to persist trader list to JSON: ${err}`);
    }

    try {
        await updateByKey(ACTIVE_TRADERS_SNAPSHOT_KEY, JSON.stringify(snapshot));
        await updateByKey(ACTIVE_ADDRESSES_KEY, JSON.stringify(addresses));
    } catch (err) {
        Logger.warning(`Failed to persist trader list to DB: ${err}`);
    }
};


export const loadPersistedTraders = async (): Promise<string[]> => {
    try {
        const data = await findByKey(ACTIVE_ADDRESSES_KEY);
        if (data?.value) {
            const parsed = JSON.parse(data.value);
            if (Array.isArray(parsed)) {
                return parsed.map((a) => String(a).toLowerCase().trim()).filter((a) => ADDR_RE.test(a));
            }
        }

        if (fs.existsSync(TRADERS_FILE)) {
            const raw = fs.readFileSync(TRADERS_FILE, 'utf8');
            const parsed = JSON.parse(raw) as TradersSnapshot;
            if (Array.isArray(parsed.addresses)) {
                return parsed.addresses.map((a) => a.toLowerCase().trim()).filter((a) => ADDR_RE.test(a));
            }
        }

        return [];
    } catch (err) {
        Logger.warning(`Failed to load persisted trader list: ${err}`);
        return [];
    }
};

let _activeAddresses: string[] = [];
let _isRunning = true;

/** Returns the current best-trader address pool (live reference). */
export const getActiveAddresses = (): string[] => _activeAddresses;

/** Signal the scanner loop to exit cleanly on next iteration. */
export const stopLeaderboardScanner = (): void => {
    _isRunning = false;
    Logger.info('Leaderboard scanner shutdown requested...');
};

const fetchLeaderboardPage = async (
    orderBy: 'PNL' | 'VOL',
    timePeriod: 'ALL' | 'MONTH' | 'WEEK' | 'DAY',
    limit: number,
    offset: number = 0
): Promise<LeaderboardEntry[]> => {
    const url =
        `${LEADERBOARD_URL}?orderBy=${orderBy}` +
        `&timePeriod=${timePeriod}` +
        `&limit=${Math.min(limit, MAX_PAGE_SIZE)}` +
        `&offset=${offset}`;
    try {
        const data = await fetchData(url);
        return Array.isArray(data) ? (data as LeaderboardEntry[]) : [];
    } catch (err) {
        Logger.warning(`fetchLeaderboard (${orderBy}/${timePeriod}) failed: ${err}`);
        return [];
    }
};
/**
 * Fetch trade count for a wallet (up to the last 500 trades).
 * 500 is the per-page maximum the API allows — sufficient to distinguish
 * active traders from occasional ones without exhaustive pagination.
 * Returns 0 on any error so one bad address never aborts the whole scan.
 */
const fetchTradeCount = async (address: string): Promise<number> => {
    try {
        const data = await fetchData(
            `${ACTIVITY_URL}?user=${address}&type=TRADE&limit=500`
        );
        return Array.isArray(data) ? data.length : 0;
    } catch {
        return 0;
    }
};

// ─── Scoring engine ───────────────────────────────────────────────────────────

/**
 * Score and rank the candidate pool using configurable weights from env.
 *
 * Weights are read from:
 *   LEADERBOARD_SCORE_WEIGHT_PROFIT    (default 0.50)
 *   LEADERBOARD_SCORE_WEIGHT_VOLUME    (default 0.30)
 *   LEADERBOARD_SCORE_WEIGHT_ACTIVITY  (default 0.20)
 *   LEADERBOARD_SCORE_WEIGHT_WINRATE   (default 0.00 — disabled by default)
 *
 * Hard filters applied before scoring:
 *   LEADERBOARD_MIN_PROFIT_USD  — exclude traders with pnl below this
 *   LEADERBOARD_MIN_VOLUME_USD  — exclude traders with vol below this
 *   LEADERBOARD_MIN_WIN_RATE    — excluded here only if winrate data is present
 *                                 (win-rate enrichment is not done in this scanner;
 *                                  set weight to 0 to disable that dimension)
 *
 * Each metric is normalised to [0, 1] relative to the pool before weighting
 * so that PnL dollars and trade counts are directly comparable.
 */
const scoreAndRank = (candidates: Map<string, TraderCandidate>): ScoredTrader[] => {
    const { weightProfit, weightVolume, weightActivity } = ENV.LEADERBOARD_SCORER;
    const { minProfitUSD, minVolumeUSD } = ENV.LEADERBOARD_FILTER;

    // Apply hard filters first
    const eligible = Array.from(candidates.values()).filter(
        (t) => t.pnl > 0 && t.pnl >= minProfitUSD && t.vol >= minVolumeUSD
    );

    if (eligible.length === 0) return [];

    const maxPnl = Math.max(...eligible.map((t) => t.pnl));
    const maxVol = Math.max(...eligible.map((t) => t.vol));
    const maxActivity = Math.max(...eligible.map((t) => t.activityCount));

    return eligible
        .map((t): ScoredTrader => ({
            ...t,
            score:
                (maxPnl > 0 ? t.pnl / maxPnl : 0) * weightProfit +
                (maxVol > 0 ? t.vol / maxVol : 0) * weightVolume +
                (maxActivity > 0 ? t.activityCount / maxActivity : 0) * weightActivity,
        }))
        .sort((a, b) => b.score - a.score);
};
/**
 * One complete scan:
 *   1. Fetch top-50 by PnL  (in parallel with top-50 by Vol)
 *   2. Merge into a unique candidate map (take max values on collision)
 *   3. Enrich each candidate with their recent trade count
 *   4. Score → rank → return top maxCount addresses + metadata
 *
 * Activity counts are fetched in batches of 10 with a 200 ms pause between
 * batches to stay well within the Data API rate limit (1 000 req / 10 s).
 */
const runScanCycle = async (
    maxCount: number,
    timePeriod: 'ALL' | 'MONTH' | 'WEEK' | 'DAY'
): Promise<ScanCycleResult> => {
    Logger.info(
        `Leaderboard scan — timePeriod=${timePeriod}, selecting top ${maxCount} traders`
    );
    Logger.info(
        `Scoring weights — profit:${ENV.LEADERBOARD_SCORER.weightProfit} ` +
        `vol:${ENV.LEADERBOARD_SCORER.weightVolume} ` +
        `activity:${ENV.LEADERBOARD_SCORER.weightActivity}`
    );
    if (ENV.LEADERBOARD_FILTER.minProfitUSD > 0 || ENV.LEADERBOARD_FILTER.minVolumeUSD > 0) {
        Logger.info(
            `Filters — minProfit:$${ENV.LEADERBOARD_FILTER.minProfitUSD} ` +
            `minVol:$${ENV.LEADERBOARD_FILTER.minVolumeUSD}`
        );
    }

    // Step 1: fetch both leaderboard sorts simultaneously
    const [pnlList, volList] = await Promise.all([
        fetchLeaderboardPage('PNL', timePeriod, MAX_PAGE_SIZE),
        fetchLeaderboardPage('VOL', timePeriod, MAX_PAGE_SIZE),
    ]);

    // Step 2: build unique candidate map
    const candidates = new Map<string, TraderCandidate>();

    for (const entry of [...pnlList, ...volList]) {
        const addr = entry.proxyWallet?.toLowerCase?.();
        if (!addr || !ADDR_RE.test(addr)) continue;

        const pnl = entry.pnl ?? 0;
        const vol = entry.vol ?? 0;

        const existing = candidates.get(addr);
        if (existing) {
            existing.pnl = Math.max(existing.pnl, pnl);
            existing.vol = Math.max(existing.vol, vol);
        } else {
            candidates.set(addr, { address: addr, userName: entry.userName, pnl, vol, activityCount: 0 });
        }
    }

    Logger.info(`Candidate pool: ${candidates.size} unique addresses`);
    if (candidates.size === 0) return { addresses: [], metadata: [] };

    // Step 3: enrich with trade counts (batched)
    const addrs = Array.from(candidates.keys());
    const BATCH = 10;

    for (let i = 0; i < addrs.length; i += BATCH) {
        const batch = addrs.slice(i, i + BATCH);
        await Promise.all(
            batch.map(async (addr) => {
                const c = candidates.get(addr)!;
                c.activityCount = await fetchTradeCount(addr);
            })
        );
        // Rate-limit friendly pause between batches
        if (i + BATCH < addrs.length) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    // Step 4: score, rank, and select top N
    const ranked = scoreAndRank(candidates);
    const selected = ranked.slice(0, maxCount);

    // Print selection table
    Logger.header(`Top ${selected.length} traders selected for copy trading`);
    selected.forEach((t, i) => {
        const name = (t.userName ?? t.address.slice(0, 10) + '...').padEnd(22);
        const score = `${(t.score * 100).toFixed(1)}%`;
        Logger.info(
            `${String(i + 1).padStart(2)}. ${name} | ` +
            `PnL: $${t.pnl.toFixed(0).padStart(9)} | ` +
            `Vol: $${t.vol.toFixed(0).padStart(11)} | ` +
            `Trades: ${String(t.activityCount).padStart(4)} | ` +
            `Score: ${score}`
        );
    });

    const addresses = selected.map((t) => t.address);
    const metadata = selected.map((t) => ({
        address: t.address,
        userName: t.userName,
        pnl: t.pnl,
        vol: t.vol,
        score: t.score,
    }));

    return { addresses, metadata };
};

// ─── leaderboardScanner — main export ────────────────────────────────────────

const leaderboardScanner = async (): Promise<void> => {
    if (_activeAddresses.length === 0) {
        _activeAddresses = await loadPersistedTraders();
    }

    const maxCount = ENV.MAX_LIST_TRADE_ADDRESS_FROM_API;
    const intervalMs = ENV.INTERVAL_REFETCHING_ADDRESS_LIST;
    const timePeriod = ENV.LEADERBOARD_TIME_PERIOD;

    Logger.success(
        `Leaderboard scanner started — max=${maxCount} traders, ` +
        `period=${timePeriod}, refresh every ${(intervalMs / 3_600_000).toFixed(1)}h`
    );

    while (_isRunning) {
        try {
            const { addresses, metadata } = await runScanCycle(maxCount, timePeriod);

            if (addresses.length > 0) {
                const added = addresses.filter(a => !_activeAddresses.includes(a));
                const removed = _activeAddresses.filter(a => !addresses.includes(a));

                _activeAddresses = addresses;

                // ── Persist to JSON so cron scripts always read the latest list ──
                await persistTraders(addresses, metadata, timePeriod);

                Logger.success(`Active trader pool updated: ${addresses.length} addresses`);

                if (added.length > 0 || removed.length > 0) {
                    notifyAddressListUpdated(added, removed, _activeAddresses).catch(() => { });
                }
            } else {
                Logger.warning(
                    'Scan returned no valid profitable traders — ' +
                    `keeping previous list (${_activeAddresses.length} addresses)`
                );
            }
        } catch (err) {
            Logger.error(`Leaderboard scan cycle error: ${err}`);
        }

        if (!_isRunning) break;

        const nextHours = (intervalMs / 3_600_000).toFixed(1);
        Logger.info(`Next leaderboard refresh in ${nextHours}h`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }

    Logger.info('Leaderboard scanner stopped');
};

export default leaderboardScanner;
