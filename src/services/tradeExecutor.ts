import type { ClobClient } from '@polymarket/clob-client';
import type { UserActivities, UserPositions } from '../types/prisma/client';
import { prisma } from "../lib/prisma";
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import { isTradingEnabled } from './runtimeState';

const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const TRADE_AGGREGATION_ENABLED = ENV.TRADE_AGGREGATION_ENABLED;
const TRADE_AGGREGATION_WINDOW_SECONDS = ENV.TRADE_AGGREGATION_WINDOW_SECONDS;
const AGGREGATION_MIN_USD = 1.0; // Polymarket order minimum


/**
 * Returns all unprocessed trades across all currently-tracked addresses.
 * Uses the live address list from getAddresses() so auto-discovery updates
 * are respected on every poll cycle.
 */
const readPendingTrades = async (addresses: string[]): Promise<TradeWithUser[]> => {
    const all: TradeWithUser[] = [];

    for (const address of addresses) {
        const trades = await prisma.userActivities.findMany({
            where: {
                proxyWallet: address,
                type: 'TRADE',
                bot: false,
                botExcutedTime: 0,
            },
            orderBy: { created_at: "desc" },
        });


        for (const t of trades) {
            all.push({ ...(t as UserActivities), userAddress: address });
        }
    }

    return all;
};

// ─── Trade aggregation ────────────────────────────────────────────────────────

const aggregationBuffer = new Map<string, AggregatedTrade>();

const aggregationKey = (t: TradeWithUser): string =>
    `${t.userAddress}:${t.conditionId}:${t.asset}:${t.side}`;

const addToBuffer = (trade: TradeWithUser): void => {
    const key = aggregationKey(trade);
    const existing = aggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        existing.trades.push(trade);
        existing.totalUsdcSize += trade?.usdcSize ?? 0;
        const totalValue = existing.trades.reduce((s, t) => s + (t.usdcSize ?? 0) * (t.price ?? 0), 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        aggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId ?? '',
            asset: trade.asset ?? '',
            side: trade.side ?? 'BUY',
            slug: trade.slug ?? '',
            eventSlug: trade.eventSlug ?? '',
            trades: [trade],
            totalUsdcSize: trade.usdcSize ?? 0,
            averagePrice: trade.price ?? 0,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

const drainReadyAggregations = async (): Promise<AggregatedTrade[]> => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of aggregationBuffer.entries()) {
        if (now - agg.firstTradeTime < windowMs) continue;

        if (agg.totalUsdcSize >= AGGREGATION_MIN_USD) {
            ready.push(agg);
        } else {
            Logger.info(
                `Aggregation for ${agg.slug ?? agg.asset}: ` +
                `$${agg.totalUsdcSize.toFixed(2)} from ${agg.trades.length} trade(s) ` +
                `below minimum — skipping`
            );
            for (const t of agg.trades) {
                await prisma.userActivities.update({
                    where: { id: t.id },
                    data: { bot: true },
                });
            }
        }

        aggregationBuffer.delete(key);
    }

    return ready;
};
const buildContext = async (conditionId: string, traderAddress: string): Promise<TradeContext> => {
    const [rawMine, rawUser, my_balance] = await Promise.all([
        fetchData(`https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`),
        fetchData(`https://data-api.polymarket.com/positions?user=${traderAddress}`),
        getMyBalance(PROXY_WALLET),
    ]);

    const my_positions: UserPositions[] = Array.isArray(rawMine) ? rawMine : [];
    const user_positions: UserPositions[] = Array.isArray(rawUser) ? rawUser : [];

    // Attempt on-chain USDC balance for accurate proportional sizing.
    // Falls back to portfolio value if RPC is unreachable.
    let user_balance: number;
    try {
        user_balance = await getMyBalance(traderAddress);
    } catch {
        user_balance = user_positions.reduce((s, p) => s + (p.currentValue ?? 0), 0);
        Logger.warning(
            `Could not fetch on-chain balance for ${traderAddress.slice(0, 8)}… ` +
            `— using portfolio value ($${user_balance.toFixed(2)}) as approximation`
        );
    }

    return {
        my_positions,
        user_positions,
        my_position: my_positions.find((p) => p.conditionId === conditionId),
        user_position: user_positions.find((p) => p.conditionId === conditionId),
        my_balance,
        user_balance,
    };
};
const doTrading = async (clobClient: ClobClient, trades: TradeWithUser[]): Promise<void> => {
    for (const trade of trades) {

        await prisma.userActivities.update({
            where: { id: trade.id },
            data: { botExcutedTime: 1 },
        });

        Logger.trade(trade.userAddress, trade.side ?? 'UNKNOWN', {
            asset: trade.asset,
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
        });

        try {
            const ctx = await buildContext(trade?.conditionId ?? '', trade.userAddress);
            Logger.balance(ctx.my_balance, ctx.user_balance, trade.userAddress);

            await postOrder(
                clobClient,
                trade.side === 'BUY' ? 'buy' : 'sell',
                ctx.my_position,
                ctx.user_position,
                trade,
                ctx.my_balance,
                ctx.user_balance,
                trade.userAddress
            );
        } catch (err) {
            // Isolate per-trade errors — do NOT crash the executor loop
            Logger.error(
                `Execution error for trade ${String(trade.id)} ` +
                `(${trade.slug ?? trade.asset}): ${err}`
            );
            await prisma.userActivities.update({
                where: { id: trade.id },
                data: { bot: true, botExcutedTime: RETRY_LIMIT },
            });
        }

        Logger.separator();
    }
};

const doAggregatedTrading = async (
    clobClient: ClobClient,
    aggs: AggregatedTrade[]
): Promise<void> => {
    for (const agg of aggs) {
        Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
        Logger.info(`Market:        ${agg.slug ?? agg.asset}`);
        Logger.info(`Side:          ${agg.side}`);
        Logger.info(`Total volume:  $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

        // Mark all constituent trades in-progress
        for (const t of agg.trades) {
            await prisma.userActivities.update({
                where: { id: t.id },
                data: { botExcutedTime: 1 },
            });
        }

        try {
            const ctx = await buildContext(agg.conditionId, agg.userAddress);
            Logger.balance(ctx.my_balance, ctx.user_balance, agg.userAddress);

            // Synthetic trade: first real trade as template, overridden with aggregated values
            const syntheticTrade: UserActivities = {
                ...agg.trades[0],
                name: agg.trades?.[0]?.name ?? null,
                id: agg.trades?.[0]?.id ?? '',
                title: agg.trades?.[0]?.title ?? null,
                slug: agg.trades?.[0]?.slug ?? null,
                icon: agg.trades?.[0]?.icon ?? null,
                eventSlug: agg.trades?.[0]?.eventSlug ?? null,
                proxyWallet: agg.trades?.[0]?.proxyWallet ?? null,
                conditionId: agg.trades?.[0]?.conditionId ?? null,
                usdcSize: agg.totalUsdcSize,
                price: agg.averagePrice,
                size: agg.trades.reduce((s, t) => s + (t.size ?? 0), 0),
                side: agg.side as 'BUY' | 'SELL',
                type: agg.trades?.[0]?.type ?? null,
                transactionHash: agg.trades?.[0]?.transactionHash ?? null,
                asset: agg.asset,
                outcomeIndex: agg.trades?.[0]?.outcomeIndex ?? null,
                outcome: agg.trades?.[0]?.outcome ?? null,
                pseudonym: agg.trades?.[0]?.pseudonym ?? null,
                bio: agg.trades?.[0]?.bio ?? null,
                profileImage: agg.trades?.[0]?.profileImage ?? null,
                profileImageOptimized: agg.trades?.[0]?.profileImageOptimized ?? null,
                bot: agg.trades?.[0]?.bot ?? false,
                botExcutedTime: agg.trades?.[0]?.botExcutedTime ?? 0,
                myBoughtSize: ctx.my_position?.size ?? 0,
                created_at: agg.trades?.[0]?.created_at ?? new Date(),
                updated_at: agg.trades?.[0]?.updated_at ?? new Date(),
            };

            await postOrder(
                clobClient,
                agg.side === 'BUY' ? 'buy' : 'sell',
                ctx.my_position,
                ctx.user_position,
                syntheticTrade,
                ctx.my_balance,
                ctx.user_balance,
                agg.userAddress
            );
        } catch (err) {
            Logger.error(`Aggregated execution error (${agg.slug ?? agg.asset}): ${err}`);
            for (const t of agg.trades) {
                await prisma.userActivities.update({
                    where: { id: t.id },
                    data: { bot: true, botExcutedTime: RETRY_LIMIT },
                });
            }
        }

        Logger.separator();
    }
};

let isRunning = true;

export const stopTradeExecutor = (): void => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};

/**
 * @param clobClient    Authenticated CLOB client
 * @param getAddresses  Optional callback that returns the live address list.
 *                      When provided (auto-discovery mode), the list is
 *                      re-evaluated on every poll cycle so scanner updates
 *                      are picked up without a restart.
 *                      When omitted, falls back to ENV.USER_ADDRESSES.
 */
const tradeExecutor = async (
    clobClient: ClobClient,
    getAddresses?: () => string[]
): Promise<void> => {
    const resolveAddresses = (): string[] => (getAddresses ? getAddresses() : ENV.USER_ADDRESSES);

    Logger.success(`Trade executor ready`);

    if (TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `Aggregation: ON — ${TRADE_AGGREGATION_WINDOW_SECONDS}s window, ` +
            `$${AGGREGATION_MIN_USD} minimum`
        );
    }

    let lastWaitLog = Date.now();

    while (isRunning) {
        if (!isTradingEnabled()) {
            if (Date.now() - lastWaitLog > 1000) {
                Logger.info('Trading paused — waiting for resume...');
                lastWaitLog = Date.now();
            }
            await new Promise((r) => setTimeout(r, 500));
            continue;
        }

        const addresses = resolveAddresses();

        if (addresses.length === 0) {
            // No traders yet (auto-discovery still scanning) — just wait
            if (Date.now() - lastWaitLog > 5000) {
                Logger.info('Waiting for trader addresses from leaderboard scanner...');
                lastWaitLog = Date.now();
            }
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }

        const trades = await readPendingTrades(addresses);

        if (TRADE_AGGREGATION_ENABLED) {
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(`📥 ${trades.length} new trade(s) detected`);

                for (const trade of trades) {
                    // Aggregate any trade (BUY or SELL) below the minimum threshold
                    if (trade.usdcSize && trade.usdcSize < AGGREGATION_MIN_USD) {
                        Logger.info(
                            `Buffering $${trade.usdcSize.toFixed(2)} ${trade.side} ` +
                            `for ${trade.slug ?? trade.asset}`
                        );
                        addToBuffer(trade);
                    } else {
                        Logger.clearLine();
                        Logger.header('⚡ IMMEDIATE TRADE (above threshold)');
                        await doTrading(clobClient, [trade]);
                    }
                }
                lastWaitLog = Date.now();
            }

            const readyAggs = await drainReadyAggregations();
            if (readyAggs?.length > 0) {
                Logger.clearLine();
                Logger.header(`⚡ ${readyAggs.length} AGGREGATED TRADE(S) READY`);
                await doAggregatedTrading(clobClient, readyAggs);
                lastWaitLog = Date.now();
            }

            if (trades.length === 0 && readyAggs?.length === 0) {
                if (Date.now() - lastWaitLog > 300) {
                    const buffered = aggregationBuffer.size;
                    Logger.waiting(
                        addresses.length,
                        buffered > 0 ? `${buffered} group(s) pending` : undefined
                    );
                    lastWaitLog = Date.now();
                }
            }
        } else {
            // Non-aggregation path
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.header(`⚡ ${trades.length} NEW TRADE(S) TO COPY`);
                await doTrading(clobClient, trades);
                lastWaitLog = Date.now();
            } else if (Date.now() - lastWaitLog > 300) {
                Logger.waiting(addresses.length);
                lastWaitLog = Date.now();
            }
        }

        if (!isRunning) break;
        await new Promise((r) => setTimeout(r, 300));
    }

    Logger.info('Trade executor stopped');
};

export default tradeExecutor;
