import { AssetType, type ClobClient, OrderType, Side } from '@polymarket/clob-client';
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';

const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

const MIN_SELL_TOKENS = 1.0;
const ZERO_THRESHOLD = 0.0001;

// ─── Baca daftar trader dari JSON (BUG FIX: bukan ENV.USER_ADDRESSES) ─────────

const TRADERS_FILE = path.join(process.cwd(), 'data', 'active_traders.json');

const loadActiveTraderAddresses = (): string[] => {
    // Prioritas 1: baca dari JSON file yang ditulis leaderboardScanner
    try {
        if (fs.existsSync(TRADERS_FILE)) {
            const raw = fs.readFileSync(TRADERS_FILE, 'utf8');
            const snapshot = JSON.parse(raw) as { addresses: string[]; updatedAt: string };

            if (Array.isArray(snapshot.addresses) && snapshot.addresses.length > 0) {
                console.log(
                    `📄 Loaded ${snapshot.addresses.length} traders from JSON cache ` +
                    `(last updated: ${snapshot.updatedAt})`
                );
                return snapshot.addresses;
            }
        }
    } catch (err) {
        console.warn(`⚠️  Could not read ${TRADERS_FILE}: ${err}`);
    }

    // Prioritas 2: fallback ke ENV.USER_ADDRESSES (static .env)
    if (ENV.USER_ADDRESSES.length > 0) {
        console.warn(
            `⚠️  JSON cache not found — falling back to ENV.USER_ADDRESSES ` +
            `(${ENV.USER_ADDRESSES.length} addresses). ` +
            `Start the main bot once to generate the JSON cache.`
        );
        return ENV.USER_ADDRESSES;
    }

    console.error(
        '❌ No trader addresses available. ' +
        'Either start the main bot to generate data/active_traders.json, ' +
        'or set USER_ADDRESSES in .env as fallback.'
    );
    return [];
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

interface SellResult {
    soldTokens: number;
    proceedsUsd: number;
    remainingTokens: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        const d = response as Record<string, unknown>;
        const direct = d.error;
        if (typeof direct === 'string') return direct;
        if (typeof direct === 'object' && direct !== null) {
            const n = direct as Record<string, unknown>;
            if (typeof n.error === 'string') return n.error;
            if (typeof n.message === 'string') return n.message;
        }
        if (typeof d.errorMsg === 'string') return d.errorMsg;
        if (typeof d.message === 'string') return d.message;
    }
    return undefined;
};

const isFundsError = (msg: string | undefined): boolean => {
    if (!msg) return false;
    const l = msg.toLowerCase();
    return l.includes('not enough balance') || l.includes('allowance');
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string): Promise<void> => {
    try {
        await clobClient.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
    } catch {
        // Non-fatal
    }
};

// ─── Sell logic ───────────────────────────────────────────────────────────────

const sellEntirePosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<SellResult> => {
    let remaining = position.size;
    let attempts = 0;
    let soldTokens = 0;
    let proceeds = 0;

    if (remaining < MIN_SELL_TOKENS) {
        console.log(`   ❌ Position ${remaining.toFixed(4)} < ${MIN_SELL_TOKENS} minimum — skipping`);
        return { soldTokens: 0, proceedsUsd: 0, remainingTokens: remaining };
    }

    await updatePolymarketCache(clobClient, position.asset);

    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);

        if (!orderBook.bids?.length) {
            console.log('   ❌ Order book has no bids — liquidity unavailable');
            break;
        }

        const bestBid = orderBook.bids.reduce((max, bid) =>
            parseFloat(bid.price || '0') > parseFloat(max?.price || '0') ? bid : max,
            orderBook.bids[0]
        );

        const bidSize = parseFloat(bestBid?.size || '0');
        const bidPrice = parseFloat(bestBid?.price || '0');

        if (bidSize < MIN_SELL_TOKENS) {
            console.log(`   ❌ Best bid only for ${bidSize.toFixed(2)} tokens`);
            break;
        }

        const sellAmount = Math.min(remaining, bidSize);
        if (sellAmount < MIN_SELL_TOKENS) {
            console.log(`   ❌ sellAmount ${sellAmount.toFixed(4)} below minimum`);
            break;
        }

        try {
            const signed = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: position.asset,
                amount: sellAmount,
                price: bidPrice,
            });
            const resp = await clobClient.postOrder(signed, OrderType.FOK);

            if (resp.success) {
                const value = sellAmount * bidPrice;
                soldTokens += sellAmount;
                proceeds += value;
                remaining -= sellAmount;
                attempts = 0;
                console.log(`   ✅ Sold ${sellAmount.toFixed(2)} @ $${bidPrice.toFixed(3)} ≈ $${value.toFixed(2)}`);
            } else {
                const errMsg = extractOrderError(resp);
                if (isFundsError(errMsg)) {
                    console.log(`   ❌ Rejected: ${errMsg}`);
                    break;
                }
                attempts++;
                console.log(`   ⚠️  Attempt ${attempts}/${RETRY_LIMIT} failed${errMsg ? ` — ${errMsg}` : ''}`);
            }
        } catch (err) {
            attempts++;
            console.log(`   ⚠️  Attempt ${attempts}/${RETRY_LIMIT} threw: ${err}`);
        }
    }

    return { soldTokens, proceedsUsd: proceeds, remainingTokens: remaining };
};

// ─── Position loading ─────────────────────────────────────────────────────────

const loadPositions = async (address: string): Promise<Position[]> => {
    const data = await fetchData(
        `https://data-api.polymarket.com/positions?user=${address}`
    );
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((p) => (p.size ?? 0) > ZERO_THRESHOLD);
};

/** Bangun set conditionId:asset dari semua trader yang diikuti */
const buildTrackedSet = async (traderAddresses: string[]): Promise<Set<string>> => {
    const tracked = new Set<string>();

    for (const addr of traderAddresses) {
        try {
            const positions = await loadPositions(addr);
            for (const pos of positions) {
                tracked.add(`${pos.conditionId}:${pos.asset}`);
            }
        } catch (err) {
            console.warn(`⚠️  Failed to load positions for ${addr.slice(0, 8)}...: ${err}`);
        }
    }

    return tracked;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
    console.log('🚀 Close stale positions (traders already exited)');
    console.log('═'.repeat(52));
    console.log(`Wallet: ${PROXY_WALLET}`);

    // ── Load trader addresses from JSON (always up-to-date) ──────────────
    const traderAddresses = loadActiveTraderAddresses();

    if (traderAddresses.length === 0) {
        console.log('❌ No trader addresses to compare against. Exiting.');
        return;
    }

    console.log(`Comparing against ${traderAddresses.length} tracked trader(s)`);

    const clobClient = await createClobClient();
    console.log('✅ Connected to Polymarket CLOB');

    const [myPositions, trackedSet] = await Promise.all([
        loadPositions(PROXY_WALLET),
        buildTrackedSet(traderAddresses),
    ]);

    if (myPositions.length === 0) {
        console.log('\n🎉 No open positions. Nothing to do.');
        return;
    }

    // Posisi yang ADA di kamu tapi TIDAK ADA di trader → stale
    const stalePositions = myPositions.filter(
        (pos) => !trackedSet.has(`${pos.conditionId}:${pos.asset}`)
    );

    console.log(`\n📊 Your positions:     ${myPositions.length}`);
    console.log(`   Still held by trader: ${myPositions.length - stalePositions.length}`);
    console.log(`   Stale (will sell):    ${stalePositions.length}`);

    if (stalePositions.length === 0) {
        console.log('\n✅ All your positions still held by tracked traders. Nothing to close.');
        return;
    }

    console.log(`\n🔄 Selling ${stalePositions.length} stale position(s)...`);

    let totalTokens = 0;
    let totalProceeds = 0;

    for (let i = 0; i < stalePositions.length; i++) {
        const pos = stalePositions[i];
        console.log(`\n${i + 1}/${stalePositions.length} ▶ ${pos?.title ?? pos?.slug ?? pos?.asset ?? 'N/A'}`);
        console.log(`   Outcome:  ${pos?.outcome ?? 'N/A'}`);
        console.log(`   Size:     ${pos?.size?.toFixed(2) ?? 'N/A'} tokens @ avg $${pos?.avgPrice?.toFixed(3) ?? 'N/A'}`);
        console.log(`   Cur price: $${pos?.curPrice?.toFixed(4) ?? 'N/A'} | Value: $${pos?.currentValue?.toFixed(2) ?? 'N/A'}`);

        try {
            if (!pos) {
                console.log(`   ❌ Skipping undefined position at index ${i}`);
                continue;
            }
            const result = await sellEntirePosition(clobClient, pos);
            totalTokens += result.soldTokens;
            totalProceeds += result.proceedsUsd;
        } catch (err) {
            console.error(`   ❌ Unexpected error: ${err}`);
        }
    }

    console.log('\n' + '═'.repeat(52));
    console.log('✅ Close-stale summary');
    console.log(`   Markets processed: ${stalePositions.length}`);
    console.log(`   Tokens sold:       ${totalTokens.toFixed(2)}`);
    console.log(`   USDC realized:     $${totalProceeds.toFixed(2)}`);
    console.log('═'.repeat(52));
};

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Script aborted:', err);
        process.exit(1);
    });