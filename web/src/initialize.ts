import { env } from "@/src/env.mjs";
import { createUserEmailPassword } from "@/src/features/auth-credentials/lib/credentialsServerUtils";
import { prisma } from "@langfuse/shared/src/db";
import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { getOrganizationPlanServerSide } from "@/src/features/entitlements/server/getPlan";
import { CloudConfigSchema } from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";

// Warn if LITEFUSE_INIT_* variables are set but LITEFUSE_INIT_ORG_ID is missing
if (!env.LITEFUSE_INIT_ORG_ID) {
  const setInitVars = [
    env.LITEFUSE_INIT_ORG_NAME && "LITEFUSE_INIT_ORG_NAME",
    env.LITEFUSE_INIT_ORG_CLOUD_PLAN && "LITEFUSE_INIT_ORG_CLOUD_PLAN",
    env.LITEFUSE_INIT_PROJECT_ID && "LITEFUSE_INIT_PROJECT_ID",
    env.LITEFUSE_INIT_PROJECT_NAME && "LITEFUSE_INIT_PROJECT_NAME",
    env.LITEFUSE_INIT_PROJECT_RETENTION && "LITEFUSE_INIT_PROJECT_RETENTION",
    env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY && "LITEFUSE_INIT_PROJECT_PUBLIC_KEY",
    env.LITEFUSE_INIT_PROJECT_SECRET_KEY && "LITEFUSE_INIT_PROJECT_SECRET_KEY",
    env.LITEFUSE_INIT_USER_EMAIL && "LITEFUSE_INIT_USER_EMAIL",
    env.LITEFUSE_INIT_USER_NAME && "LITEFUSE_INIT_USER_NAME",
    env.LITEFUSE_INIT_USER_PASSWORD && "LITEFUSE_INIT_USER_PASSWORD",
  ].filter(Boolean) as string[];

  if (setInitVars.length > 0) {
    logger.warn(
      `[Litefuse Init] LITEFUSE_INIT_ORG_ID is not set but other LITEFUSE_INIT_* variables are configured. ` +
        `The following variables will be ignored: ${setInitVars.join(", ")}. ` +
        `Set LITEFUSE_INIT_ORG_ID to enable initialization.`,
    );
  }
}

// Create Organization
if (env.LITEFUSE_INIT_ORG_ID) {
  const cloudConfig = env.LITEFUSE_INIT_ORG_CLOUD_PLAN
    ? CloudConfigSchema.parse({
        plan: env.LITEFUSE_INIT_ORG_CLOUD_PLAN,
      })
    : undefined;

  const org = await prisma.organization.upsert({
    where: { id: env.LITEFUSE_INIT_ORG_ID },
    update: {},
    create: {
      id: env.LITEFUSE_INIT_ORG_ID,
      name: env.LITEFUSE_INIT_ORG_NAME ?? "Provisioned Org",
      cloudConfig,
    },
  });

  // Warn about partial configurations
  const hasPublicKey = Boolean(env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY);
  const hasSecretKey = Boolean(env.LITEFUSE_INIT_PROJECT_SECRET_KEY);
  const hasEmail = Boolean(env.LITEFUSE_INIT_USER_EMAIL);
  const hasPassword = Boolean(env.LITEFUSE_INIT_USER_PASSWORD);

  // Partial API key config
  if (hasPublicKey !== hasSecretKey) {
    const missingKey = hasPublicKey
      ? "LITEFUSE_INIT_PROJECT_SECRET_KEY"
      : "LITEFUSE_INIT_PROJECT_PUBLIC_KEY";
    logger.warn(
      `[Litefuse Init] Partial API key configuration: ${missingKey} is not set. ` +
        `Both LITEFUSE_INIT_PROJECT_PUBLIC_KEY and LITEFUSE_INIT_PROJECT_SECRET_KEY must be set to create API keys.`,
    );
  }

  // API keys without project ID
  if ((hasPublicKey || hasSecretKey) && !env.LITEFUSE_INIT_PROJECT_ID) {
    logger.warn(
      `[Litefuse Init] LITEFUSE_INIT_PROJECT_ID is not set but API key variables are configured. ` +
        `API keys will not be created. Set LITEFUSE_INIT_PROJECT_ID to enable API key creation.`,
    );
  }

  // Partial user config
  if (hasEmail !== hasPassword) {
    const missingVar = hasEmail
      ? "LITEFUSE_INIT_USER_PASSWORD"
      : "LITEFUSE_INIT_USER_EMAIL";
    logger.warn(
      `[Litefuse Init] Partial user configuration: ${missingVar} is not set. ` +
        `Both LITEFUSE_INIT_USER_EMAIL and LITEFUSE_INIT_USER_PASSWORD must be set to create a user.`,
    );
  }

  // Create Project: Org -> Project
  if (env.LITEFUSE_INIT_PROJECT_ID) {
    let retentionDays: number | null = null;
    const hasRetentionEntitlement = hasEntitlementBasedOnPlan({
      plan: getOrganizationPlanServerSide(),
      entitlement: "data-retention",
    });
    if (env.LITEFUSE_INIT_PROJECT_RETENTION && hasRetentionEntitlement) {
      retentionDays = env.LITEFUSE_INIT_PROJECT_RETENTION;
    }

    await prisma.project.upsert({
      where: { id: env.LITEFUSE_INIT_PROJECT_ID },
      update: {},
      create: {
        id: env.LITEFUSE_INIT_PROJECT_ID,
        name: env.LITEFUSE_INIT_PROJECT_NAME ?? "Provisioned Project",
        orgId: org.id,
        retentionDays,
      },
    });

    // Add API Keys: Project -> API Key
    if (
      env.LITEFUSE_INIT_PROJECT_SECRET_KEY &&
      env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY
    ) {
      const existingApiKey = await prisma.apiKey.findUnique({
        where: { publicKey: env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY },
      });

      // Delete key if project changed
      if (
        existingApiKey &&
        existingApiKey.projectId !== env.LITEFUSE_INIT_PROJECT_ID
      ) {
        await prisma.apiKey.delete({
          where: { publicKey: env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY },
        });
      }

      // Create new key if it doesn't exist or project changed
      if (
        !existingApiKey ||
        existingApiKey.projectId !== env.LITEFUSE_INIT_PROJECT_ID
      ) {
        await createAndAddApiKeysToDb({
          prisma,
          entityId: env.LITEFUSE_INIT_PROJECT_ID,
          note: "Provisioned API Key",
          scope: "PROJECT",
          predefinedKeys: {
            secretKey: env.LITEFUSE_INIT_PROJECT_SECRET_KEY,
            publicKey: env.LITEFUSE_INIT_PROJECT_PUBLIC_KEY,
          },
        });
      }
    }
  }

  // Create User: Org -> User
  if (env.LITEFUSE_INIT_USER_EMAIL && env.LITEFUSE_INIT_USER_PASSWORD) {
    const email = env.LITEFUSE_INIT_USER_EMAIL.toLowerCase();
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    let userId = existingUser?.id;

    // Create user if it doesn't exist yet
    if (!userId) {
      userId = await createUserEmailPassword(
        email,
        env.LITEFUSE_INIT_USER_PASSWORD,
        env.LITEFUSE_INIT_USER_NAME ?? "Provisioned User",
      );
    }

    // Create OrgMembership: Org -> OrgMembership <- User
    const orgMembership = await prisma.organizationMembership.upsert({
      where: {
        orgId_userId: { userId, orgId: org.id },
      },
      update: { role: "OWNER" },
      create: {
        userId,
        orgId: org.id,
        role: "OWNER",
      },
    });

    // On EE plans with rbac-project-roles, createUserEmailPassword ->
    // createProjectMembershipsOnSignup may have already created a ProjectMembership
    // with LITEFUSE_DEFAULT_PROJECT_ROLE (e.g. VIEWER) before the OrgMembership was
    // set to OWNER above. Correct it to OWNER for the init user on the init project.
    if (
      env.LITEFUSE_INIT_PROJECT_ID &&
      hasEntitlementBasedOnPlan({
        plan: getOrganizationPlanServerSide(cloudConfig),
        entitlement: "rbac-project-roles",
      })
    ) {
      await prisma.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: env.LITEFUSE_INIT_PROJECT_ID,
            userId,
          },
        },
        update: { role: "OWNER" },
        create: {
          userId,
          orgMembershipId: orgMembership.id,
          projectId: env.LITEFUSE_INIT_PROJECT_ID,
          role: "OWNER",
        },
      });
    }
  }
}
