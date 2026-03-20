import { OrderType, Side, type ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import type { UserPositions, UserActivities } from '../types/prisma/client';
import { prisma } from '../lib/prisma';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import {
    notifyOrderFilled,
    notifyOrderFailed,
    notifyInsufficientFunds,
    notifyPnLResult,
    notifySlippageSkipped,
} from '../services/notifications';


const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;
const MAX_SLIPPAGE_PERCENT = ENV.MAX_SLIPPAGE_PERCENT;
const OWN_CUSTOM_AMOUNT_USD = ENV.OWN_CUSTOM_AMOUNT_USD;

const MIN_ORDER_USD_SIZE = 1.0;
const MIN_ORDER_TOKEN_SIZE = 1.0;

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

// ─── postOrder ────────────────────────────────────────────────────────────────

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositions | undefined,
    user_position: UserPositions | undefined,
    trade: UserActivities,
    my_balance: number,
    _user_balance: number,
    userAddress: string
): Promise<void> => {
    const marketTitle = trade.title ?? trade.slug ?? trade.asset ?? '—';
    const outcome = trade.outcome ?? '—';
    const eventSlug = trade.eventSlug ?? trade.slug ?? undefined;
    const txHash = trade.transactionHash ?? undefined;

    // ── MERGE ─────────────────────────────────────────────────────────────────
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');

        if (!my_position) {
            Logger.warning('No position to merge');
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        const tokenId = my_position.assets;
        if (!tokenId) {
            Logger.warning('No tokenID found on position — skipping');
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        let remaining = my_position.size ?? 0;
        if (remaining < MIN_ORDER_TOKEN_SIZE) {
            Logger.warning(`Position size (${remaining.toFixed(2)}) too small — skipping`);
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        let retry = 0,
            abortDueToFunds = false;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(tokenId);
            } catch (err) {
                Logger.warning(`getOrderBook error: ${err}`);
                retry++;
                continue;
            }

            const bids = orderBook.bids ?? [];
            if (bids.length === 0) {
                Logger.warning('No bids available');
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const firstBid = bids[0];
            if (!firstBid) {
                Logger.warning('No bids available');
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const bestBid = bids.reduce(
                (m, b) => (parseFloat(b.price) > parseFloat(m.price) ? b : m),
                firstBid
            );
            const bidPrice = parseFloat(bestBid.price);
            const sellAmt = Math.min(remaining, parseFloat(bestBid.size));

            if (sellAmt < MIN_ORDER_TOKEN_SIZE) {
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const signed = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: tokenId,
                amount: sellAmt,
                price: bidPrice,
            });
            const resp = await clobClient.postOrder(signed, OrderType.FOK);

            if (resp.success) {
                retry = 0;
                remaining -= sellAmt;
                Logger.orderResult(true, `Merged ${sellAmt} tokens @ $${bidPrice}`);
                notifyOrderFilled({
                    side: 'SELL',
                    marketTitle,
                    eventSlug,
                    outcome,
                    amountUSD: sellAmt * bidPrice,
                    price: bidPrice,
                    tokensFilled: sellAmt,
                    traderAddress: userAddress,
                    txHash,
                });
            } else {
                const errMsg = extractOrderError(resp);
                if (isFundsError(errMsg)) {
                    abortDueToFunds = true;
                    notifyInsufficientFunds(my_balance, sellAmt * bidPrice, marketTitle);
                    break;
                }
                retry++;
                Logger.warning(
                    `Merge failed (${retry}/${RETRY_LIMIT})${errMsg ? ` — ${errMsg}` : ''}`
                );
            }
        }

        if (retry >= RETRY_LIMIT)
            notifyOrderFailed('MERGE', marketTitle, 'Retries exhausted', RETRY_LIMIT);
        await prisma.userActivities.update({
            where: { id: trade.id },
            data: { bot: true, botExcutedTime: abortDueToFunds || retry >= RETRY_LIMIT ? retry : 0 },
        });

        // ── BUY ───────────────────────────────────────────────────────────────────
    } else if (condition === 'buy') {
        Logger.info('Executing BUY strategy...');
        Logger.info(
            `Balance: $${my_balance.toFixed(2)} | Trader bought: $${(trade.usdcSize ?? 0).toFixed(2)}`
        );

        const tokenId = trade.asset;
        if (!tokenId) {
            Logger.warning('No tokenID found on trade — skipping');
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        const currentPositionValue = (my_position?.size ?? 0) * (my_position?.avgPrice ?? 0);
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize ?? 0,
            my_balance,
            currentPositionValue
        );

        Logger.info(`📊 ${orderCalc.reasoning}`);

        if (orderCalc.finalAmount < MIN_ORDER_USD_SIZE) {
            Logger.warning(
                `❌ Cannot execute: final amount $${orderCalc.finalAmount.toFixed(2)} < minimum $${MIN_ORDER_USD_SIZE.toFixed(2)}`
            );
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        const isOwnCustom =
            String((COPY_STRATEGY_CONFIG as unknown as { strategy?: unknown })?.strategy) === 'OWN_CUSTOM';

        let remaining = isOwnCustom
                ? Math.min(orderCalc.finalAmount, OWN_CUSTOM_AMOUNT_USD)
                : orderCalc.finalAmount,
            retry = 0;
        let abortDueToFunds = false,
            totalBoughtTokens = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(tokenId);
            } catch (err) {
                Logger.warning(`getOrderBook error: ${err}`);
                retry++;
                continue;
            }

            const asks = orderBook.asks ?? [];
            if (asks.length === 0) {
                Logger.warning('No asks available');
                await prisma.userActivities.update({
                    where: { id: trade.id },
                    data: { bot: true, myBoughtSize: totalBoughtTokens },
                });
                break;
            }

            const firstAsk = asks[0];
            if (!firstAsk) {
                Logger.warning('No asks available');
                await prisma.userActivities.update({
                    where: { id: trade.id },
                    data: { bot: true, myBoughtSize: totalBoughtTokens },
                });
                break;
            }

            const bestAsk = asks.reduce(
                (m, a) => (parseFloat(a.price) < parseFloat(m.price) ? a : m),
                firstAsk
            );
            const askPrice = parseFloat(bestAsk.price);

            Logger.info(`Best ask: ${bestAsk.size} @ $${askPrice}`);

            // ── Slippage check ────────────────────────────────────────────────
            const tradePrice = trade.price ?? 0;
            const slippage = (askPrice - tradePrice) / Math.max(tradePrice, 0.001);
            if (slippage > MAX_SLIPPAGE_PERCENT) {
                Logger.warning(
                    `Slippage ${(slippage * 100).toFixed(1)}% > max ${(MAX_SLIPPAGE_PERCENT * 100).toFixed(0)}% — skipping`
                );
                notifySlippageSkipped(
                    marketTitle,
                    outcome,
                    slippage * 100,
                    MAX_SLIPPAGE_PERCENT * 100,
                    tradePrice,
                    askPrice
                );
                await prisma.userActivities.update({
                    where: { id: trade.id },
                    data: { bot: true, myBoughtSize: totalBoughtTokens },
                });
                break;
            }

            if (remaining < MIN_ORDER_USD_SIZE) {
                await prisma.userActivities.update({
                    where: { id: trade.id },
                    data: { bot: true, myBoughtSize: totalBoughtTokens },
                });
                break;
            }

            const orderUSD = Math.min(remaining, parseFloat(bestAsk.size) * askPrice);
            if (orderUSD < MIN_ORDER_USD_SIZE) {
                Logger.warning(
                    `Order book liquidity too small at best ask — $${orderUSD.toFixed(2)} < $${MIN_ORDER_USD_SIZE.toFixed(2)} minimum`
                );
                await prisma.userActivities.update({
                    where: { id: trade.id },
                    data: { bot: true, myBoughtSize: totalBoughtTokens },
                });
                break;
            }
            Logger.info(`Creating order: $${orderUSD.toFixed(2)} @ $${askPrice}`);

            const signed = await clobClient.createMarketOrder({
                side: Side.BUY,
                tokenID: tokenId,
                amount: orderUSD,
                price: askPrice,
            });
            const resp = await clobClient.postOrder(signed, OrderType.FOK);

            if (resp.success) {
                retry = 0;
                const tokens = orderUSD / askPrice;
                totalBoughtTokens += tokens;
                remaining -= orderUSD;
                Logger.orderResult(
                    true,
                    `Bought $${orderUSD.toFixed(2)} @ $${askPrice} (${tokens.toFixed(2)} tokens)`
                );
                // ── Notification: BUY filled ──
                notifyOrderFilled({
                    side: 'BUY',
                    marketTitle,
                    eventSlug,
                    outcome,
                    amountUSD: orderUSD,
                    price: askPrice,
                    tokensFilled: tokens,
                    traderAddress: userAddress,
                    txHash,
                });
            } else {
                const errMsg = extractOrderError(resp);
                if (isFundsError(errMsg)) {
                    abortDueToFunds = true;
                    // ── Notification: insufficient funds ──
                    notifyInsufficientFunds(my_balance, orderUSD, marketTitle);
                    break;
                }
                retry++;
                Logger.warning(
                    `Order failed (${retry}/${RETRY_LIMIT})${errMsg ? ` — ${errMsg}` : ''}`
                );
                if (retry >= RETRY_LIMIT)
                    notifyOrderFailed('BUY', marketTitle, errMsg ?? 'Unknown', RETRY_LIMIT);
            }
        }

        if (totalBoughtTokens > 0)
            Logger.info(`📝 Tracked: ${totalBoughtTokens.toFixed(2)} tokens`);
        await prisma.userActivities.update({
            where: { id: trade.id },
            data: {
                bot: true,
                botExcutedTime: abortDueToFunds || retry >= RETRY_LIMIT ? retry : 0,
                myBoughtSize: totalBoughtTokens,
            },
        });

        // ── SELL ──────────────────────────────────────────────────────────────────
    } else if (condition === 'sell') {
        Logger.info('Executing SELL strategy...');

        const tokenId = trade.asset;
        if (!tokenId) {
            Logger.warning('No tokenID found on trade — skipping');
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        if (!my_position) {
            Logger.warning('No position to sell');
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        const avgBuyPrice = my_position.avgPrice ?? 0;

        const previousBuys = await prisma.userActivities.findMany({
            where: {
                asset: tokenId,
                conditionId: trade.conditionId ?? undefined,
                side: 'BUY',
                bot: true,
                myBoughtSize: { gt: 0 },
            },
            select: {
                id: true,
                myBoughtSize: true,
            },
        });
        const totalBoughtTokens = previousBuys.reduce((s, b) => s + (b.myBoughtSize ?? 0), 0);

        let remaining: number;

        if (!user_position) {
            remaining = my_position.size ?? 0;
            Logger.info(
                `Trader closed entire position → selling all ${remaining.toFixed(2)} tokens`
            );
        } else {
            const tradeSize = trade.size ?? 0;
            const userPosSize = user_position.size ?? 0;
            const traderSellPct = tradeSize / Math.max(userPosSize + tradeSize, 0.000001);
            const base =
                totalBoughtTokens > 0
                    ? totalBoughtTokens * traderSellPct
                    : (my_position.size ?? 0) * traderSellPct;
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize ?? 0);
            remaining = base * multiplier;
        }

        if (remaining < MIN_ORDER_TOKEN_SIZE) {
            Logger.warning(`Sell amount ${remaining.toFixed(2)} below minimum — skipping`);
            await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
            return;
        }

        remaining = Math.min(remaining, my_position.size ?? remaining);

        let retry = 0,
            abortDueToFunds = false;
        let totalSoldTokens = 0,
            weightedSumSellPrice = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(tokenId);
            } catch (err) {
                Logger.warning(`getOrderBook error: ${err}`);
                retry++;
                continue;
            }

            const bids = orderBook.bids ?? [];
            if (bids.length === 0) {
                Logger.warning('No bids available');
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const firstBid = bids[0];
            if (!firstBid) {
                Logger.warning('No bids available');
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const bestBid = bids.reduce(
                (m, b) => (parseFloat(b.price) > parseFloat(m.price) ? b : m),
                firstBid
            );
            const bidPrice = parseFloat(bestBid.price);

            if (remaining < MIN_ORDER_TOKEN_SIZE) {
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            const sellAmt = Math.min(remaining, parseFloat(bestBid.size));
            if (sellAmt < MIN_ORDER_TOKEN_SIZE) {
                await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
                break;
            }

            Logger.info(`Best bid: ${bestBid.size} @ $${bidPrice}`);

            const signed = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: tokenId,
                amount: sellAmt,
                price: bidPrice,
            });
            const resp = await clobClient.postOrder(signed, OrderType.FOK);

            if (resp.success) {
                retry = 0;
                totalSoldTokens += sellAmt;
                weightedSumSellPrice += sellAmt * bidPrice;
                remaining -= sellAmt;
                Logger.orderResult(true, `Sold ${sellAmt} tokens @ $${bidPrice}`);
                // ── Notification: SELL filled ──
                notifyOrderFilled({
                    side: 'SELL',
                    marketTitle,
                    eventSlug,
                    outcome,
                    amountUSD: sellAmt * bidPrice,
                    price: bidPrice,
                    tokensFilled: sellAmt,
                    traderAddress: userAddress,
                    txHash,
                });
            } else {
                const errMsg = extractOrderError(resp);
                if (isFundsError(errMsg)) {
                    abortDueToFunds = true;
                    notifyInsufficientFunds(0, 0, marketTitle);
                    break;
                }
                retry++;
                Logger.warning(
                    `Order failed (${retry}/${RETRY_LIMIT})${errMsg ? ` — ${errMsg}` : ''}`
                );
                if (retry >= RETRY_LIMIT)
                    notifyOrderFailed('SELL', marketTitle, errMsg ?? 'Unknown', RETRY_LIMIT);
            }
        }

        // ── P&L notification ──────────────────────────────────────────────────
        if (totalSoldTokens > 0 && avgBuyPrice > 0) {
            const avgSellPrice = weightedSumSellPrice / totalSoldTokens;
            const realizedPnl = (avgSellPrice - avgBuyPrice) * totalSoldTokens;
            notifyPnLResult({
                marketTitle,
                eventSlug,
                outcome,
                avgBuyPrice,
                sellPrice: avgSellPrice,
                tokensSold: totalSoldTokens,
                realizedPnlUSD: realizedPnl,
                isFullClose: remaining <= 0.01,
            });
        }

        // Update tracked purchase records
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPct = totalSoldTokens / totalBoughtTokens;
            if (sellPct >= 0.99) {
                await prisma.userActivities.updateMany({
                    where: {
                        asset: tokenId,
                        conditionId: trade.conditionId ?? undefined,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { gt: 0 },
                    },
                    data: { myBoughtSize: 0 },
                });
            } else {
                for (const buy of previousBuys) {
                    await prisma.userActivities.update({
                        where: { id: buy.id },
                        data: { myBoughtSize: (buy.myBoughtSize ?? 0) * (1 - sellPct) },
                    });
                }
            }
        }

        await prisma.userActivities.update({
            where: { id: trade.id },
            data: { bot: true, botExcutedTime: abortDueToFunds || retry >= RETRY_LIMIT ? retry : 0 },
        });
    } else {
        Logger.error(`Unknown condition: "${condition}"`);
        await prisma.userActivities.update({ where: { id: trade.id }, data: { bot: true } });
    }
};

export default postOrder;
