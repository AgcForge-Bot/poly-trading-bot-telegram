import axios from 'axios';
import { spawn } from 'node:child_process';
import { ENV } from '../config/env';
import { esc } from '../services/telegramNotifier';
import { findByKey, getSetupConfig, updateByKey } from '../models/setupConfig';
import { isTradingEnabled, setTradingEnabled } from '../services/runtimeState';
import getMyBalance from '../utils/getMyBalance';
import { performHealthCheck } from '../utils/healthCheck';
import { getActiveAddresses, loadPersistedTraders } from '../services/leaderboardScanner';
