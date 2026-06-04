"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Dashboard",         href: "/" },
  { label: "Property Research", href: "/research" },
] as const;

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 mb-6 border-b border-neutral-800">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={[
              "px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors",
              active
                ? "text-white border-b-2 border-white -mb-px"
                : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/50",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
