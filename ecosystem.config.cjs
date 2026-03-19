module.exports = {
  apps: [
    {
      name: 'copy-bot-poly',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/copy-bot-poly?schema=public',
      },
    },
  ],
};
