# Deploy Ubuntu (PM2)

Dokumen ini fokus ke deploy mode **PM2** (recommended untuk bot long-running).

## Prasyarat

- Ubuntu 22.04/24.04
- Node.js LTS (>= 20)
- `pnpm`
- PostgreSQL (atau Supabase) yang bisa diakses dari server

## 1) Install runtime

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@latest --activate

sudo npm i -g pm2
```

## 2) Deploy code

```bash
git clone <repo-url> copy-bot-poly
cd copy-bot-poly

pnpm i
pnpm prisma generate
```

## 3) Set `DATABASE_URL` (tetap di `.env`)

Di server, buat `.env` minimal berisi:

```env
DATABASE_URL="postgres://..."  # atau prisma:// untuk accelerate
```

Yang lain nanti disimpan di DB (`configs`).

## 4) Seed config ke DB

```bash
pnpm db:seed
```

Lalu set config Telegram via DB atau via Telegram `/set`.

## 5) Build & start via PM2

```bash
pnpm build

# Jalankan semua proses (bot + cron maintenance)
pm2 start ecosystem.config.cjs
# Auto start saat reboot
pm2 save
pm2 startup
```

Cron jobs di `ecosystem.config.cjs`:

- `copy-bot-close-stale` (*/15 menit)
- `copy-bot-close-resolved` (*/30 menit)
- `copy-bot-redeem` (7,22,37,52 menit tiap jam)

Log & monitor:

```bash
pm2 logs copy-bot-poly
pm2 status
```

## 6) Hubungkan Telegram

Pastikan config DB sudah benar:

- `TELEGRAM_CONTROL_ENABLED=true`
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_CHAT_ID=...`

Lalu chat bot kamu dan ketik:

- `/menu`

## Catatan keamanan

- Untuk PM2 restart dari Telegram, enable bertahap:
  - `TELEGRAM_PM2_CONTROL_ENABLED=true`
  - `TELEGRAM_ADMIN_CHAT_IDS=["<chat_id_admin>"]`
  - `TELEGRAM_PM2_PIN=1234` (opsional)
- Jangan jalankan 2 instance bot dengan token Telegram yang sama.
