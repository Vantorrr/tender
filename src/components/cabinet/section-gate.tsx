"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ErrorState } from "@/components/empty-state";
import { sectionForPath } from "@/components/cabinet/nav";
import { userHasSection } from "@/lib/acl";
import { useStore } from "@/lib/store";

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
