/** Server re-export of shared ACL helpers (safe for API routes). */
export {
  assertOrgAccess,
  assertSection,
  effectiveSections,
  roleMatrix,
  userHasSection,
} from "@/lib/acl";
