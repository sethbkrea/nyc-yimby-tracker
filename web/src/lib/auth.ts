import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "bkrea.com").toLowerCase();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  callbacks: {
    // Reject any Google account whose email isn't on the allowed domain.
    signIn({ user }) {
      const email = (user.email ?? "").toLowerCase();
      const ok = email.endsWith(`@${ALLOWED_DOMAIN}`);
      if (!ok) {
        console.warn(`auth: rejected ${email} — not on @${ALLOWED_DOMAIN}`);
      }
      return ok;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",  // route auth errors back to the login page
  },
});
