import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Calculator,
  FolderKanban,
  Scale,
  Settings2,
  Users,
  Warehouse,
} from "lucide-react";
import type { SectionKey } from "@/lib/types";

export interface NavItem {
  section: SectionKey;
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Stage-1 matryoshka: Documents / GPR / Money / Risks live inside the
 * procurement card — not as top-level sidebar items. Estimate exchange
 * lives under Справочники.
 */
export const NAV_ITEMS: NavItem[] = [
  { section: "zakupki", href: "/cabinet/zakupki", label: "Закупки", icon: FolderKanban },
  { section: "raschety", href: "/cabinet/raschety", label: "Расчёты", icon: Calculator },
  {
    section: "proizvodstvo",
    href: "/cabinet/proizvodstvo",
    label: "Производство",
    icon: Warehouse,
  },
  {
    section: "spravochniki",
    href: "/cabinet/spravochniki",
    label: "Справочники",
    icon: BookOpen,
  },
  {
    section: "polzovateli",
    href: "/cabinet/polzovateli",
    label: "Пользователи",
    icon: Users,
  },
  { section: "admin", href: "/cabinet/admin", label: "Админ", icon: Settings2 },
  {
    section: "instrukciya",
    href: "/cabinet/instrukciya",
    label: "Инструкция",
    icon: Scale,
  },
];

/** Deep-link sections still gated by ACL but not shown in sidebar. */
export const NESTED_SECTIONS: SectionKey[] = [
  "dokumenty",
  "gpr",
  "dengi",
  "riski",
  "obmen",
];

/** All routable cabinet sections for ACL (sidebar + nested deep-links). */
export const SECTION_ROUTES: Array<{ section: SectionKey; href: string }> = [
  ...NAV_ITEMS.map((item) => ({ section: item.section, href: item.href })),
  { section: "dokumenty", href: "/cabinet/dokumenty" },
  { section: "gpr", href: "/cabinet/gpr" },
  { section: "dengi", href: "/cabinet/dengi" },
  { section: "riski", href: "/cabinet/riski" },
  { section: "obmen", href: "/cabinet/obmen" },
];

export function sectionForPath(pathname: string): SectionKey | null {
  const ordered = [...SECTION_ROUTES].sort(
    (a, b) => b.href.length - a.href.length
  );
  const hit = ordered.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );
  return hit?.section ?? null;
}
