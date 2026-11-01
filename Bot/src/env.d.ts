// Tipe untuk environment variable, biar process.env.XXX gak sembarangan.
declare namespace NodeJS {
    interface ProcessEnv {
        GEMINI_API_KEY?: string;
        GEMINI_MODELS?: string;
        GEMINI_IMAGE_MODELS?: string;
        PHONE_NUMBER?: string;
        ALLOW_SELF?: string;
        LOG_LEVEL?: string;
    }
}
