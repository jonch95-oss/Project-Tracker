import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect only: if there is no session cookie at all, send the
 * person to sign in. Real authorization happens on the server for every
 * page and tRPC procedure.
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|login|forgot-password|reset-password|invite|install|manifest.webmanifest|icon|apple-icon|.*\\.(?:png|svg|ico|webp|jpg|woff2)$).*)"],
};
