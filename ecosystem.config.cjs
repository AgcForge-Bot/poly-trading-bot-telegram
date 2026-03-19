module.exports = {
  apps: [
    {
      name: 'copy-bot-poly',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'copy-bot-close-stale',
      script: 'dist/scripts/closeStalePositions.js',
      cron_restart: '*/15 * * * *',
      autorestart: false,
      watch: false,
      kill_timeout: 300000,
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'copy-bot-close-resolved',
      script: 'dist/scripts/closeResolvedPositions.js',
      cron_restart: '*/30 * * * *',
      autorestart: false,
      watch: false,
      kill_timeout: 600000,
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'copy-bot-redeem',
      script: 'dist/scripts/redeemResolvedPositions.js',
      cron_restart: '7,22,37,52 * * * *',
      autorestart: false,
      watch: false,
      kill_timeout: 600000,
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
