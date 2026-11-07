import { DEFAULT_SECTIONS } from "@/lib/roles";
import type { Role, SectionKey, User } from "@/lib/types";

/** Effective sections for a user (custom list or role defaults). */
export function effectiveSections(user: User): SectionKey[] {
  if (user.sections?.length) return user.sections;
  return DEFAULT_SECTIONS[user.role] ?? [];
}

export function userHasSection(user: User, section: SectionKey): boolean {
  if (user.role === "superadmin") return true;
  return effectiveSections(user).includes(section);
}

export function assertSection(user: User, section: SectionKey): void {
  if (!userHasSection(user, section)) {
    throw new Error(`Недостаточно прав для раздела «${section}»`);
  }
}

export function assertOrgAccess(
  user: User,
  orgId: string,
  label = "записи"
): void {
  if (user.role === "superadmin") return;
  if (orgId !== user.orgId) {
    throw new Error(`Нет доступа к данным другой организации (${label})`);
  }
}

/** Role matrix snapshot for docs/tests — mirrors DEFAULT_SECTIONS. */
export function roleMatrix(): Record<Role, SectionKey[]> {
  return { ...DEFAULT_SECTIONS };
}
