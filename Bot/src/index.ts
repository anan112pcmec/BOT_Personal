import "dotenv/config";
import fs from "node:fs";
import pino from "pino";
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
} from "@whiskeysockets/baileys";
import handleMessage from "./bot.js";
import { BOT_NAME, PHONE_NUMBER } from "./config.js";
import { errMessage } from "./utils.js";

// Folder session baru (bukan JarvisSesi) supaya pairing mulai dari nol di Baileys v7
const SESSION_PATH = "./FaizSesi";
const logger = pino({ level: process.env.LOG_LEVEL || "error" });

// Nomor di-hardcode di config.ts. Ambil digitnya aja, dan buang "0" nyasar setelah 62
// (62081xxx -> 6281xxx) karena format internasional gak pake 0 di depan.
const nomorHP = PHONE_NUMBER.replace(/\D/g, "").replace(/^620/, "62");
let retry = 0;

/** Ambil kode status dari error koneksi Baileys (bentuknya Boom: error.output.statusCode). */
function statusCodeOf(err: unknown): number | undefined {
    if (typeof err !== "object" || err === null || !("output" in err)) return undefined;
    const output = (err as { output?: { statusCode?: unknown } }).output;
    return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

async function startBot(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    // Belum pernah login? Pastiin nomor di config.ts valid (sebelum socket dibuat)
    if (!state.creds.registered && nomorHP.length < 8) {
        console.log("❌ PHONE_NUMBER di config.ts gak valid (format 62xxx)");
        process.exit(1);
    }

    // Pakai versi WhatsApp Web terbaru; kalo gagal diambil, pakai bawaan Baileys
    const latest = await fetchLatestBaileysVersion().catch(() => undefined);
    const version = latest?.version;

    const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.macOS("Chrome"),
        markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Event "qr" muncul pas socket siap nerima pairing → minta kode di sini (sekali per socket)
        if (qr && !state.creds.registered && !pairingRequested) {
            pairingRequested = true;
            try {
                const code = await sock.requestPairingCode(nomorHP);
                console.log("\n==============================");
                console.log("🔐 PAIRING CODE:", code?.match(/.{1,4}/g)?.join("-") ?? code);
                console.log("==============================");
                console.log("📲 WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon\n");
            } catch (err) {
                console.log("❌ Gagal minta pairing code:", errMessage(err));
            }
        }

        if (connection === "open") {
            retry = 0;
            console.log(`✅ ${BOT_NAME} nyambung & siap!`);
        }

        if (connection === "close") {
            const code = statusCodeOf(lastDisconnect?.error);
            console.log(`⚠️  Koneksi putus (kode: ${code ?? "?"})`);

            if (code === DisconnectReason.loggedOut) {
                console.log("🗑️  Perangkat dikeluarin dari WhatsApp. Session dihapus, jalankan ulang buat pairing lagi.");
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                process.exit(0);
            }

            if (code === DisconnectReason.connectionReplaced) {
                console.log("🛑 Session ini kepake di tempat lain (bot jalan dobel?). Matiin yang satunya dulu.");
                process.exit(1);
            }

            // 405 sebelum login = WhatsApp nolak koneksi (biasanya versi Baileys kelamaan)
            if (code === 405 && !state.creds.registered) {
                console.log("🛑 WhatsApp nolak koneksi (405). Coba: npm install @whiskeysockets/baileys@latest, hapus folder FaizSesi, lalu jalankan lagi.");
                process.exit(1);
            }

            // Sisanya (termasuk 515 restartRequired setelah pairing): sambung lagi
            const delay = Math.min(1000 * 2 ** retry, 30_000);
            retry++;
            console.log(`🔄 Nyambung ulang dalam ${Math.round(delay / 1000)} detik...`);
            setTimeout(() => startBot().catch(fatal), delay);
        }
    });

    sock.ev.on("messages.upsert", (m) => {
        handleMessage(sock, m).catch((err: unknown) => console.error("❌ Handler error:", err));
    });
}

function fatal(err: unknown): never {
    console.error("💥 Fatal:", err);
    process.exit(1);
}

process.on("unhandledRejection", (err) => console.error("⚠️  Unhandled rejection:", err));

console.log(`\n🚀 Menyalakan ${BOT_NAME}...\n`);
startBot().catch(fatal);