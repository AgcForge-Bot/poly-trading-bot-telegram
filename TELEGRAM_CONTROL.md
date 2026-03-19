# Telegram Control Panel (Long Polling)

Project ini sudah punya Telegram controller berbasis **long polling** (tanpa webhook), jadi **tidak perlu** Express/Adonis.

## Cara kerja singkat

- Bot di server akan *outbound* request ke Telegram API (`getUpdates`) untuk membaca command/menu.
- Tidak perlu domain/HTTPS.
- Pastikan hanya **1 instance** bot yang jalan untuk 1 token (kalau 2 instance, update bisa “rebutan”).

## 1) Setup bot Telegram

1. Buat bot via **@BotFather** → dapatkan `TELEGRAM_BOT_TOKEN`.
2. Dapatkan `TELEGRAM_CHAT_ID`:
   - Chat pribadi: kirim pesan ke bot, lalu cek `getUpdates` atau pakai bot seperti **@userinfobot**.
   - Group: tambahkan bot ke group, kirim pesan, lalu cek `getUpdates`.

## 2) Enable fitur Telegram di database config

Semua config (kecuali `DATABASE_URL`) ada di tabel `configs`.

Minimal wajib:

- `TELEGRAM_NOTIFICATIONS_ENABLED = true` (untuk notifikasi)
- `TELEGRAM_CONTROL_ENABLED = true` (untuk menu/control panel)
- `TELEGRAM_BOT_TOKEN = <token bot>`
- `TELEGRAM_CHAT_ID = <chat id>`

Kalau mau enable restart PM2 (opsional, paling sensitif):

- `TELEGRAM_PM2_CONTROL_ENABLED = true`
- `PM2_PROCESS_NAME = copy-bot-poly` (atau nama proses PM2 kamu)
- `TELEGRAM_ADMIN_CHAT_IDS = ["123456789"]` (whitelist chat id admin)
- `TELEGRAM_PM2_PIN = 1234` (opsional; jika diisi harus `/auth 1234` dulu sebelum tombol restart muncul)

Kamu bisa set via Telegram:

- `/set KEY VALUE`

Contoh:

- `/set TELEGRAM_CONTROL_ENABLED true`
- `/set TELEGRAM_BOT_TOKEN 123:ABC...`
- `/set TELEGRAM_CHAT_ID 123456789`
- `/set TELEGRAM_PM2_CONTROL_ENABLED true`
- `/set TELEGRAM_ADMIN_CHAT_IDS ["123456789"]`
- `/set TELEGRAM_PM2_PIN 1234`

## 3) Command & menu yang tersedia

Command:

- `/menu` atau `/start` → buka Control Panel
- `/status` → status bot
- `/health` → health check ringkas
- `/config` → ringkasan config
- `/set KEY VALUE` → update config di DB
- `/pause` / `/resume` → pause/resume trading (tanpa stop proses)
- `/balance` → cek balance proxy wallet
- `/addresses` → tampilkan list address (AUTO/MANUAL)
- `/auth 1234` → authorize PM2 control (jika PIN di-set)
- `/restart` → restart PM2 (jika authorized)

Menu inline button:

- Health, Balance, Addresses, Status
- Pause/Resume
- Config → submenu:
  - Strategy (PERCENTAGE/FIXED/ADAPTIVE/OWN_CUSTOM)
  - Slippage preset
  - Own Custom USD preset
  - Toggle AUTO mode
- Restart (PM2) hanya muncul jika:
  - `TELEGRAM_PM2_CONTROL_ENABLED=true`
  - chat id termasuk whitelist
  - dan jika `TELEGRAM_PM2_PIN` diisi → sudah `/auth PIN` (berlaku 30 menit)

## Template BotFather `/setcommands`

Copy-paste ini ke BotFather → `/setcommands`:

```
menu - buka control panel
status - status bot
health - health check
config - ringkasan config
set - update config: /set KEY VALUE
pause - pause trading
resume - resume trading
balance - cek balance proxy wallet
addresses - lihat list address
auth - authorize PM2: /auth PIN
restart - restart proses via PM2
```

