# Setup PostgreSQL Prisma

> Panduan lengkap instalasi **Prisma ORM** ke project **Copy Bot Poly** dengan tiga pilihan koneksi database: Prisma Studio (lokal), Supabase, dan PostgreSQL sendiri.

| Info               | Detail                                                                 |
| :----------------- | :--------------------------------------------------------------------- |
| **Stack**          | TypeScript + Prisma ORM + PostgreSQL                                   |
| **Prisma Version** | `^5.x` (latest stable)                                                 |
| **Prerequisites**  | Node.js >= 18, npm/yarn/pnpm, TypeScript project sudah terinisialisasi |

---

## Inisialisasi Umum (Wajib untuk Semua Pilihan)

> Langkah-langkah berikut harus dilakukan terlebih dahulu sebelum memilih salah satu opsi koneksi database.

1. **Install Prisma CLI dan Client**

   ```bash
   npm install prisma --save-dev
   npm install @prisma/client
   ```

2. **Inisialisasi Prisma**

   ```bash
   npx prisma init
   ```

   Perintah ini akan membuat:
   - Folder `prisma/` dengan file `schema.prisma`
   - File `.env` di root project

3. **Pastikan `tsconfig.json` sudah ada.** Jika belum:

   ```bash
   npx tsc --init
   ```

4. **Struktur project setelah init:**

   ```
   my-project/
   ├── prisma/
   │   └── schema.prisma
   ├── src/
   ├── .env
   ├── package.json
   └── tsconfig.json
   ```

---

## 1). Prisma Studio

> Pilihan ini cocok untuk **development lokal**. Prisma Studio menyediakan GUI berbasis browser untuk melihat dan mengelola data langsung dari mesin kamu — tanpa perlu setup cloud atau server eksternal.

### Prasyarat

- PostgreSQL terinstall di mesin lokal
- PostgreSQL berjalan di port default `5432`

### Langkah-langkah

1. **Pastikan PostgreSQL lokal berjalan**

   ```bash
   # macOS (Homebrew)
   brew services start postgresql

   # Ubuntu/Debian
   sudo service postgresql start

   # Windows (PowerShell sebagai Admin)
   net start postgresql
   ```

2. **Buat database lokal**

   ```bash
   psql -U postgres -c "CREATE DATABASE mydb;"
   ```

3. **Konfigurasi `.env`**

   ```env
   DATABASE_URL="postgresql://postgres:password@localhost:5432/mydb?schema=public"
   ```

   Ganti `postgres`, `password`, dan `mydb` sesuai konfigurasi lokal kamu.

4. **Buat model di `prisma/schema.prisma`**

   ```prisma
   generator client {
     provider = "prisma-client-js"
   }

   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }

   model User {
     id        Int      @id @default(autoincrement())
     name      String
     email     String   @unique
     createdAt DateTime @default(now())
   }
   ```

5. **Jalankan migrasi**

   ```bash
   npx prisma migrate dev --name init
   ```

6. **Generate Prisma Client**

   ```bash
   npx prisma generate
   ```

7. **Buka Prisma Studio di browser**

   ```bash
   npx prisma studio
   ```

   Prisma Studio akan berjalan di `http://localhost:5555` — kamu bisa melihat, menambah, mengedit, dan menghapus data langsung dari UI.

8. **Gunakan Prisma Client di TypeScript**

   ```typescript
   // src/index.ts
   import { PrismaClient } from '@prisma/client';

   const prisma = new PrismaClient();

   async function main() {
     const user = await prisma.user.create({
       data: { name: 'Budi', email: 'budi@example.com' },
     });
     console.log('Created user:', user);
   }

   main()
     .catch(console.error)
     .finally(() => prisma.$disconnect());
   ```

---

## 2). Supabase

> Pilihan ini cocok untuk **deployment cloud** yang cepat. Supabase menyediakan PostgreSQL terkelola secara gratis dengan fitur Auth, Storage, dan Realtime bawaan.

### Prasyarat

- Akun Supabase di [supabase.com](https://supabase.com)
- Project Supabase sudah dibuat

### Langkah-langkah

1. **Buat project baru di Supabase Dashboard**

   Kunjungi [app.supabase.com](https://app.supabase.com) → **New Project** → isi nama project dan password database.

2. **Ambil connection string dari Supabase**

   Masuk ke project → **Settings** → **Database** → scroll ke bagian **Connection string** → pilih tab **URI**.

   Contoh format:

   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxx.supabase.co:5432/postgres
   ```

3. **Konfigurasi `.env`**

   ```env
   # Gunakan connection pooling (port 6543) untuk production/serverless
   DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxx.supabase.co:6543/postgres?pgbouncer=true"

   # Gunakan direct connection (port 5432) untuk migrasi
   DIRECT_URL="postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxxxx.supabase.co:5432/postgres"
   ```

   > ⚠️ **Penting:** Gunakan `DIRECT_URL` khusus untuk `prisma migrate`. Connection pooler (`pgbouncer`) tidak kompatibel dengan perintah migrasi.

4. **Update `prisma/schema.prisma`**

   ```prisma
   generator client {
     provider = "prisma-client-js"
   }

   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")
     directUrl = env("DIRECT_URL")
   }

   model User {
     id        Int      @id @default(autoincrement())
     name      String
     email     String   @unique
     createdAt DateTime @default(now())
   }
   ```

5. **Jalankan migrasi ke Supabase**

   ```bash
   npx prisma migrate dev --name init
   ```

6. **Generate Prisma Client**

   ```bash
   npx prisma generate
   ```

7. **Verifikasi di Supabase Table Editor**

   Buka Supabase Dashboard → **Table Editor** — tabel `User` seharusnya sudah muncul.

8. **Gunakan Prisma Client di TypeScript**

   ```typescript
   // src/index.ts
   import { PrismaClient } from '@prisma/client';

   const prisma = new PrismaClient();

   async function main() {
     const users = await prisma.user.findMany();
     console.log('All users:', users);
   }

   main()
     .catch(console.error)
     .finally(() => prisma.$disconnect());
   ```

9. **(Opsional) Deploy ke production dengan Prisma Migrate**

   ```bash
   # Untuk production, gunakan migrate deploy (bukan migrate dev)
   npx prisma migrate deploy
   ```

---

## 3). Own PostgreSQL

> Pilihan ini cocok untuk **server/VPS sendiri** (misalnya AWS EC2, DigitalOcean Droplet, atau server on-premise). Kamu memiliki kontrol penuh atas konfigurasi database.

### Prasyarat

- PostgreSQL terinstall di server (Ubuntu/Debian/CentOS)
- Akses SSH ke server
- Port `5432` terbuka di firewall (atau gunakan SSH tunneling)

### Langkah-langkah

1. **Install PostgreSQL di server**

   ```bash
   # Ubuntu/Debian
   sudo apt update
   sudo apt install -y postgresql postgresql-contrib

   # Aktifkan dan jalankan service
   sudo systemctl enable postgresql
   sudo systemctl start postgresql
   ```

2. **Buat user dan database PostgreSQL**

   ```bash
   sudo -u postgres psql

   -- Di dalam psql shell:
   CREATE USER myuser WITH PASSWORD 'strongpassword';
   CREATE DATABASE mydb OWNER myuser;
   GRANT ALL PRIVILEGES ON DATABASE mydb TO myuser;
   \q
   ```

3. **Konfigurasi PostgreSQL agar bisa diakses dari luar (jika diperlukan)**

   Edit file `pg_hba.conf`:

   ```bash
   sudo nano /etc/postgresql/*/main/pg_hba.conf
   ```

   Tambahkan baris:

   ```
   host    all             myuser          0.0.0.0/0               md5
   ```

   Edit file `postgresql.conf`:

   ```bash
   sudo nano /etc/postgresql/*/main/postgresql.conf
   ```

   Ubah:

   ```
   listen_addresses = '*'
   ```

   Restart PostgreSQL:

   ```bash
   sudo systemctl restart postgresql
   ```

   > ⚠️ **Keamanan:** Batasi akses hanya ke IP tertentu di `pg_hba.conf` atau gunakan firewall untuk membatasi port 5432.

4. **Konfigurasi `.env`**

   ```env
   DATABASE_URL="postgresql://myuser:strongpassword@your-server-ip:5432/mydb?schema=public"
   ```

   Ganti `your-server-ip` dengan IP publik atau hostname server kamu.

5. **Buat model di `prisma/schema.prisma`**

   ```prisma
   generator client {
     provider = "prisma-client-js"
   }

   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }

   model User {
     id        Int      @id @default(autoincrement())
     name      String
     email     String   @unique
     createdAt DateTime @default(now())
   }
   ```

6. **Jalankan migrasi**

   ```bash
   npx prisma migrate dev --name init
   ```

7. **Generate Prisma Client**

   ```bash
   npx prisma generate
   ```

8. **Test koneksi dengan Prisma Studio**

   ```bash
   npx prisma studio
   ```

   Jika server remote, gunakan SSH tunneling terlebih dahulu:

   ```bash
   ssh -L 5432:localhost:5432 user@your-server-ip
   ```

9. **Gunakan Prisma Client di TypeScript**

   ```typescript
   // src/index.ts
   import { PrismaClient } from '@prisma/client';

   const prisma = new PrismaClient({
     log: ['query', 'info', 'warn', 'error'], // opsional: untuk debugging
   });

   async function main() {
     const newUser = await prisma.user.create({
       data: { name: 'Sari', email: 'sari@example.com' },
     });
     console.log('Created:', newUser);
   }

   main()
     .catch(console.error)
     .finally(() => prisma.$disconnect());
   ```

---

## Perintah Prisma yang Sering Digunakan

| Perintah                    | Fungsi                                          |
| :-------------------------- | :---------------------------------------------- |
| `npx prisma init`           | Inisialisasi Prisma di project                  |
| `npx prisma migrate dev`    | Buat dan jalankan migrasi (development)         |
| `npx prisma migrate deploy` | Jalankan migrasi yang sudah ada (production)    |
| `npx prisma generate`       | Generate/update Prisma Client                   |
| `npx prisma studio`         | Buka GUI Prisma Studio di browser               |
| `npx prisma db push`        | Sinkronkan schema ke DB tanpa migrasi           |
| `npx prisma db pull`        | Introspect DB yang sudah ada ke schema          |
| `npx prisma migrate reset`  | Reset database dan jalankan ulang semua migrasi |

---

## Tips & Best Practices

- **Jangan commit `.env`** — tambahkan ke `.gitignore`
- **Selalu jalankan `prisma generate`** setelah mengubah `schema.prisma`
- **Gunakan `migrate deploy`** (bukan `migrate dev`) di lingkungan production/CI-CD
- **Singleton Prisma Client** — buat satu instance `PrismaClient` dan reuse di seluruh aplikasi untuk menghindari koneksi berlebih
- **Supabase + Serverless** — selalu gunakan connection pooler (port `6543`) untuk lingkungan serverless seperti Vercel atau AWS Lambda
