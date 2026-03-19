import { prisma } from "../lib/prisma";
import type { UserPositions, UserActivities } from "../types/prisma/client";

export const getUserPosition = async (walletAddress: string): Promise<UserPositions[]> => {
    try {
        const user = await prisma.userPositions.findMany({
            where: { proxyWallet: walletAddress },
            orderBy: { created_at: "desc" },
        });
        return user;
    } catch (error) {
        console.error("Error fetching user position:", error);
        return [];
    }
};
export const getUserActivity = async (walletAddress: string): Promise<UserActivities[]> => {
    try {
        const user = await prisma.userActivities.findMany({
            where: { proxyWallet: walletAddress },
            orderBy: { created_at: "desc" },
        });
        return user;
    } catch (error) {
        console.error("Error fetching user activity:", error);
        return [];
    }
};

export const getDailyReportDbStats = async (
    addresses: string[],
    isoDate: string,
): Promise<DailyReportDbStats> => {
    if (addresses.length === 0) {
        return {
            totalTrades: 0,
            winTrades: 0,
            lossTrades: 0,
            totalPnlUSD: 0,
            totalVolumeUSD: 0,
            openPositions: 0,
        };
    }

    const startOfDay = new Date(`${isoDate}T00:00:00.000Z`);
    const endOfDay = new Date(`${isoDate}T23:59:59.999Z`);

    try {
        const trades = await prisma.userActivities.findMany({
            where: {
                proxyWallet: { in: addresses },
                bot: true,
                botExcutedTime: { gt: 0, lt: 999 },
                created_at: { gte: startOfDay, lte: endOfDay },
                type: "TRADE",
            },
            select: {
                side: true,
                myBoughtSize: true,
                price: true,
                usdcSize: true,
            },
            orderBy: { created_at: "desc" },
        });

        const totalTrades = trades.length;
        const totalVolumeUSD = trades.reduce((s, t) => s + (t.usdcSize ?? 0), 0);

        let winTrades = 0;
        let lossTrades = 0;
        for (const t of trades) {
            if (t.side !== "SELL" || !t.myBoughtSize) continue;
            if ((t.price ?? 0) >= 0.5) winTrades++;
            else lossTrades++;
        }

        const sellRevenue = trades
            .filter((t) => t.side === "SELL")
            .reduce((s, t) => s + (t.usdcSize ?? 0), 0);
        const buyCost = trades
            .filter((t) => t.side === "BUY")
            .reduce((s, t) => s + (t.usdcSize ?? 0), 0);
        const totalPnlUSD = sellRevenue - buyCost;

        const openPositions = await prisma.userPositions.count({
            where: {
                proxyWallet: { in: addresses },
                size: { gt: 0 },
            },
        });

        return {
            totalTrades,
            winTrades,
            lossTrades,
            totalPnlUSD,
            totalVolumeUSD,
            openPositions,
        };
    } catch (error) {
        console.error("Error building daily report stats:", error);
        return {
            totalTrades: 0,
            winTrades: 0,
            lossTrades: 0,
            totalPnlUSD: 0,
            totalVolumeUSD: 0,
            openPositions: 0,
        };
    }
};
