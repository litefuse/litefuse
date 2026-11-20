import { getDefaultPostLoginPath } from "@/src/features/auth/lib/getDefaultPostLoginPath";
import { env } from "@/src/env.mjs";
import { type User } from "next-auth";

const baseOrg = {
  role: "OWNER" as User["organizations"][number]["role"],
  cloudConfig: undefined,
  plan: "oss" as const,
  metadata: {},
  aiFeaturesEnabled: false,
};

const baseProject = {
  role: "OWNER" as User["organizations"][number]["projects"][number]["role"],
  retentionDays: null,
  hasTraces: false,
  deletedAt: null,
  metadata: {},
};

describe("getDefaultPostLoginPath", () => {
  const originalDemoOrgId = env.NEXT_PUBLIC_DEMO_ORG_ID;

  afterEach(() => {
    (env as { NEXT_PUBLIC_DEMO_ORG_ID?: string }).NEXT_PUBLIC_DEMO_ORG_ID =
      originalDemoOrgId;
  });

  it("returns / when user is missing", () => {
    expect(getDefaultPostLoginPath(null)).toBe("/");
    expect(getDefaultPostLoginPath(undefined)).toBe("/");
  });

  it("returns / when user has no organizations", () => {
    expect(
      getDefaultPostLoginPath({
        id: "u1",
        canCreateOrganizations: true,
        organizations: [],
        featureFlags: {} as User["featureFlags"],
      }),
    ).toBe("/");
  });

  it("returns / when organizations have no projects", () => {
    expect(
      getDefaultPostLoginPath({
        id: "u1",
        canCreateOrganizations: true,
        organizations: [
          { ...baseOrg, id: "org1", name: "Org 1", projects: [] },
        ],
        featureFlags: {} as User["featureFlags"],
      }),
    ).toBe("/");
  });

  it("returns / when all projects are deleted", () => {
    expect(
      getDefaultPostLoginPath({
        id: "u1",
        canCreateOrganizations: true,
        organizations: [
          {
            ...baseOrg,
            id: "org1",
            name: "Org 1",
            projects: [
              {
                ...baseProject,
                id: "p1",
                name: "Deleted",
                deletedAt: new Date(),
              },
            ],
          },
        ],
        featureFlags: {} as User["featureFlags"],
      }),
    ).toBe("/");
  });

  it("returns the first non-deleted project path", () => {
    expect(
      getDefaultPostLoginPath({
        id: "u1",
        canCreateOrganizations: true,
        organizations: [
          {
            ...baseOrg,
            id: "org1",
            name: "Org 1",
            projects: [
              {
                ...baseProject,
                id: "p-deleted",
                name: "Gone",
                deletedAt: new Date(),
              },
              { ...baseProject, id: "p-first", name: "First" },
              { ...baseProject, id: "p-second", name: "Second" },
            ],
          },
        ],
        featureFlags: {} as User["featureFlags"],
      }),
    ).toBe("/project/p-first");
  });

  it("prefers non-demo organization projects", () => {
    (env as { NEXT_PUBLIC_DEMO_ORG_ID?: string }).NEXT_PUBLIC_DEMO_ORG_ID =
      "demo-org";

    expect(
      getDefaultPostLoginPath({
        id: "u1",
        canCreateOrganizations: true,
        organizations: [
          {
            ...baseOrg,
            id: "demo-org",
            name: "Demo",
            projects: [{ ...baseProject, id: "demo-p", name: "Demo Project" }],
          },
          {
            ...baseOrg,
            id: "real-org",
            name: "Real",
            projects: [{ ...baseProject, id: "real-p", name: "Real Project" }],
          },
        ],
        featureFlags: {} as User["featureFlags"],
      }),
    ).toBe("/project/real-p");
  });
});
