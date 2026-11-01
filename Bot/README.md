# Faiz — bot WhatsApp temen ngobrol

Bot WhatsApp (Baileys v7) yang ngobrol pake Gemini. Santai, pake "lu/gw", gak ada tugas khusus.
Ditulis pake **TypeScript** (strict mode).

## Jalanin
```bash
npm install
# isi GEMINI_API_KEY di file .env (contoh ada di .env.example)

npm run dev        # development, langsung jalan dari TS tanpa build (input nomor/pairing aman)
npm run dev:watch  # sama, tapi auto-restart pas file berubah (gak bisa input interaktif)
# atau
npm run build   # compile TS -> dist/
npm start       # jalanin hasil build
```
Pertama kali: masukin nomor WA bot (62xxx), lalu masukin pairing code di
WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.
Setelah itu session kesimpen di folder `FaizSesi/`.

Cek tipe tanpa build: `npm run typecheck`

## Struktur
```
src/
  index.ts   koneksi WhatsApp & pairing
  bot.ts     logika handler pesan
  genai.ts   pemanggilan Gemini (teks + gambar)
  config.ts  nama, trigger, persona, cooldown
  types.ts   tipe bersama
  utils.ts   helper kecil
  env.d.ts   tipe untuk process.env
```

## Cara manggil
Sebut kata pemanggil (lihat `TRIGGERS` di `config.ts`) di chat (grup/pribadi), contoh: `jek, rekomen lagu dong`.
- Reply pesan orang + tulis kata pemanggil → Faiz nanggepin pesan itu.
- Kirim/reply gambar + `jek ini apa?` → Faiz liat gambarnya.

## Ubah-ubah
Semua ada di `src/config.ts`: nama, kata pemanggil, persona/gaya bicara, cooldown.
Model Gemini diatur lewat `GEMINI_MODELS` di `.env`.
