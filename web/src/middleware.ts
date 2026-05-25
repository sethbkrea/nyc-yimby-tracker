import { auth } from "@/lib/auth";

// Gate every route — pages and API — behind a valid NextAuth session.
// Session.signIn callback already enforces the @bkrea.com domain rule,
// so reaching here with a session means the user is allowed.
export default auth((req) => {
  if (!req.auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "unauthenticated");
    return Response.redirect(url);
  }
});

export const config = {
  // Exclude static assets, the login page itself, and the NextAuth handler
  // (otherwise the sign-in flow couldn't complete).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth|login).*)"],
};
