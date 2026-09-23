/**
 * Only same-origin, absolute paths may be used as a post-sign-in destination
 * (no "//evil.com", no "https://…", no backslash tricks).
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  if (next.startsWith("/login") || next.startsWith("/setup")) return fallback;
  return next;
}
