import pino from "pino";
import {
    downloadMediaMessage,
    normalizeMessageContent,
    getContentType,
    jidNormalizedUser,
} from "@whiskeysockets/baileys";
import type { WASocket, WAMessage, BaileysEventMap, AnyMessageContent, proto } from "@whiskeysockets/baileys";
import askAI, { generateImage } from "./genai.js";
import { TRIGGERS, COOLDOWN_MS, MAX_MESSAGE_AGE_SEC } from "./config.js";
import type { ImageInput } from "./types.js";

type MessageContent = proto.IMessage;
type ContextInfo = proto.IContextInfo;

const mediaLogger = pino({ level: "silent" });

// Bot jalan di nomor sendiri? Set ALLOW_SELF=true di .env biar chat dari HP lu sendiri
// juga bisa manggil bot. ID pesan yang dikirim bot dicatat supaya gak bales dirinya sendiri.
const ALLOW_SELF = process.env.ALLOW_SELF === "true";
const sentIds = new Set<string>();
const lastReply = new Map<string, number>(); // `${chat}:${sender}` -> timestamp

// "iz" / "faiz" sebagai kata utuh (tanpa huruf/angka di kiri-kanannya)
const names = [...TRIGGERS].sort((a, b) => b.length - a.length).join("|");
const TRIGGER_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names})(?![\\p{L}\\p{N}_])`, "iu");
const TRIGGER_RE_ALL = new RegExp(TRIGGER_RE.source, "giu");

// Deteksi permintaan bikin/edit gambar, contoh: "bikinin gambar kucing", "gambarin ...",
// "ubah foto ini jadi anime". Tinggal tambah kata di IMG_VERB / IMG_NOUN kalo kurang.
const IMG_VERB = "(?:bikin(?:in)?|buat(?:in)?|gambar(?:in)?|lukis(?:in)?|generate|create|draw|edit|ubah|ganti)";
const IMG_NOUN = "(?:gambar|foto|image|ilustrasi|poster|logo|wallpaper|meme)";
const IMAGE_INTENT_RE = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${IMG_VERB}\\s+(?:\\S+\\s+){0,2}?${IMG_NOUN}|gambarin|lukisin|imagine)(?![\\p{L}\\p{N}_])`,
    "iu"
);

const SAHUTAN = [
    "Yo, kenapa? 👋",
    "Hadir! Ada apa nih?",
    "Iya, kenapa?",
    "Kenapa, kenapa? 😄",
] as const;

function textOf(content: MessageContent | null | undefined): string {
    if (!content) return "";
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        ""
    );
}

/** Ambil contextInfo (info reply/quote) dari tipe pesan apa pun yang punya. */
function contextInfoOf(content: MessageContent): ContextInfo | undefined {
    const type = getContentType(content);
    if (!type) return undefined;
    const inner = content[type] as { contextInfo?: ContextInfo | null } | string | null | undefined;
    if (!inner || typeof inner === "string") return undefined;
    return inner.contextInfo ?? undefined;
}

// Apakah pesan ini nge-reply pesan yang dikirim bot?
function isReplyToBot(sock: WASocket, ctx: ContextInfo | undefined): boolean {
    if (!ctx) return false;
    if (ctx.stanzaId && sentIds.has(ctx.stanzaId)) return true;

    // Kalo bot jalan di nomor sendiri, reply ke chat lu sendiri != reply ke bot,
    // jadi cuma andalin sentIds (di atas).
    if (ALLOW_SELF || !ctx.participant) return false;

    // Dicek lewat nomor bot (id biasa + LID, buat Baileys v7). Tahan restart.
    const me = [sock.user?.id, sock.user?.lid]
        .filter((id): id is string => Boolean(id))
        .map(jidNormalizedUser);
    return me.includes(jidNormalizedUser(ctx.participant));
}

export default async function handleMessage(
    sock: WASocket,
    upsert: BaileysEventMap["messages.upsert"]
): Promise<void> {
    if (upsert.type !== "notify") return; // abaikan sync riwayat

    for (const msg of upsert.messages) {
        try {
            await handleOne(sock, msg);
        } catch (err) {
            console.error("❌ Gagal proses pesan:", err);
        }
    }
}

async function handleOne(sock: WASocket, msg: WAMessage): Promise<void> {
    if (!msg.message) return;

    const chat = msg.key.remoteJid;
    if (!chat || chat === "status@broadcast" || chat.endsWith("@newsletter")) return;

    // jangan bales pesan sendiri / hasil kirim bot (biar gak looping)
    if (msg.key.id && sentIds.has(msg.key.id)) return;
    if (msg.key.fromMe && !ALLOW_SELF) return;

    // abaikan pesan lama (numpuk pas bot offline)
    const ts = Number(msg.messageTimestamp);
    if (ts && Date.now() / 1000 - ts > MAX_MESSAGE_AGE_SEC) return;

    // buka bungkusan ephemeral / viewOnce / dll
    const content = normalizeMessageContent(msg.message);
    if (!content) return;

    const body = textOf(content);

    // pesan yang di-reply (kalo ada)
    const ctx = contextInfoOf(content);
    const quoted = normalizeMessageContent(ctx?.quotedMessage);
    const quotedText = textOf(quoted);

    // Dipanggil lewat nama ATAU nge-reply pesan bot
    const nameCalled = TRIGGER_RE.test(body);
    const replyToBot = isReplyToBot(sock, ctx);
    if (!nameCalled && !replyToBot) return;

    // reply ke bot tapi isinya kosong (stiker, reaksi, dll) → abaikan
    if (!nameCalled && !body && !content.imageMessage) return;

    // cooldown anti-spam
    const who = msg.key.participant || chat;
    const cdKey = `${chat}:${who}`;
    const now = Date.now();
    if (now - (lastReply.get(cdKey) || 0) < COOLDOWN_MS) return;
    lastReply.set(cdKey, now);
    if (lastReply.size > 500) lastReply.clear();

    const pushname = msg.pushName || "temen";

    // pertanyaan = isi pesan tanpa nama panggilan
    const question = body
        .replace(TRIGGER_RE_ALL, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,.:;!?\-–—]+|[\s,;:\-–—]+$/g, "")
        .trim();

    // kirim apa aja (teks / gambar), dan catat ID-nya
    const send = async (payload: AnyMessageContent): Promise<void> => {
        const sent = await sock.sendMessage(chat, payload, { quoted: msg });
        const sentId = sent?.key?.id;
        if (sentId) {
            sentIds.add(sentId);
            if (sentIds.size > 500) {
                const oldest = sentIds.values().next().value;
                if (oldest !== undefined) sentIds.delete(oldest);
            }
        }
    };
    const reply = (text: string): Promise<void> => send({ text });

    // indikator "sedang mengetik..."
    const typing = async (state: "composing" | "paused"): Promise<void> => {
        try {
            await sock.sendPresenceUpdate(state, chat);
        } catch {}
    };

    const quotedLabel = replyToBot && !nameCalled ? "Pesan lu sebelumnya" : "Pesan yang dibales";

    // Download gambar (dikirim langsung atau di-reply), dipakai buat analisis maupun edit
    const imageMsg = content.imageMessage || quoted?.imageMessage;
    let image: ImageInput | undefined;
    if (imageMsg) {
        try {
            const buffer = await downloadMediaMessage(
                { key: msg.key, message: { imageMessage: imageMsg } },
                "buffer",
                {},
                { logger: mediaLogger, reuploadRequest: sock.updateMediaMessage }
            );
            image = {
                mimeType: imageMsg.mimetype || "image/jpeg",
                data: buffer.toString("base64"),
            };
        } catch (err) {
            console.error("❌ Gagal download gambar:", err);
            return reply("Gambarnya gak kebuka nih, coba kirim ulang ya 😅");
        }
    }

    // 0) Minta dibikinin / diedit gambarnya → balas dengan gambar
    if (IMAGE_INTENT_RE.test(question)) {
        const prompt = [quotedText && `Konteks: "${quotedText}"`, question].filter(Boolean).join("\n");

        await typing("composing");
        const out = await generateImage({ text: prompt, image });
        await typing("paused");

        if (!out.ok) return reply(out.error);
        return send({
            image: out.image.buffer,
            mimetype: out.image.mimeType,
            ...(out.text ? { caption: out.text } : {}),
        });
    }

    // 1) Ada gambar (dikirim langsung atau di-reply) → analisis gambar
    if (image) {
        const extra = quotedText && !content.imageMessage ? `Konteks pesan yang dibales: "${quotedText}"\n` : "";
        const prompt = `${extra}${pushname}: ${question || "Ini gambar apa? Komentarin santai aja."}`;

        await typing("composing");
        const answer = await askAI({ text: prompt, image });
        await typing("paused");
        return reply(answer);
    }

    // 2) Nge-reply pesan teks
    if (quotedText) {
        const prompt =
            `${quotedLabel}: "${quotedText}"\n` +
            `${pushname}: ${question || "Tanggapin pesan itu."}`;

        await typing("composing");
        const answer = await askAI({ text: prompt });
        await typing("paused");
        return reply(answer);
    }

    // 3) Cuma manggil nama doang
    if (!question) {
        return reply(SAHUTAN[Math.floor(Math.random() * SAHUTAN.length)] ?? SAHUTAN[0]);
    }

    // 4) Perintah singkat tanpa AI (hemat kuota)
    switch (question.toLowerCase()) {
        case "halo":
        case "hai":
            return reply("Halo juga 👋");
        case "ping":
            return reply("Pong 🏓");
        case "mantap":
            return reply("Makan atap 😎");
    }

    // 5) Ngobrol biasa
    await typing("composing");
    const answer = await askAI({ text: `${pushname}: ${question}` });
    await typing("paused");
    return reply(answer);
}
