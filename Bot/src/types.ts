/** Gambar input buat Gemini. `data` = base64 (tanpa prefix "data:..."). */
export interface ImageInput {
    mimeType: string;
    data: string;
}

export interface AskInput {
    text?: string;
    image?: ImageInput;
}

export interface GeneratedImage {
    mimeType: string;
    buffer: Buffer;
}

/** Hasil bikin/edit gambar. Cek `ok` dulu, TypeScript otomatis nyempitin tipenya. */
export type ImageResult =
    | { ok: true; image: GeneratedImage; text: string }
    | { ok: false; error: string };
