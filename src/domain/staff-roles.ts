import {
  effectivePermissions, isSensitivePermission, isStaffPermission, isSystemRole, PERMISSION_CATALOGUE, SYSTEM_ROLES,
  systemRolePermissions, type StaffActor, type StaffPermission
} from "./staff-access";

/**
 * Admin-managed staff roles. Built-in roles are fixed in code. Custom roles are made in /staff/roles by a super admin, stored insert-only
 * (one row per version) and always carry the `custom_` prefix, so a custom key can never look like or collide with a built-in role.
 */
export const CUSTOM_ROLE_RE = /^custom_[a-z0-9_]{2,40}$/;
export const isRoleKey = (v: unknown): v is string => isSystemRole(v) || (typeof v === "string" && CUSTOM_ROLE_RE.test(v));

export interface RoleDef {
  key: string; label: string; description: string; permissions: readonly StaffPermission[];
  isSystem: boolean; disabled: boolean; version: number;
}

/** Built-in roles as role definitions (their permissions come from the fixed matrix, never from the database). */
export const SYSTEM_ROLE_DEFS: readonly RoleDef[] = SYSTEM_ROLES.map(r => ({
  key: r.key, label: r.label, description: r.description, permissions: systemRolePermissions(r.key), isSystem: true, disabled: false, version: 1
}));

/** Known permissions only, de-duplicated, in catalogue order. Anything unknown in the database is ignored (fail closed). */
export function cleanPermissions(v: unknown): StaffPermission[] {
  const set = new Set(Array.isArray(v) ? v.filter(isStaffPermission) : []);
  return PERMISSION_CATALOGUE.map(p => p.key).filter(k => set.has(k));
}

/** The permissions a role grants: built-in from code, custom from its current definition, none if disabled. */
export const rolePermissions = (r: RoleDef): readonly StaffPermission[] =>
  r.isSystem ? systemRolePermissions(r.key) : r.disabled ? [] : r.permissions;

/** The current database definition of a custom role (latest version), as read on each request. */
export interface StoredRole { exists: boolean; permissions: unknown; disabled: unknown }

/**
 * The staff member for an invite's role key. Built-in: the fixed matrix. Custom: permissions from the stored definition; a disabled
 * role grants nothing; a missing definition or a malformed key gives no staff member at all.
 */
export function resolveRoleAccess(id: string, roleKey: unknown, stored: StoredRole | null): StaffActor | null {
  if (isSystemRole(roleKey)) return { id, role: roleKey };
  if (!isRoleKey(roleKey) || !stored?.exists) return null;
  return { id, role: roleKey, permissions: stored.disabled === false ? cleanPermissions(stored.permissions) : [] };
}

// ---- Input ----

const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'(),./-]{0,59}$/u;
/** Control characters, invisible format characters (bidi overrides, zero width) and markup are never accepted. */
const BAD_TEXT_RE = /[\p{Cc}\p{Cf}<>]/u;

export function cleanLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").trim().replace(/ {2,}/g, " ");
  return LABEL_RE.test(s) && !BAD_TEXT_RE.test(s) ? s : null;
}
export function cleanDescription(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").trim();
  return s.length <= 300 && !BAD_TEXT_RE.test(s.replace(/\n/g, " ")) ? s : null;
}

export interface RoleInput { label: string; description: string; permissions: StaffPermission[] }
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parsePermissionList(v: unknown): Parsed<StaffPermission[]> {
  if (!Array.isArray(v) || v.length > PERMISSION_CATALOGUE.length * 2) return { ok: false, error: "Permissions must be a list." };
  const bad = v.find(p => !isStaffPermission(p));
  if (bad !== undefined) return { ok: false, error: "Unknown permission." };
  return { ok: true, value: cleanPermissions(v) };
}

function parseFields(b: Record<string, unknown>): Parsed<RoleInput> {
  const label = cleanLabel(b["label"]);
  if (!label) return { ok: false, error: "Enter a name of up to 60 letters, numbers and simple punctuation." };
  const description = cleanDescription(b["description"]);
  if (description === null) return { ok: false, error: "The description must be plain text of up to 300 characters." };
  const perms = parsePermissionList(b["permissions"]);
  return perms.ok ? { ok: true, value: { label, description, permissions: perms.value } } : perms;
}

export function parseRoleCreate(b: Record<string, unknown> | null): Parsed<RoleInput & { key: string }> {
  if (!b) return { ok: false, error: "Send a JSON object." };
  const key = b["key"];
  if (typeof key !== "string" || !CUSTOM_ROLE_RE.test(key)) {
    return { ok: false, error: "The key must start with custom_ and use 2 to 40 lower-case letters, digits or underscores." };
  }
  const f = parseFields(b);
  return f.ok ? { ok: true, value: { key, ...f.value } } : f;
}

export type RoleChange =
  | { action: "update"; expectedVersion: number; input: RoleInput }
  | { action: "disable" | "enable"; expectedVersion: number };

export function parseRoleChange(b: Record<string, unknown> | null): Parsed<RoleChange> {
  if (!b) return { ok: false, error: "Send a JSON object." };
  const action = b["action"];
  const v = b["expectedVersion"];
  if (action !== "update" && action !== "disable" && action !== "enable") return { ok: false, error: "Unknown action." };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { ok: false, error: "expectedVersion is required." };
  if (action !== "update") return { ok: true, value: { action, expectedVersion: v } };
  const f = parseFields(b);
  return f.ok ? { ok: true, value: { action, expectedVersion: v, input: f.value } } : f;
}

// ---- Rules ----

export type RoleDenyReason = "not_super_admin" | "not_found" | "system_role" | "own_role" | "escalation" | "stale" | "unchanged" | "exists" | "disabled" | "sensitive" | "outranked";
export type RolePlan<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; reason: RoleDenyReason };
const no = (status: number, error: string, reason: RoleDenyReason) => ({ ok: false as const, status, error, reason });

const isSuperAdmin = (a: StaffActor) => a.role === "super_admin";
const missingFrom = (want: readonly StaffPermission[], have: readonly StaffPermission[]) => want.filter(p => !have.includes(p));

export interface RoleDiff { added: StaffPermission[]; removed: StaffPermission[] }

/** Only a super admin creates roles, and only with permissions they hold themselves. */
export function planRoleCreate(actor: StaffActor, input: RoleInput & { key: string }, existing: RoleDef | null): RolePlan<RoleDiff> {
  if (!isSuperAdmin(actor)) return no(403, "Only a super admin can manage roles.", "not_super_admin");
  if (isSystemRole(input.key)) return no(409, "That is a built-in role.", "system_role");
  if (existing) return no(409, "A role with that key already exists.", "exists");
  if (missingFrom(input.permissions, effectivePermissions(actor)).length > 0) {
    return no(403, "You cannot grant a permission you do not hold yourself.", "escalation");
  }
  return { ok: true, added: [...input.permissions], removed: [] };
}

/**
 * Editing, disabling or enabling a custom role. Super admin only; never a built-in role; never the role you hold yourself; never adds a
 * permission you lack; and `expectedVersion` must match the current version, so of two concurrent edits only the first is saved.
 */
export function planRoleChange(actor: StaffActor, current: RoleDef | null, change: RoleChange): RolePlan<RoleDiff & { next: Omit<RoleDef, "isSystem"> }> {
  if (current && current.key === actor.role) return no(409, "You cannot change the role you hold yourself.", "own_role");
  if (!isSuperAdmin(actor)) return no(403, "Only a super admin can manage roles.", "not_super_admin");
  if (!current) return no(404, "Role not found.", "not_found");
  if (current.isSystem || isSystemRole(current.key)) return no(409, "Built-in roles cannot be changed, disabled or deleted.", "system_role");
  if (change.expectedVersion !== current.version) return no(409, "Someone else changed this role. Reload and try again.", "stale");
  const next = {
    key: current.key, version: current.version + 1,
    label: change.action === "update" ? change.input.label : current.label,
    description: change.action === "update" ? change.input.description : current.description,
    permissions: change.action === "update" ? change.input.permissions : [...current.permissions],
    disabled: change.action === "update" ? current.disabled : change.action === "disable"
  };
  const added = missingFrom(next.permissions, current.permissions);
  const removed = missingFrom(current.permissions, next.permissions);
  if (missingFrom(added, effectivePermissions(actor)).length > 0 || (!next.disabled && current.disabled && missingFrom(next.permissions, effectivePermissions(actor)).length > 0)) {
    return no(403, "You cannot grant a permission you do not hold yourself.", "escalation");
  }
  if (added.length === 0 && removed.length === 0 && next.label === current.label && next.description === current.description && next.disabled === current.disabled) {
    return no(409, "Nothing changed.", "unchanged");
  }
  return { ok: true, added, removed, next };
}

/**
 * Whether `actor` may give someone `role` (invite or role change). The role must exist and be enabled; the actor must hold every
 * permission it grants (no escalation); a role with any sensitive permission, or super admin itself, needs a super admin.
 */
export function planRoleAssign(actor: StaffActor, role: RoleDef | null): RolePlan {
  if (!role) return no(400, "Choose a role.", "not_found");
  if (role.disabled) return no(409, "That role is disabled.", "disabled");
  const grants = rolePermissions(role);
  if (missingFrom(grants, effectivePermissions(actor)).length > 0) return no(403, "You cannot give access you do not hold yourself.", "escalation");
  if (!isSuperAdmin(actor) && (role.key === "super_admin" || grants.some(isSensitivePermission))) {
    return no(403, "Only a super admin can assign a role with sensitive access.", "sensitive");
  }
  return { ok: true };
}

/** Changing or revoking someone's access needs at least the access they hold, so a lesser admin cannot remove a greater one. */
export function planOutrank(actor: StaffActor, targetRole: RoleDef | null): RolePlan {
  const theirs = targetRole ? rolePermissions(targetRole) : [];
  if (targetRole?.key === "super_admin" && !isSuperAdmin(actor)) return no(403, "Only a super admin can change a super admin's access.", "outranked");
  if (missingFrom(theirs, effectivePermissions(actor)).length > 0) return no(403, "You cannot change the access of someone who holds access you do not.", "outranked");
  return { ok: true };
}

// ---- Access review export ----

export interface AccessReviewInput { inviteId: string; email: string; role: string; acceptedAt: string | null }
export const ACCESS_REVIEW_HEADER = ["Invite", "Email", "Role key", "Role", "Role type", "Role version", "Role status", "Signed in", "Permission", "Permission label", "Sensitive"] as const;

/** One row per staff member and permission (a staff member with no access gets one row with an empty permission). */
export function accessReviewRows(staff: readonly AccessReviewInput[], roles: readonly RoleDef[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const s of staff) {
    const r = roles.find(x => x.key === s.role) ?? null;
    const status = !r ? "unknown (no access)" : r.disabled ? "disabled (no access)" : "active";
    const base = [s.inviteId, s.email, s.role, r?.label ?? "", r?.isSystem ? "built-in" : "custom", r?.version ?? "", status, s.acceptedAt ?? "not yet"];
    const perms = r ? rolePermissions(r) : [];
    if (perms.length === 0) rows.push([...base, "", "", ""]);
    for (const p of PERMISSION_CATALOGUE) {
      if (perms.includes(p.key)) rows.push([...base, p.key, p.label, p.sensitive ? "yes" : "no"]);
    }
  }
  return rows;
}

/** The permissions of a role grouped by area, for "what can this role do". */
export function accessSummary(perms: readonly StaffPermission[]): { area: string; items: { key: StaffPermission; label: string; sensitive: boolean }[] }[] {
  const out: { area: string; items: { key: StaffPermission; label: string; sensitive: boolean }[] }[] = [];
  for (const p of PERMISSION_CATALOGUE) {
    if (!perms.includes(p.key)) continue;
    let g = out.find(x => x.area === p.area);
    if (!g) { g = { area: p.area, items: [] }; out.push(g); }
    g.items.push({ key: p.key, label: p.label, sensitive: p.sensitive });
  }
  return out;
}
