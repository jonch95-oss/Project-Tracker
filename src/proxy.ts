import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 1. Production answers on one canonical host (APP_URL), so passkeys (bound
 *    to that host), cookies and links always match. Other production hosts
 *    (the unique deployment URL, older aliases) redirect there. APIs are left
 *    alone so Vercel Cron and webhooks keep working on any host.
 * 2. Optimistic sign-in redirect: with no session cookie, go to /login and
 *    come back to the requested page afterwards. Real authorization happens
 *    on the server for every page and tRPC procedure.
 */
export function proxy(request: NextRequest) {
  const canonical = process.env.VERCEL_ENV === "production" ? process.env.APP_URL : undefined;
  if (canonical && !request.nextUrl.pathname.startsWith("/api/")) {
    const target = new URL(canonical);
    if (request.nextUrl.host !== target.host) {
      const url = new URL(request.nextUrl.pathname + request.nextUrl.search, target);
      return NextResponse.redirect(url, 308);
    }
  }

  if (isPublic(request.nextUrl.pathname)) return NextResponse.next();
  if (!getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

const PUBLIC_PREFIXES = ["/login", "/setup", "/forgot-password", "/reset-password", "/invite", "/install", "/guide"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const config = {
  matcher: ["/((?!api|_next|sw\\.js|robots\\.txt|manifest.webmanifest|offline\\.html|icon|apple-icon|.*\\.(?:png|svg|ico|webp|jpg|woff2)$).*)"],
};
