import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Calculator,
  CalendarRange,
  FileText,
  FolderKanban,
  Landmark,
  Scale,
  Settings2,
  ShieldAlert,
  Users,
  Warehouse,
  ArrowLeftRight,
} from "lucide-react";
import type { SectionKey } from "@/lib/types";

export interface NavItem {
  section: SectionKey;
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { section: "zakupki", href: "/cabinet/zakupki", label: "Закупки", icon: FolderKanban },
  { section: "dokumenty", href: "/cabinet/dokumenty", label: "Документы", icon: FileText },
  { section: "raschety", href: "/cabinet/raschety", label: "Расчёты", icon: Calculator },
  { section: "gpr", href: "/cabinet/gpr", label: "ГПР", icon: CalendarRange },
  { section: "dengi", href: "/cabinet/dengi", label: "Деньги", icon: Landmark },
  { section: "riski", href: "/cabinet/riski", label: "Риски", icon: ShieldAlert },
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
    section: "obmen",
    href: "/cabinet/obmen",
    label: "Обмен со сметным ПО",
    icon: ArrowLeftRight,
  },
  {
    section: "instrukciya",
    href: "/cabinet/instrukciya",
    label: "Инструкция",
    icon: Scale,
  },
];
