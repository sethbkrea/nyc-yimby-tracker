import { signIn, auth } from "@/lib/auth";
import { redirect } from "next/navigation";

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN ?? "bkrea.com").toLowerCase();

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user?.email) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-sm border border-neutral-800 rounded-lg p-8 bg-neutral-900/40">
        <h1 className="text-xl font-semibold mb-1">YIMBY Tracker</h1>
        <p className="text-sm text-neutral-400 mb-6">
          Sign in with your <code className="text-neutral-200">@{ALLOWED_DOMAIN}</code> Google account.
        </p>
        {error && (
          <p className="text-sm text-red-400 mb-4">
            Sign-in failed. Only <code className="text-neutral-200">@{ALLOWED_DOMAIN}</code> accounts are allowed.
          </p>
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
