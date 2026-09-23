/**
 * Client IP from headers the platform sets itself. On Vercel only
 * `x-vercel-forwarded-for` / `x-real-ip` are trustworthy; a client can send
 * anything else (e.g. `cf-connecting-ip`) to dodge rate limits or forge the
 * audit log. Off Vercel (local, CI) the dev server sets `x-forwarded-for`.
 */
export const TRUSTED_IP_HEADERS: string[] = process.env.VERCEL
  ? ["x-vercel-forwarded-for", "x-real-ip"]
  : ["x-real-ip", "x-forwarded-for"];

export function clientIp(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  for (const h of TRUSTED_IP_HEADERS) {
    const v = headers.get(h)?.split(",")[0]?.trim();
    if (v) return v;
  }
  return null;
}
