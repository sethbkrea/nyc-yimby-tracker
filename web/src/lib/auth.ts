import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "bkrea.com").toLowerCase().trim();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  callbacks: {
    // Reject any Google account whose email isn't on the allowed domain.
    // Return a redirect URL string (NextAuth v5 syntax) carrying the rejected
    // email so the login page can show exactly what failed — no log spelunking.
    signIn({ user }) {
      const email = (user.email ?? "").toLowerCase().trim();
      console.warn(`[auth] sign-in attempt email=${email || "(none)"} expected=@${ALLOWED_DOMAIN}`);
      if (email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return true;
      }
      const reject = email || "no-email-returned";
      return `/login?error=domain&rejected=${encodeURIComponent(reject)}&expected=${encodeURIComponent(ALLOWED_DOMAIN)}`;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
