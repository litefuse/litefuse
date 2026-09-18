import { type Role, type User } from "@langfuse/shared/src/db";
import { z } from "zod";

/**
 * Shared helpers for the SCIM 2.0 User endpoints
 * (`/api/public/scim/Users`, `/api/public/scim/Users/[id]`).
 *
 * The goal is that every endpoint (list / create / get / patch / put) returns
 * the *same* User representation, and that the multi-valued `roles` attribute
 * is parsed the same way everywhere. SCIM clients differ in how they encode it:
 *
 *   "roles": ["ADMIN"]                     // plain string array
 *   "roles": [{ "value": "ADMIN" }]        // complex array (Okta)
 *   "path": "roles", "value": "ADMIN"      // path-form PATCH with a scalar
 */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** Roles Litefuse accepts, i.e. the `Role` enum of the organization membership. */
export const SCIM_ROLE_VALUES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
  "NONE",
] as const;

const roleSchema = z.enum(SCIM_ROLE_VALUES);

/**
 * Privilege ranking used when a request carries more than one role. Higher means
 * more access; `NONE` is the weakest membership. A multi-valued `roles`
 * attribute is resolved to the **least** privileged entry (see
 * `parseRequestedRole`), so adding a group mapping can never silently escalate
 * someone's access.
 */
const ROLE_RANK: Record<Role, number> = {
  NONE: 0,
  VIEWER: 1,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

/**
 * Flatten every roles shape into a list of plain role strings.
 * Unknown entries (objects without `value`, numbers, …) are dropped.
 */
export function normalizeRoleList(input: unknown): string[] {
  const list = Array.isArray(input) ? input : [input];
  return list
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : (entry as { value?: unknown } | null | undefined)?.value,
    )
    .filter((value): value is string => typeof value === "string");
}

/**
 * The Litefuse role carried by the request, or `null` when the attribute was
 * absent, empty or contained no known role.
 *
 * A multi-valued `roles` attribute resolves to the **least privileged** valid
 * entry: IdPs push a group/role list, and picking the weakest one keeps a
 * misconfigured mapping or an extra group membership from granting more access
 * than intended. (Upstream Langfuse takes the first entry instead - a
 * deliberate, documented difference.)
 *
 * Callers decide what `null` means: PATCH rejects the whole operation (400),
 * PUT keeps the current role (a full-resource update must not fail on an
 * unknown role name), POST falls back to NONE.
 */
export function parseRequestedRole(input: unknown): Role | null {
  if (input === undefined || input === null) return null;
  const parsed = roleSchema.array().safeParse(normalizeRoleList(input));
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data.reduce((lowest, candidate) =>
    ROLE_RANK[candidate] < ROLE_RANK[lowest] ? candidate : lowest,
  );
}

/**
 * Resolve the display name from the shapes SCIM clients use:
 *
 *   "displayName": "Alice Riddler"                     // top level, preferred
 *   "name": { "formatted": "Alice Riddler" }
 *   "name": { "givenName": "Alice", "familyName": "R" }
 *   path form: path:"displayName" / "name.formatted" / "name.givenName"
 *
 * `currentName` is only consulted for the sub-path forms, where half of the name
 * is supplied and the other half has to be preserved. Returns the trimmed name,
 * or null when nothing usable was supplied.
 */
export function parseRequestedName({
  displayName,
  name,
  subAttribute,
  currentName,
}: {
  displayName?: unknown;
  name?: unknown;
  subAttribute?: string;
  currentName?: string | null;
}): string | null {
  const clean = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  // The dedicated display-name attribute always wins.
  const explicit = clean(displayName);
  if (explicit) return explicit;

  // `name` as an object: path-less form, or the path form with path:"name".
  if (typeof name === "object" && name !== null) {
    const parts = name as Record<string, unknown>;
    const formatted = clean(parts.formatted);
    if (formatted) return formatted;
    const given = clean(parts.givenName);
    const family = clean(parts.familyName);
    if (given || family) return [given, family].filter(Boolean).join(" ");
    return null;
  }

  // `name` as a scalar: the path form for a single sub-attribute.
  const scalar = clean(name);
  if (!scalar) return null;

  const existing = currentName?.trim() ?? "";
  if (subAttribute === "givenName") {
    const family = existing.split(/\s+/).slice(1).join(" ");
    return [scalar, family].filter(Boolean).join(" ");
  }
  if (subAttribute === "familyName") {
    const given = existing.split(/\s+/)[0] ?? "";
    return [given, scalar].filter(Boolean).join(" ");
  }
  // formatted / displayName / unknown sub-path: treat it as the whole name.
  return scalar;
}

/**
 * SCIM representation of a user as seen from one organization.
 *
 * `active` mirrors "has an organization membership": Litefuse has no separate
 * disabled flag, deprovisioning removes the membership.
 *
 * `roles` is returned as an array of plain strings rather than the complex
 * `[{ value }]` form of RFC 7643. IdP profile attributes are scalar typed, and a
 * string-array attribute (the usual Okta configuration) cannot hold objects -
 * sending objects makes the IdP fail while *reading* our response, which breaks
 * its user import with "Invalid value data type". Requests still accept both
 * shapes on the way in (see `normalizeRoleList`), so this only affects output.
 *
 * The display name is emitted both as the standard `displayName` attribute and
 * inside `name` (formatted + given/family split), so a client can map whichever
 * one its profile supports - both carry the same value.
 *
 * Attribute ownership: `userName` is the account key (it *is* `users.email`,
 * which is what RFC 7643 uniqueness and the IdP's "find by userName" lookup are
 * based on), `id`/`externalId` identify the account during its later lifecycle,
 * `displayName`/`name` carries the human name and `roles` carries the
 * organization role. `emails` is emitted for completeness but never written
 * (see the SCIM docs, 3.3).
 */
export function toScimUser({
  user,
  role,
  active,
}: {
  user: User;
  role: Role | null;
  active: boolean;
}) {
  const trimmedName = user.name?.trim();
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    // Identity anchor on both sides: our `id` is handed to the IdP as the
    // resource id *and* as `externalId`, so a client can keep its own link and
    // address the account by id (`/Users/{id}`, `filter=externalId eq "…"`)
    // instead of relying on `userName`.
    externalId: user.id,
    userName: user.email,
    displayName: user.name ?? undefined,
    name: {
      formatted: user.name,
      givenName: trimmedName?.split(/\s+/)[0] ?? user.email,
      familyName: trimmedName?.split(/\s+/).slice(1).join(" ") || "SCIM",
    },
    active,
    roles: active && role ? [role] : [],
    // Convenience flat field for clients that map a single string attribute.
    role: active && role ? role : undefined,
    emails: [
      {
        primary: true,
        value: user.email,
        type: "work",
      },
    ],
    meta: {
      resourceType: "User",
      created: user.createdAt?.toISOString(),
      lastModified: user.updatedAt?.toISOString(),
    },
  };
}
