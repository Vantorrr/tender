"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ErrorState } from "@/components/empty-state";
import { NAV_ITEMS } from "@/components/cabinet/nav";
import { userHasSection } from "@/lib/acl";
import type { SectionKey } from "@/lib/types";
import { useStore } from "@/lib/store";

function sectionForPath(pathname: string): SectionKey | null {
  const hit = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return hit?.section ?? null;
}

/** Blocks direct URL access when the role/sections matrix denies the section. */
export function SectionGate({ children }: { children: React.ReactNode }) {
  const { user } = useStore();
  const pathname = usePathname();
  if (!user) return null;
  const section = sectionForPath(pathname);
  if (!section) return <>{children}</>;
  if (userHasSection(user, section)) return <>{children}</>;
  return (
    <div className="space-y-4">
      <ErrorState
        title="Нет доступа к разделу"
        description={`Раздел «${section}» недоступен для вашей роли или был отозван.`}
      />
      <p className="text-center text-sm">
        <Link
          href="/cabinet"
          className="text-[var(--tk-copper-deep)] underline"
        >
          На главную кабинета
        </Link>
      </p>
    </div>
  );
}
