import Dashboard from "@/components/Dashboard";

export default function Page() {
  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">YIMBY Tracker</h1>
        <p className="text-sm text-neutral-400">Trigger scrapes and browse the data.</p>
      </header>
      <Dashboard />
    </main>
  );
}
