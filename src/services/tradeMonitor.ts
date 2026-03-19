import { ENV } from '../config/env';
import { prisma } from "../lib/prisma";
import { getUserActivity } from '../models/userHistory';
import { getActiveAddresses } from '../services/leaderboardScanner';
import { UserPositions } from '../types/prisma/client';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { isTradingEnabled } from './runtimeState';

const STATIC_ADDRESSES = ENV.USER_ADDRESSES;
const AUTO_MODE = ENV.USE_AUTO_TRADE_ADDRESS_FROM_API;
const TOO_OLD_HOURS = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

/**
 * Returns the current address list:
 *   • AUTO mode  → live pool from leaderboardScanner (updates every INTERVAL_REFETCHING_ADDRESS_LIST)
 *   • Manual mode → static ENV.USER_ADDRESSES list
 */
const resolveAddresses = (): string[] =>
    AUTO_MODE ? getActiveAddresses() : STATIC_ADDRESSES;

// ─── Timestamp cutoff ─────────────────────────────────────────────────────────

const getCutoffTimestamp = (): number =>
    Math.floor(Date.now() / 1000) - TOO_OLD_HOURS * 3600;

// ─── First-run tracking ───────────────────────────────────────────────────────

/**
 * Track which addresses have already gone through first-run marking.
 * This matters for AUTO mode: when the leaderboard refresh introduces a
 * brand-new address, we need to mark its historical trades before the
 * executor can see them — just like we do on bot startup for manual mode.
 */
const initializedAddresses = new Set<string>();

// ─── init ─────────────────────────────────────────────────────────────────────

const init = async (): Promise<void> => {
    const addresses = resolveAddresses();

    // In AUTO mode the scanner may still be fetching on first call
    if (addresses.length === 0) {
        Logger.info('Waiting for leaderboard scanner to populate address list...');
        return;
    }

    const counts: number[] = [];
    for (const address of addresses) {
        const count = await prisma.userActivities.count({
            where: {
                proxyWallet: address,
            },
        });
        counts.push(count);
    }
    Logger.clearLine();
    Logger.dbConnection(addresses, counts);

    // Show your own portfolio
    try {
        const myPositions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`
        );
        const { default: getMyBalance } = await import('../utils/getMyBalance');
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            let totalValue = 0, initialValue = 0, weightedPnl = 0;
            for (const pos of myPositions) {
                totalValue += pos.currentValue || 0;
                initialValue += pos.initialValue || 0;
                weightedPnl += (pos.currentValue || 0) * (pos.percentPnl || 0);
            }
            const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
            const topPositions = [...myPositions]
                .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET, myPositions.length, topPositions,
                overallPnl, totalValue, initialValue, currentBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
        }
    } catch (err) {
        Logger.error(`Failed to fetch your positions: ${err}`);
    }

    // Show positions for tracked traders
    const positionCounts: number[] = [];
    const positionDetails: unknown[][] = [];
    const profitabilities: number[] = [];

    for (const address of addresses) {
        const positions = await prisma.userPositions.findMany({
            where: {
                proxyWallet: address,
            },
        });
        positionCounts.push(positions.length);

        let totalValue = 0, weightedPnl = 0;
        for (const pos of positions) {
            totalValue += pos.currentValue || 0;
            weightedPnl += (pos.currentValue || 0) * (pos.percentPnl || 0);
        }
        profitabilities.push(totalValue > 0 ? weightedPnl / totalValue : 0);

        positionDetails.push(
            [...positions]
                .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 3)
                .map((p) => p)
        );
    }

    Logger.clearLine();
    Logger.tradersPositions(addresses, positionCounts, positionDetails, profitabilities);
};

// ─── First-run marking for a single address ───────────────────────────────────

/**
 * Fetch the current API snapshot for one address and save all trades as
 * bot:true (already handled). This prevents the executor from picking up
 * historical trades as new copy signals.
 *
 * Called:
 *   • On bot startup for every address in the initial list (markAsProcessed=true)
 *   • When AUTO mode introduces a brand-new address during a leaderboard refresh
 */
const initializeAddress = async (address: string): Promise<void> => {
    if (initializedAddresses.has(address)) return;

    Logger.info(
        `First-run init for ${address.slice(0, 8)}...${address.slice(-4)} ` +
        `— marking historical trades`
    );

    try {
        const activities = await fetchData(
            `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`
        );
        if (!Array.isArray(activities) || activities.length === 0) {
            initializedAddresses.add(address);
            return;
        }

        const cutoff = getCutoffTimestamp();

        for (const activity of activities) {
            if (activity.timestamp < cutoff) continue;
            const exists = await prisma.userActivities.findFirst({
                where: {
                    transactionHash: activity.transactionHash,
                },
            });
            if (exists) continue;

            await prisma.userActivities.create({
                data: {
                    proxyWallet: activity.proxyWallet,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: activity.asset,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: true,   // historical — never executed
                    botExcutedTime: 999,
                    created_at: new Date(activity.timestamp * 1000),
                }
            })
        }

        initializedAddresses.add(address);
        Logger.info(
            `Init complete: ${address.slice(0, 8)}...${address.slice(-4)}`
        );
    } catch (err) {
        Logger.warning(
            `initializeAddress failed for ${address.slice(0, 8)}...: ${err} ` +
            `— will retry next cycle`
        );
        // Do NOT add to initializedAddresses so it retries next cycle
    }
};

// ─── fetchTradeData ───────────────────────────────────────────────────────────

const fetchTradeData = async (): Promise<void> => {
    const addresses = resolveAddresses();
    if (addresses.length === 0) return;

    const cutoff = getCutoffTimestamp();

    for (const address of addresses) {
        // If this address hasn't been initialized yet (e.g., new from leaderboard
        // refresh), run first-run marking before treating trades as new signals
        await initializeAddress(address);

        try {
            // ── Activity / trades ─────────────────────────────────────────────
            const activities = await fetchData(
                `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`
            );

            if (!Array.isArray(activities) || activities.length === 0) continue;

            for (const activity of activities) {
                if (activity.timestamp < cutoff) continue;

                const exists = await prisma.userActivities.findFirst({
                    where: {
                        transactionHash: activity.transactionHash,
                    },
                });
                if (exists) continue;

                // New trade — save as unprocessed so executor picks it up
                await prisma.userActivities.create({
                    data: {
                        proxyWallet: activity.proxyWallet,
                        conditionId: activity.conditionId,
                        type: activity.type,
                        size: activity.size,
                        usdcSize: activity.usdcSize,
                        transactionHash: activity.transactionHash,
                        price: activity.price,
                        asset: activity.asset,
                        side: activity.side,
                        outcomeIndex: activity.outcomeIndex,
                        title: activity.title,
                        slug: activity.slug,
                        icon: activity.icon,
                        eventSlug: activity.eventSlug,
                        outcome: activity.outcome,
                        name: activity.name,
                        pseudonym: activity.pseudonym,
                        bio: activity.bio,
                        profileImage: activity.profileImage,
                        profileImageOptimized: activity.profileImageOptimized,
                        bot: false,
                        botExcutedTime: 0,
                        created_at: new Date(activity.timestamp * 1000),
                    }
                })

                Logger.info(
                    `New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}`
                );
            }

            // ── Positions ─────────────────────────────────────────────────────
            const positions = await fetchData(
                `https://data-api.polymarket.com/positions?user=${address}`
            )

            if (!Array.isArray(positions) || positions.length === 0) continue;

            for (const position of positions) {
                const parsedEndDate = (() => {
                    const raw = position.endDate;
                    if (!raw) return null;
                    if (typeof raw === 'string' && !raw.includes('T')) {
                        const d = new Date(`${raw}T00:00:00.000Z`);
                        return Number.isNaN(d.getTime()) ? null : d;
                    }
                    const d = new Date(raw);
                    return Number.isNaN(d.getTime()) ? null : d;
                })();

                const exist = await prisma.userPositions.findFirst({
                    where: {
                        proxyWallet: position.proxyWallet,
                        assets: position.asset,
                        conditionId: position.conditionId
                    }
                })
                if (!exist) {
                    await prisma.userPositions.create({
                        data: {
                            proxyWallet: position.proxyWallet,
                            assets: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: parsedEndDate,
                            negativeRisk: position.negativeRisk,
                        },
                    }
                    );
                } else {
                    await prisma.userPositions.update({
                        where: {
                            id: exist.id
                        },
                        data: {
                            proxyWallet: position.proxyWallet,
                            assets: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: parsedEndDate,
                            negativeRisk: position.negativeRisk,
                        },
                    }
                    );
                }

            }
        } catch (err) {
            Logger.error(
                `fetchTradeData error for ${address.slice(0, 6)}...${address.slice(-4)}: ${err}`
            );
        }
    }
};

// ─── tradeMonitor (main export) ───────────────────────────────────────────────

let isRunning = true;

export const stopTradeMonitor = (): void => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

const tradeMonitor = async (): Promise<void> => {
    // In AUTO mode, wait until the leaderboard scanner has populated the list
    if (AUTO_MODE) {
        Logger.info('AUTO mode: waiting for initial leaderboard scan to complete...');
        while (resolveAddresses().length === 0 && isRunning) {
            await new Promise((r) => setTimeout(r, 1000));
        }
        if (!isRunning) return;
    }

    await init();

    const modeLabel = AUTO_MODE
        ? `AUTO mode (up to ${ENV.MAX_LIST_TRADE_ADDRESS_FROM_API} traders from leaderboard)`
        : `MANUAL mode (${STATIC_ADDRESSES.length} configured traders)`;

    Logger.success(`Trade monitor started — ${modeLabel}`);
    Logger.success(`Polling every ${FETCH_INTERVAL}s`);
    Logger.separator();

    while (isRunning) {
        if (!isTradingEnabled()) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }

        await fetchTradeData();
        if (!isRunning) break;
        await new Promise((r) => setTimeout(r, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
