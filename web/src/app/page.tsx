import Dashboard from "@/components/Dashboard";
import { auth, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">YIMBY Tracker</h1>
          <p className="text-sm text-neutral-400">Signed in as {session.user.email}</p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="text-sm text-neutral-400 hover:text-white">Sign out</button>
        </form>
      </header>
      <Dashboard />
    </main>
  );
}
