import "dotenv/config";
import { GoogleGenAI, ThinkingLevel, ApiError } from "@google/genai";
import type { GenerateContentConfig, Part } from "@google/genai";
import { PERSONA } from "./config.js";
import type { AskInput, ImageInput, ImageResult } from "./types.js";
import { errMessage, parseList } from "./utils.js";

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
    throw new Error(
        "GEMINI_API_KEY belum diisi. Bikin file .env (liat .env.example) lalu isi key dari https://aistudio.google.com/apikey"
    );
}

const ai = new GoogleGenAI({ apiKey });

// Dicoba berurutan. Kalo model pertama kena limit / error, lanjut ke berikutnya.
const MODELS = parseList(process.env.GEMINI_MODELS, "gemini-3.1-flash-lite");

// Model khusus bikin/edit gambar, dicoba berurutan juga.
// Cek nama model yang tersedia buat akun lu di https://aistudio.google.com
const IMAGE_MODELS = parseList(process.env.GEMINI_IMAGE_MODELS, "gemini-2.5-flash-image");

const TIMEOUT_MS = 90_000;
const TIMEOUT_WITH_IMAGE_MS = 60_000;
const IMAGE_TIMEOUT_MS = 90_000; // kalo bikin gambar sering 504, naikin ke 90_000

const GENERIC_ERROR = "Otak gw lagi error nih, coba lagi bentar ya 😅";

function statusOf(err: unknown): number | undefined {
    return err instanceof ApiError ? err.status : undefined;
}

function buildParts(text: string, image?: ImageInput): Part[] {
    const parts: Part[] = [];
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    parts.push({ text });
    return parts;
}

/**
 * Jawab teks (bisa plus gambar buat dianalisis).
 * Selalu return string, gak pernah throw.
 */
export default async function askAI({ text, image }: AskInput = {}): Promise<string> {
    const parts = buildParts(text || "Halo", image);

    let lastErr: unknown;

    for (const model of MODELS) {
        // Gemini 3.x: kalo ada gambar, mikirnya dikurangin biar gak kelamaan
        const config: GenerateContentConfig = {
            systemInstruction: PERSONA,
            httpOptions: { timeout: image ? TIMEOUT_WITH_IMAGE_MS : TIMEOUT_MS },
            ...(model.startsWith("gemini-3")
                ? {
                      thinkingConfig: {
                          thinkingLevel: image ? ThinkingLevel.LOW : ThinkingLevel.MEDIUM,
                      },
                  }
                : {}),
        };

        // 504/503 sering cuma sementara → coba 1x lagi di model yang sama
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await ai.models.generateContent({
                    model,
                    contents: [{ role: "user", parts }],
                    config,
                });

                const out = res.text?.trim();
                if (out) return out;

                const why = res.promptFeedback?.blockReason || res.candidates?.[0]?.finishReason || "kosong";
                lastErr = new Error(`Respon ${why}`);
                console.error(`[gemini:${model}] respon kosong (${why})`);
                break; // kosong bukan error sementara, gak usah diulang
            } catch (err) {
                lastErr = err;
                const status = statusOf(err);
                console.error(`[gemini:${model}] ${status ?? ""} ${errMessage(err).slice(0, 300)}`);

                // Key salah / gak punya akses: model lain juga bakal gagal, gak usah lanjut
                if (status === 400 || status === 401 || status === 403) {
                    console.error("⚠️  Cek GEMINI_API_KEY di .env (salah, dicabut, atau gak punya akses).");
                    return GENERIC_ERROR;
                }
                if (status === 503 || status === 504) continue; // ulang sekali
                break;
            }
        }
    }

    if (statusOf(lastErr) === 429) return "Waduh, jatah AI gw lagi abis nih. Coba lagi bentar ya 🙏";
    return GENERIC_ERROR;
}

/**
 * Bikin / edit gambar. Kalo `image` dikasih, hasilnya jadi edit dari gambar itu.
 * Gak pernah throw. Cek `result.ok` dulu: true → ada `image`, false → ada `error`.
 */
export async function generateImage({ text, image }: AskInput = {}): Promise<ImageResult> {
    const parts = buildParts(text || "Bikin gambar random yang bagus", image);

    let lastErr: unknown;

    for (const model of IMAGE_MODELS) {
        try {
            const res = await ai.models.generateContent({
                model,
                contents: [{ role: "user", parts }],
                config: {
                    responseModalities: ["TEXT", "IMAGE"],
                    httpOptions: { timeout: IMAGE_TIMEOUT_MS },
                },
            });

            let img: { mimeType: string; buffer: Buffer } | undefined;
            let caption = "";
            for (const p of res.candidates?.[0]?.content?.parts ?? []) {
                if (p.inlineData?.data) {
                    img ??= {
                        mimeType: p.inlineData.mimeType || "image/png",
                        buffer: Buffer.from(p.inlineData.data, "base64"),
                    };
                } else if (p.text) {
                    caption += p.text;
                }
            }

            if (img) return { ok: true, image: img, text: caption.trim() };

            const why = res.promptFeedback?.blockReason || res.candidates?.[0]?.finishReason || "kosong";
            lastErr = new Error(`Tanpa gambar: ${why}`);
            console.error(`[gemini-img:${model}] gak ada gambar (${why})`);
        } catch (err) {
            lastErr = err;
            const status = statusOf(err);
            console.error(`[gemini-img:${model}] ${status ?? ""} ${errMessage(err).slice(0, 300)}`);

            // Key salah / gak punya akses: model lain juga bakal gagal, gak usah lanjut
            if (status === 400 || status === 401 || status === 403) {
                console.error("⚠️  Cek GEMINI_API_KEY / akses model gambar di akun lu.");
                break;
            }
        }
    }

    if (statusOf(lastErr) === 429) {
        return { ok: false, error: "Waduh, jatah bikin gambar gw lagi abis. Coba lagi bentar ya 🙏" };
    }
    return {
        ok: false,
        error: "Gambarnya gagal dibikin nih (mungkin permintaannya ditolak AI). Coba ubah deskripsinya ya 😅",
    };
}
