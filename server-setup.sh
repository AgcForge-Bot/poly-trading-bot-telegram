#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
#  Ubuntu Server Setup — Polymarket Copy Trading Bot (PM2)
#  Jalankan langkah-langkah ini secara berurutan di server Ubuntu kamu.
# ══════════════════════════════════════════════════════════════════════════════

# ─── STEP 1: CHECK Node.js 20 LTS Installation ──────────────────────────────────────────
# Cek apakah Node.js 20 LTS sudah terinstal
if command -v node &> /dev/null && [ "$(node -v)" = "v20.x.x" ]; then
    echo "Node.js 20 LTS sudah terinstal. Versi: $(node -v)"
else
    echo "Node.js 20 LTS belum terinstal. Instalasi akan dilakukan."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    # Verifikasi
    node --version    # harus v20.x.x
    npm --version     # harus 10.x.x
fi

# ─── STEP 2: CHECK PM2 Installation ────────────────────────────────────────────
# Cek apakah PM2 sudah terinstal
if command -v pm2 &> /dev/null; then
    echo "PM2 sudah terinstal. Versi: $(pm2 -v)"
else
    echo "PM2 belum terinstal. Instalasi akan dilakukan."
    sudo npm install -g pm2
fi

# ─── STEP 3: Buat log directory dengan permission yang benar ─────────────────
sudo mkdir -p /var/log/polymarket-bot
sudo chown -R $USER:$USER /var/log/polymarket-bot
sudo chmod 755 /var/log/polymarket-bot

# ─── STEP 4: Clone / upload project ke server ────────────────────────────────
# Opsi A — Git clone (jika pakai git)
# git clone https://github.com/yourname/polymarket-bot.git /home/ubuntu/polymarket-bot

# Opsi B — SCP dari local machine
# scp -r ./polymarket-bot ubuntu@YOUR_SERVER_IP:/home/ubuntu/

cd /var/www/bot/polymarket-copy-trading-bot

# ─── STEP 5: Buat file .env dengan secrets ───────────────────────────────────
# JANGAN copy secrets ke ecosystem.config.cjs — taruh di sini saja
# nano .env

# Isi .env minimal:
# PROXY_WALLET=0xYourProxyWallet
# PRIVATE_KEY=your_private_key
# MONGO_URI=mongodb+srv://...
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...

# Amankan permission file .env (hanya owner yang bisa baca)
chmod 600 .env

# ─── STEP 6: Install dependencies & build ────────────────────────────────────
npm install
npm run build    # output ke ./dist/

# Pastikan dist/index.js ada
ls -la dist/index.js

# ─── STEP 7: Jalankan dengan PM2 ─────────────────────────────────────────────
pm2 start ecosystem.config.cjs

# Cek status
pm2 status
pm2 logs polymarket-copy-bot --lines 50

# ─── STEP 8: Setup auto-start saat server reboot ─────────────────────────────
pm2 save                    # simpan daftar process yang sedang jalan
pm2 startup                 # PM2 akan print satu perintah sudo — COPY dan JALANKAN perintah itu

# Contoh output dari pm2 startup:
# [PM2] To setup the Startup Script, copy/paste the following command:
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

# ─── STEP 9: Verifikasi setelah reboot ───────────────────────────────────────
# sudo reboot
# # setelah reboot:
# pm2 status    # harus muncul 'online'
# pm2 logs polymarket-copy-bot --lines 20

# ─── Perintah PM2 yang sering dipakai ────────────────────────────────────────

# Lihat status semua process
pm2 status

# Lihat log live (streaming)
pm2 logs polymarket-copy-bot

# Lihat hanya error log
pm2 logs polymarket-copy-bot --err

# Restart bot (setelah update code)
npm run build && pm2 restart polymarket-copy-bot

# Stop bot
pm2 stop polymarket-copy-bot

# Hapus process dari PM2
pm2 delete polymarket-copy-bot

# Monitor resource usage (CPU/RAM)
pm2 monit

# Flush log files (bersihkan log lama)
pm2 flush polymarket-copy-bot

# ─── Logrotate setup (opsional tapi recommended) ─────────────────────────────
# Agar log tidak membesar tanpa batas:

sudo tee /etc/logrotate.d/polymarket-bot << 'LOGROTATE'
/var/log/polymarket-bot/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 ubuntu ubuntu
    sharedscripts
    postrotate
    pm2 reloadLogs
    endscript
}
LOGROTATE

echo "Setup complete!"
