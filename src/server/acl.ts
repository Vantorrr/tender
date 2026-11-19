/** Server re-export of shared ACL helpers (safe for API routes). */
export {
  assertGprWrite,
  assertOrgAccess,
  assertSection,
  effectiveSections,
  roleMatrix,
  userHasSection,
} from "@/lib/acl";
