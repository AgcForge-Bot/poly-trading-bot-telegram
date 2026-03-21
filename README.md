# COPY POLY BOT TRADE

This repo fork from [copy-bot-poly](https://github.com/llgpqul/polymarket-copy-trading-bot)

## 1. Feature

- [x] Copy trade from other user in leaderboard market
- [x] Telegram Control Bot
- [x] With 4 types of strategy (Fixed, Percentage, Adaptive, and Own Custom)

## 2. Guide Installation _(Table of Contents)_

- [2.1 Prerequisites](#21-prerequisites)
- [2.2 Installation Steps](#22-installation-steps)
- [2.3 Configuration](#23-configuration)
- [2.4 Running the Bot](#24-running-the-bot)

### 2.1 Prerequisites

1. Node.js (v16 or higher)
2. npm (Node Package Manager) / pnpm (Preferred Node Package Manager)
3. PostgreSQL database
4. Setup Environment Variables
5. Telegram Bot Token (from BotFather)
6. Wallet Address (for receiving rewards) & Private Key (for signing transactions)
7. Ubuntu Server Installation (for running the bot)

### 2.2 Installation Steps

1. Clone the repository:
   ```
   git clone https://github.com/AgcForge-Bot/poly-trading-bot-telegram.git
   cd poly-trading-bot-telegram
   ```
2. Install dependencies:

   ```
   npm install

   // or use pnpm

   pnpm install
   ```

3. Setup PostgreSQL database:
   - Read [PostgreSQL Installation Guide](PRISMA_STARTED.md) to install PostgreSQL on your project.
4. Set up environment variables:
   - Create a `.env` file in the root directory.
   - Add the following environment variables:
     ```
     USER_ADDRESSES=["0xTrader1...", "0xTrader2...", "0xTrader3..."] // default: []
     PROXY_WALLET='0xProxyWallet...'
     PRIVATE_KEY='PrivateKey...'
     COPY_STRATEGY='OWN_CUSTOM' // default: 'OWN_CUSTOM' (Fixed, Percentage, Adaptive, Own Custom)
     USE_AUTO_TRADE_ADDRESS_FROM_API=true // default: true
     MAX_LIST_TRADE_ADDRESS_FROM_API=5 // default: 5
     INTERVAL_REFETCHING_ADDRESS_LIST=14400000 // default: 14400000 (14400000ms = 14400s = 4h)
     TELEGRAM_NOTIFICATIONS_ENABLED=true // default: true
     TELEGRAM_CONTROL_ENABLED=true // default: true
     TELEGRAM_ADMIN_CHAT_IDS=["1234567890"] // default: []
     TELEGRAM_PM2_CONTROL_ENABLED=true // default: true
     TELEGRAM_PM2_PIN=123456 // default: 123456
     TELEGRAM_BOT_TOKEN=1234567:AAxxxxxxxxx // default: ""
     TELEGRAM_CHAT_ID=-987654321 // default: -987654321
     TELEGRAM_CHAT_ID_CONTROL=-1234567890 // default: -1234567890
     TELEGRAM_DAILY_REPORT_HOUR=8 // default: 8
     TRADING_ENABLED=true // default: true
     PM2_PROCESS_NAME=copy-bot-poly // default: copy-bot-poly
     DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}
     ```
5. Telegram Bot Token (from BotFather)
   - Create a new bot on Telegram using [BotFather](https://core.telegram.org/bots#botfather).
   - Obtain the bot token provided by BotFather.
   - Add the bot token to the `.env` file:
     ```
     TELEGRAM_BOT_TOKEN=1234567:AAxxxxxxxxx
     TELEGRAM_CHAT_ID=-987654321 // for notifications
     TELEGRAM_CHAT_ID_CONTROL=-1234567890 // for control bot
     TELEGRAM_ADMIN_CHAT_IDS=["1234567890"] // default: [] for whitelist admin
     ```
6. Wallet Address (for receiving rewards) & Private Key (for signing transactions)
   - Obtain a wallet address and private key for signing transactions.
   - Add the wallet address and private key to the `.env` file:
     ```
     USER_ADDRESSES=["0xTrader1...", "0xTrader2...", "0xTrader3..."] // default: []
     PROXY_WALLET='0xProxyWallet...'
     PRIVATE_KEY='PrivateKey...'
     ```
7. Ubuntu Server Installation (for running the bot)
   - Read [Ubuntu Server Installation Guide With PM2](DEPLOY_UBUNTU_PM2.md) to install Ubuntu Server on your project.

### NOTES :

- If you want to run the bot on your local machine, you can skip the Ubuntu Server Installation step.
- If you want to run the bot on a remote server, you must install Ubuntu Server on your project.
- This bot tool is very risky. It can cost you all your money. Please use it with caution.
