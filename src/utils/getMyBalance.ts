import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// ─── Provider Singleton (BUG-2 FIX) ──────────────────────────────────────────
// Creating a new JsonRpcProvider on every call opens a new HTTP/WebSocket
// connection each time. getMyBalance() is called per-trade, so this caused
// connection leaks and slowed execution. Cache a single provider instance.

let _provider: ethers.providers.JsonRpcProvider | null = null;

const getProvider = (): ethers.providers.JsonRpcProvider => {
    if (!_provider) {
        _provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    }
    return _provider;
};

const getMyBalance = async (address: string): Promise<number> => {
    try {
        const provider = getProvider();
        const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, provider);
        const balanceRaw = await usdcContract.balanceOf(address);
        return parseFloat(ethers.utils.formatUnits(balanceRaw, 6));
    } catch (error) {
        // Invalidate cached provider on connection failure so it reconnects next call
        _provider = null;
        throw new Error(
            `Failed to fetch USDC balance for ${address}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }
};

export default getMyBalance;
