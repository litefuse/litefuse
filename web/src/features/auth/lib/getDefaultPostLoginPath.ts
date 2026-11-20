import { env } from "@/src/env.mjs";
import { type User } from "next-auth";

/**
 * Resolves the default path after login when no explicit targetPath is set.
 * Prefers the first non-deleted project (demo org sorted last, matching the
 * organization overview). Falls back to the organization overview (`/`) when
 * the user has no projects.
 */
export function getDefaultPostLoginPath(
  user: User | null | undefined,
): string {
  if (!user?.organizations?.length) {
    return "/";
  }

  const organizations = [...user.organizations].sort((a, b) => {
    const isDemoA = env.NEXT_PUBLIC_DEMO_ORG_ID === a.id;
    const isDemoB = env.NEXT_PUBLIC_DEMO_ORG_ID === b.id;
    if (isDemoA) return 1;
    if (isDemoB) return -1;
    return 0;
  });

  for (const org of organizations) {
    const project = org.projects.find((p) => !p.deletedAt);
    if (project) {
      return `/project/${project.id}`;
    }
  }

  return "/";
}
