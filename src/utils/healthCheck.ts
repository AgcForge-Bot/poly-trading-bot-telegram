import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import getMyBalance from './getMyBalance';
import fetchData from './fetchData';
import Logger from './logger';
import { PrismaClientInitializationError } from '@prisma/client/runtime/client';



/**
 * Perform health check on all critical components
 */
export const performHealthCheck = async (): Promise<HealthCheckResult> => {
    const checks: HealthCheckResult['checks'] = {
        database: { status: 'error', message: 'Not checked' },
        rpc: { status: 'error', message: 'Not checked' },
        balance: { status: 'error', message: 'Not checked' },
        polymarketApi: { status: 'error', message: 'Not checked' },
    };

    // Check MongoDB connection
    try {
        await prisma.$connect()
        checks.database = { status: 'ok', message: 'Connected successfully' };
    } catch (error) {
        if (error instanceof PrismaClientInitializationError) {
            checks.database = {
                status: 'error',
                message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        checks.database = {
            status: 'error',
            message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check RPC endpoint
    try {
        const response = await fetch(ENV.RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_blockNumber',
                params: [],
                id: 1,
            }),
            signal: AbortSignal.timeout(5000), // 5 second timeout
        });

        if (response.ok) {
            const data = await response.json();
            if (data.result) {
                checks.rpc = { status: 'ok', message: 'RPC endpoint responding' };
            } else {
                checks.rpc = { status: 'error', message: 'Invalid RPC response' };
            }
        } else {
            checks.rpc = { status: 'error', message: `HTTP ${response.status}` };
        }
    } catch (error) {
        checks.rpc = {
            status: 'error',
            message: `RPC check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check USDC balance
    try {
        const balance = await getMyBalance(ENV.PROXY_WALLET);
        if (balance > 0) {
            if (balance < 10) {
                checks.balance = {
                    status: 'warning',
                    message: `Low balance: $${balance.toFixed(2)}`,
                    balance,
                };
            } else {
                checks.balance = {
                    status: 'ok',
                    message: `Balance: $${balance.toFixed(2)}`,
                    balance,
                };
            }
        } else {
            checks.balance = { status: 'error', message: 'Zero balance' };
        }
    } catch (error) {
        checks.balance = {
            status: 'error',
            message: `Balance check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check Polymarket API
    try {
        const testUrl =
            'https://data-api.polymarket.com/positions?user=0x0000000000000000000000000000000000000000';
        await fetchData(testUrl);
        checks.polymarketApi = { status: 'ok', message: 'API responding' };
    } catch (error) {
        checks.polymarketApi = {
            status: 'error',
            message: `API check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Determine overall health
    const healthy =
        checks.database.status === 'ok' &&
        checks.rpc.status === 'ok' &&
        checks.balance.status !== 'error' &&
        checks.polymarketApi.status === 'ok';

    return {
        healthy,
        checks,
        timestamp: Date.now(),
    };
};