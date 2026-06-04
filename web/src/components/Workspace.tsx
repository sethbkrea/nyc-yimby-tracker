"use client";

import { useEffect, useState } from "react";
import Dashboard from "./Dashboard";
import { PropertiesPanel } from "./PropertiesPanel";
import { ResearchPanel } from "./ResearchPanel";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "properties", label: "Properties" },
  { id: "research", label: "Property Research" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const isTab = (s: string): s is TabId => TABS.some((t) => t.id === s);

export function Workspace() {
  const [tab, setTab] = useState<TabId>("dashboard");
  // Keep-alive: once a tab is opened we leave it mounted (hidden when inactive)
  // so switching back is instant and its state (results, scroll, search) sticks.
  const [visited, setVisited] = useState<Set<TabId>>(new Set(["dashboard"]));

  // Sync with the URL hash so tabs are deep-linkable and back/forward works —
  // all client-side, no server round-trip.
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.slice(1);
      if (isTab(h)) {
        setTab(h);
        setVisited((v) => (v.has(h) ? v : new Set(v).add(h)));
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  const select = (id: TabId) => {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    const target = id === "dashboard" ? window.location.pathname : `#${id}`;
    window.history.replaceState(null, "", target);
  };

  return (
    <div>
      <nav className="flex gap-1 mb-6 border-b border-neutral-800">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => select(t.id)}
              aria-current={active ? "page" : undefined}
              className={[
                "px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors",
                active
                  ? "text-white border-b-2 border-white -mb-px"
                  : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/50",
              ].join(" ")}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className={tab === "dashboard" ? "" : "hidden"}>
        {visited.has("dashboard") && <Dashboard />}
      </div>
      <div className={tab === "properties" ? "" : "hidden"}>
        {visited.has("properties") && <PropertiesPanel />}
      </div>
      <div className={tab === "research" ? "" : "hidden"}>
        {visited.has("research") && <ResearchPanel />}
      </div>
    </div>
  );
}
