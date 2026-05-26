import { signIn, auth } from "@/lib/auth";
import { redirect } from "next/navigation";

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "bkrea.com").toLowerCase().trim();

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; rejected?: string; expected?: string }>;
}) {
  const session = await auth();
  if (session?.user?.email) redirect("/");
  const { error, rejected, expected } = await searchParams;

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md border border-neutral-800 rounded-lg p-8 bg-neutral-900/40">
        <h1 className="text-xl font-semibold mb-1">YIMBY Tracker</h1>
        <p className="text-sm text-neutral-400 mb-6">
          Sign in with your <code className="text-neutral-200">@{ALLOWED_DOMAIN}</code> Google account.
        </p>

        {error && (
          <div className="mb-4 p-3 border border-red-500/40 bg-red-500/10 rounded text-sm">
            <p className="text-red-300 font-medium mb-1">Sign-in failed.</p>
            {rejected ? (
              <>
                <p className="text-neutral-300">
                  Google returned: <code className="text-white bg-neutral-950 px-1 rounded">{rejected}</code>
                </p>
                <p className="text-neutral-300">
                  Allowed domain: <code className="text-white bg-neutral-950 px-1 rounded">@{expected || ALLOWED_DOMAIN}</code>
                </p>
                <p className="text-neutral-400 mt-2 text-xs">
                  If the rejected email is what you expected to use, the <code>ALLOWED_EMAIL_DOMAIN</code> env var on Vercel is misconfigured. Otherwise, the Google account picker grabbed a different account than you intended.
                </p>
              </>
            ) : (
              <p className="text-neutral-300">
                Error: <code className="text-white">{error}</code>
              </p>
            )}
          </div>
        )}

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full px-4 py-2 bg-white text-black rounded font-medium hover:bg-neutral-200"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  );
}
