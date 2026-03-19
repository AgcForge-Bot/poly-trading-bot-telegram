/**
 * PM2 Ecosystem Config — Polymarket Copy Trading Bot
 *
 * 3 processes:
 *   1. polymarket-copy-bot      — main bot (copy trading, always running)
 *   2. polymarket-close-resolved — sell positions price≥$0.99 or ≤$0.01 (every 30 min)
 *   3. polymarket-redeem        — redeem resolved positions on-chain (every 30 min)
 *
 * CARA PAKAI:
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * ⚠️  Semua secrets (PRIVATE_KEY, MONGO_URI, TELEGRAM_BOT_TOKEN) di file .env
 *     JANGAN taruh di file ini.
 */

'use strict';

// Shared non-sensitive env vars dipakai oleh semua process
const sharedEnv = {
  NODE_ENV: 'production',
  USER_ADDRESSES:
    '["0xefbc5fec8d7b0acdc8911bdd9a98d6964308f9a2", "0x492442eab586f242b53bda933fd5de859c8a3782", "0xe594336603f4fb5d3ba4125a67021ab3b4347052", "0xa8b202e6e9a4c2091b6860f1f5c9e9119bbc9a39", "0x1c1675a7c3662131acfd00aaabcbc97a6a4f45e9", "0xd0d6053c3c37e727402d84c14069780d360993aa", "0x43e98f912cd6ddadaad88d3297e78c0648e688e5", "0x63ce342161250d705dc0b16df89036c8e5f9ba9a","0xee613b3fc183ee44f9da9c05f53e2da107e3debf", "0x3b5c629f114098b0dee345fb78b7a3a013c7126e"]',
  PROXY_WALLET: '0xa02968DdEbC2a8dCeaA3A3f42A83bc69f3349aEB',
  PRIVATE_KEY: '746d50e77f337c92c61c511b11ec468c9ccde68a28f5a33047fdb2da98c1ea0b',
  CLOB_HTTP_URL: 'https://clob.polymarket.com/',
  CLOB_WS_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws',
  FETCH_INTERVAL: 1,
  TOO_OLD_TIMESTAMP: 1,
  RETRY_LIMIT: 3,
  REQUEST_TIMEOUT_MS: 10000,
  NETWORK_RETRY_LIMIT: 3,
  COPY_STRATEGY: 'PERCENTAGE',
  COPY_SIZE: 10.0,
  MAX_ORDER_SIZE_USD: 3.0,
  MIN_ORDER_SIZE_USD: 1.0,
  MAX_SLIPPAGE_PERCENT: 15,
  ADAPTIVE_MIN_PERCENT: 5.0,
  ADAPTIVE_MAX_PERCENT: 20.0,
  ADAPTIVE_THRESHOLD_USD: 500.0,
  TRADE_AGGREGATION_ENABLED: false,
  TRADE_AGGREGATION_WINDOW_SECONDS: 10,
  PREVIEW_MODE: false,
  DATABASE_URL:
    'postgres://87a4057a51a86f37b25c5ce38fa9bded1d4856b358cd6fee7759f9eec92ac261:sk_MhCjGjq1JGW_NTSrfu57p@db.prisma.io:5432/postgres?sslmode=require',
  RPC_URL: 'https://polygon-mainnet.g.alchemy.com/v2/ilg3B7LJoacaEWvd6FxNZ',
  USDC_CONTRACT_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  USE_AUTO_TRADE_ADDRESS_FROM_API: true,
  MAX_LIST_TRADE_ADDRESS_FROM_API: 10,
  INTERVAL_REFETCHING_ADDRESS_LIST: 14400000,
  LEADERBOARD_MIN_PROFIT_USD: 1000,
  LEADERBOARD_MIN_VOLUME_USD: 5000,
  LEADERBOARD_MIN_WIN_RATE: 0.55,
  LEADERBOARD_TIME_PERIOD: 'DAY',
  LEADERBOARD_SCORE_WEIGHT_PROFIT: 0.4,
  LEADERBOARD_SCORE_WEIGHT_VOLUME: 0.25,
  LEADERBOARD_SCORE_WEIGHT_ACTIVITY: 0.2,
  LEADERBOARD_SCORE_WEIGHT_WINRATE: 0.15,
  TELEGRAM_NOTIFICATIONS_ENABLED: true,
  TELEGRAM_BOT_TOKEN: '8654935501:AAHJtxe1TYFgZAXthXlqylDr-27lAJGWmGs',
  TELEGRAM_CHAT_ID: '-1003842668032',
  TELEGRAM_DAILY_REPORT_HOUR: 8,
};

module.exports = {
  apps: [
    {
      name: 'polymarket-copy-bot',
      script: './dist/index.js',

      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 5000,
      kill_timeout: 10000,
      max_memory_restart: '800M',

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/polymarket-bot/error.log',
      out_file: '/var/log/polymarket-bot/output.log',
      merge_logs: true,
      log_type: 'raw',

      node_args: '--max-old-space-size=1024 --enable-source-maps',
      env: { ...sharedEnv },
    },
    // ══════════════════════════════════════════════════════════════════
    //  2. CLOSE STALE — sell jika trader yang diikuti sudah exit
    //
    //  Trigger: event MASIH AKTIF tapi trader sudah keluar duluan
    //  Cara kerja:
    //    - Ambil posisi KAMU dari API
    //    - Ambil posisi semua trader yang sedang diikuti dari API
    //    - Jika posisi ada di kamu tapi TIDAK ADA di trader → SELL
    //  Interval: setiap 15 menit
    //
    //  ⚠️  CATATAN PENTING — MODE AUTO DISCOVERY:
    //  Script asli pakai ENV.USER_ADDRESSES (static). Karena kamu
    //  pakai auto-discovery, USER_ADDRESSES di .env harus diisi dengan
    //  alamat trader TERAKHIR yang dipilih leaderboard, atau gunakan
    //  script yang sudah diupdate (lihat closeStalePositions.ts baru).
    //  Sementara ini, set USER_ADDRESSES di .env dengan 10 alamat
    //  dari log terakhir bot.
    // ══════════════════════════════════════════════════════════════════
    {
      name: 'polymarket-close-stale',
      script: './dist/scripts/closeStalePositions.js',

      cron_restart: '*/15 * * * *', // setiap 15 menit
      autorestart: false,
      watch: false,
      kill_timeout: 300000, // 5 menit

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/polymarket-bot/close-stale-error.log',
      out_file: '/var/log/polymarket-bot/close-stale-output.log',
      merge_logs: true,

      node_args: '--enable-source-maps',
      env: { ...sharedEnv },
    },
    // ══════════════════════════════════════════════════════════════════
    //  3. CLOSE RESOLVED — sell posisi yang sudah resolved di CLOB
    //
    //  Trigger: curPrice >= $0.99 (menang) atau <= $0.01 (kalah)
    //  Cara kerja:
    //    - Scan semua posisi kamu
    //    - Sell posisi dengan harga di threshold di atas
    //    - Posisi aktif (harga antara $0.01–$0.99) TIDAK disentuh
    //  Interval: setiap 30 menit
    // ══════════════════════════════════════════════════════════════════
    {
      name: 'polymarket-close-resolved',
      script: './dist/scripts/closeResolvedPositions.js',

      cron_restart: '*/30 * * * *',
      autorestart: false,
      watch: false,
      kill_timeout: 600000,

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/polymarket-bot/close-resolved-error.log',
      out_file: '/var/log/polymarket-bot/close-resolved-output.log',
      merge_logs: true,

      node_args: '--enable-source-maps',
      env: { ...sharedEnv },
    },
    // ══════════════════════════════════════════════════════════════════
    //  4. REDEEM — klaim USDC langsung dari kontrak CTF on-chain
    //
    //  Trigger: posisi dengan flag redeemable = true
    //  Cara kerja:
    //    - Call CTF contract redeemPositions() on-chain
    //    - USDC langsung masuk ke proxy wallet
    //    - Guaranteed dapat USDC jika menang (tidak perlu ada buyer)
    //  Interval: offset 7 menit setelah close-stale dan close-resolved
    //
    //  Perbedaan close-resolved vs redeem:
    //    close-resolved = sell di CLOB (butuh ada buyer di order book)
    //    redeem         = klaim langsung blockchain (guaranteed,
    //                     hanya bisa setelah market fully resolved)
    // ══════════════════════════════════════════════════════════════════
    {
      name: 'polymarket-redeem',
      script: './dist/scripts/redeemResolvedPositions.js',

      cron_restart: '7,22,37,52 * * * *', // tiap 15 menit, offset 7 menit
      autorestart: false,
      watch: false,
      kill_timeout: 600000,

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/polymarket-bot/redeem-error.log',
      out_file: '/var/log/polymarket-bot/redeem-output.log',
      merge_logs: true,

      node_args: '--enable-source-maps',
      env: { ...sharedEnv },
    },
  ],
};
