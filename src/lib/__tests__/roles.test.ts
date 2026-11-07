import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, DEFAULT_SECTIONS, ROLE_LABELS } from "@/lib/roles";
import { roleMatrix, userHasSection } from "@/lib/acl";
import type { User } from "@/lib/types";

const roles = Object.keys(ROLE_LABELS) as Array<keyof typeof ROLE_LABELS>;

function fakeUser(
  role: User["role"],
  sections = DEFAULT_SECTIONS[role]
): User {
  return {
    id: `u-${role}`,
    email: `${role}@test.local`,
    name: role,
    role,
    orgId: "org-alfa",
    blocked: false,
    sections,
    createdAt: new Date().toISOString(),
  };
}

describe("6-role matrix", () => {
  it("defines exactly six roles", () => {
    expect(roles).toHaveLength(6);
    expect(roles.sort()).toEqual(
      [
        "admin",
        "otvetstvennyy",
        "rukovoditel",
        "smetchik",
        "superadmin",
        "tender",
      ].sort()
    );
  });

  it("maps each role to a non-empty section set from ALL_SECTIONS", () => {
    const matrix = roleMatrix();
    for (const role of roles) {
      expect(matrix[role].length).toBeGreaterThan(0);
      for (const section of matrix[role]) {
        expect(ALL_SECTIONS).toContain(section);
      }
    }
  });

  it("enforces section ACL (tender cannot open dengi; smetchik cannot open zakupki)", () => {
    const tender = fakeUser("tender");
    const smetchik = fakeUser("smetchik");
    const admin = fakeUser("admin");
    expect(userHasSection(tender, "zakupki")).toBe(true);
    expect(userHasSection(tender, "dengi")).toBe(false);
    expect(userHasSection(smetchik, "raschety")).toBe(true);
    expect(userHasSection(smetchik, "zakupki")).toBe(false);
    expect(userHasSection(admin, "admin")).toBe(true);
    expect(userHasSection(admin, "gpr")).toBe(false);
  });

  it("superadmin bypasses stripped sections", () => {
    const superadmin = fakeUser("superadmin", []);
    expect(userHasSection(superadmin, "admin")).toBe(true);
    expect(userHasSection(superadmin, "dengi")).toBe(true);
  });
});
