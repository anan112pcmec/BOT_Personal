/** Ambil pesan dari nilai apa pun yang di-throw (di TS, `catch (err)` itu `unknown`). */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Pecah string "a, b, c" jadi array bersih, pake fallback kalo kosong. */
export function parseList(value: string | undefined, fallback: string): string[] {
    return (value || fallback)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
