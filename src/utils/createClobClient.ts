import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

// ─── createClobClient ─────────────────────────────────────────────────────────
// BUG-11 FIX: The original code did `console.error = function() {}` to suppress
//   Polymarket SDK noise during createApiKey. This GLOBALLY silenced all errors
//   from every module during that window — fatal errors were hidden silently.
// BUG-12 FIX: No validation of credentials after deriveApiKey, so the bot could
//   run with an invalid/undefined API key and every order would fail.

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137; // Polygon mainnet
    const wallet = new ethers.Wallet(PRIVATE_KEY);

    // Build an unauthenticated client to obtain credentials
    const unauthClient = new ClobClient(
        CLOB_HTTP_URL,
        chainId,
        wallet,
        undefined,
        SignatureType.POLY_PROXY,
        PROXY_WALLET
    );

    // ── Step 1: Obtain API credentials ───────────────────────────────────────
    // Try createApiKey first; fall back to deriveApiKey if it already exists.
    // Never suppress console.error globally — catch errors properly instead.
    let creds: Awaited<ReturnType<typeof unauthClient.createApiKey>> | undefined;

    try {
        creds = await unauthClient.createApiKey();
        if (creds?.key) {
            Logger.success(`CLOB API key created (key: ${creds.key.slice(0, 8)}...)`);
        } else {
            throw new Error('createApiKey returned empty credentials');
        }
    } catch (_createErr) {
        // Key already exists — derive it instead
        Logger.info('createApiKey failed (key likely exists), deriving existing key...');
        try {
            creds = await unauthClient.deriveApiKey();
            if (!creds?.key) {
                throw new Error('deriveApiKey returned empty credentials');
            }
            Logger.success(`CLOB API key derived (key: ${creds.key.slice(0, 8)}...)`);
        } catch (deriveErr) {
            throw new Error(
                `Failed to obtain CLOB API credentials. ` +
                `Check PRIVATE_KEY and PROXY_WALLET in your .env file.\n` +
                `Details: ${deriveErr instanceof Error ? deriveErr.message : String(deriveErr)}`
            );
        }
    }

    // ── Step 2: Build the authenticated client ────────────────────────────────
    const authClient = new ClobClient(
        CLOB_HTTP_URL,
        chainId,
        wallet,
        creds,
        SignatureType.POLY_PROXY,
        PROXY_WALLET
    );

    // ── Step 3: Quick connectivity sanity-check ───────────────────────────────
    try {
        await authClient.getServerTime();
        Logger.success('CLOB client authenticated and connected');
    } catch (pingErr) {
        Logger.warning(
            `CLOB ping failed (${pingErr instanceof Error ? pingErr.message : String(pingErr)}). ` +
            `Orders may fail — check CLOB_HTTP_URL and network connectivity.`
        );
    }

    return authClient;
};

export default createClobClient;
