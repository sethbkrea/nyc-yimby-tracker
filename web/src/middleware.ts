import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// Canonical URL — set this to your production domain. Any visitor on a
// different host (Vercel preview hash, custom alias, etc.) is bounced here.
// Set via NEXT_PUBLIC_CANONICAL_URL; falls back to Vercel's auto-set
// VERCEL_PROJECT_PRODUCTION_URL.
const CANONICAL_HOST = (() => {
  const url = process.env.NEXT_PUBLIC_CANONICAL_URL ?? "";
  if (url) return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "";
})();

function isAuthPath(pathname: string): boolean {
  return pathname.startsWith("/login") || pathname.startsWith("/api/auth");
}

export default auth((req) => {
  const url = req.nextUrl;
  const host = url.host;

  // 1) Canonical host enforcement — applies to every route so OAuth never
  // starts from a preview URL. NextAuth's redirect_uri is built from the
  // host of the originating request; if the user is on a preview URL when
  // they click Sign in, Google sees an unrecognized redirect_uri and 400s.
  // Forcing canonical-only access prevents that entirely.
  if (
    CANONICAL_HOST &&
    host !== CANONICAL_HOST &&
    !host.startsWith("localhost") &&
    !host.startsWith("127.0.0.1")
  ) {
    const dest = url.clone();
    dest.host = CANONICAL_HOST;
    dest.protocol = "https:";
    dest.port = "";
    return NextResponse.redirect(dest, 308);
  }

  // 2) Auth gate — skip /login and /api/auth themselves so sign-in can run.
  if (isAuthPath(url.pathname)) return;

  if (!req.auth) {
    const login = url.clone();
    login.pathname = "/login";
    return NextResponse.redirect(login);
  }
});

export const config = {
  // Include /login and /api/auth in the matcher so the canonical redirect
  // (rule 1 above) applies to them too. Auth bypass for those paths is
  // handled inside the handler via isAuthPath().
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
