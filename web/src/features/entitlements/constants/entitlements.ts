import { type Plan } from "@langfuse/shared";

// Entitlements: Binary feature access
// Exported to silence @typescript-eslint/no-unused-vars v8 warning
// (used for type extraction via typeof, which is a legitimate pattern)
export const entitlements = [
  // features
  "rbac-project-roles",
  "cloud-billing",
  "cloud-spend-alerts",
  "cloud-multi-tenant-sso",
  "self-host-ui-customization",
  "self-host-allowed-organization-creators",
  "trace-deletion", // Not in use anymore, but necessary to use the TableAction type.
  "audit-logs",
  "data-retention",
  "scheduled-blob-exports",
  "prompt-protected-labels",
  "admin-api",
] as const;
export type Entitlement = (typeof entitlements)[number];

const cloudAllPlansEntitlements: Entitlement[] = [
  "cloud-billing",
  "trace-deletion",
];

const selfHostedAllPlansEntitlements: Entitlement[] = [
  "trace-deletion",
  "scheduled-blob-exports",
];

// Entitlement Limits: Limits on the number of resources that can be created/used
// Exported to silence @typescript-eslint/no-unused-vars v8 warning
// (used for type extraction via typeof, which is a legitimate pattern)
export const entitlementLimits = [
  "annotation-queue-count",
  "organization-member-count",
  "data-access-days",
  "model-based-evaluations-count-evaluators",
  "prompt-management-count-prompts",
  "project-count",
] as const;
export type EntitlementLimit = (typeof entitlementLimits)[number];

export type EntitlementLimits = Record<
  EntitlementLimit,
  | number // if limited
  | false // unlimited
>;

export const entitlementAccess: Record<
  Plan,
  {
    entitlements: Entitlement[];
    entitlementLimits: EntitlementLimits;
  }
> = {
  "cloud:developer": {
    entitlements: [...cloudAllPlansEntitlements],
    entitlementLimits: {
      "organization-member-count": 2,
      "data-access-days": 30,
      "annotation-queue-count": 1,
      "model-based-evaluations-count-evaluators": false,
      "prompt-management-count-prompts": false,
      "project-count": 3,
    },
  },
  "cloud:pro": {
    entitlements: [
      ...cloudAllPlansEntitlements,
      "rbac-project-roles",
      "audit-logs",
      "data-retention",
      "cloud-multi-tenant-sso",
      "prompt-protected-labels",
      "admin-api",
      "scheduled-blob-exports",
      "cloud-spend-alerts",
    ],
    entitlementLimits: {
      "annotation-queue-count": false,
      "organization-member-count": false,
      "data-access-days": 1095,
      "model-based-evaluations-count-evaluators": false,
      "prompt-management-count-prompts": false,
      "project-count": false,
    },
  },
  oss: {
    entitlements: selfHostedAllPlansEntitlements,
    entitlementLimits: {
      "annotation-queue-count": false,
      "organization-member-count": false,
      "data-access-days": false,
      "model-based-evaluations-count-evaluators": false,
      "prompt-management-count-prompts": false,
      "project-count": false,
    },
  },
  "self-hosted:enterprise": {
    entitlements: [
      ...selfHostedAllPlansEntitlements,
      "rbac-project-roles",
      "self-host-allowed-organization-creators",
      "self-host-ui-customization",
      "audit-logs",
      "data-retention",
      "prompt-protected-labels",
      "admin-api",
      "cloud-multi-tenant-sso",
    ],
    entitlementLimits: {
      "annotation-queue-count": false,
      "organization-member-count": false,
      "data-access-days": false,
      "model-based-evaluations-count-evaluators": false,
      "prompt-management-count-prompts": false,
      "project-count": false,
    },
  },
};
