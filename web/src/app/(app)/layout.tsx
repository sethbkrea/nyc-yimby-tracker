import { requireUser, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();
  if (!session?.user?.email) redirect("/login");

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <header className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold">YIMBY Tracker</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-500">{session.user.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button className="text-sm text-neutral-400 hover:text-white transition-colors">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </main>
  );
}
