/** @jest-environment node */

jest.mock("@langfuse/shared/src/server", () => {
  const originalModule = jest.requireActual("@langfuse/shared/src/server");
  return {
    ...originalModule,
    provisionSplitForNewProject: jest.fn(),
  };
});

jest.mock("../../features/audit-logs/auditLog", () => ({
  auditLog: jest.fn(),
}));

jest.mock(
  "../../features/projects/server/seedProjectAnnotationDefaults",
  () => ({
    seedProjectAnnotationDefaults: jest.fn().mockResolvedValue(undefined),
  }),
);

import { projectsRouter } from "@/src/features/projects/server/projectsRouter";
import { type Plan, Role } from "@langfuse/shared";
import { provisionSplitForNewProject } from "@langfuse/shared/src/server";
import type { Session } from "next-auth";

const ORG_ID = "project-limit-org";
const mockProvisionSplitForNewProject = jest.mocked(
  provisionSplitForNewProject,
);

const createSession = ({
  plan,
  admin = false,
}: {
  plan: Plan;
  admin?: boolean;
}): Session => ({
  expires: "1",
  user: {
    id: "project-limit-user",
    email: "project-limit@example.com",
    name: "Project Limit User",
    canCreateOrganizations: true,
    organizations: [
      {
        id: ORG_ID,
        name: "Project Limit Organization",
        role: Role.OWNER,
        plan,
        cloudConfig: undefined,
        metadata: {},
        aiFeaturesEnabled: false,
        projects: [],
      },
    ],
    featureFlags: {
      excludeClickhouseRead: false,
      templateFlag: true,
    },
    admin,
  },
  environment: {} as Session["environment"],
});

const createCaller = ({
  plan,
  activeProjectCount,
  admin = false,
}: {
  plan: Plan;
  activeProjectCount: number;
  admin?: boolean;
}) => {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    project: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(activeProjectCount),
      create: jest.fn().mockResolvedValue({
        id: "new-project-id",
        name: "New Project",
      }),
      delete: jest.fn(),
    },
    scoreConfig: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const transaction = jest.fn(
    async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
  );

  return {
    caller: projectsRouter.createCaller({
      session: createSession({ plan, admin }),
      prisma: { ...prisma, $transaction: transaction } as never,
    } as never),
    prisma,
  };
};

describe("projectsRouter.create - project limit enforcement", () => {
  beforeEach(() => {
    mockProvisionSplitForNewProject.mockReset();
    mockProvisionSplitForNewProject.mockResolvedValue(undefined);
  });

  it.each([0, 1, 2])(
    "allows a cloud:developer organization to create project %i of 3",
    async (activeProjectCount) => {
      const { caller, prisma } = createCaller({
        plan: "cloud:developer",
        activeProjectCount,
      });

      await expect(
        caller.create({ orgId: ORG_ID, name: "New Project" }),
      ).resolves.toMatchObject({ id: "new-project-id" });

      expect(prisma.project.count).toHaveBeenCalledWith({
        where: { orgId: ORG_ID, deletedAt: null },
      });
      expect(prisma.project.create).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a fourth active project for a cloud:developer organization", async () => {
    const { caller, prisma } = createCaller({
      plan: "cloud:developer",
      activeProjectCount: 3,
    });

    await expect(
      caller.create({ orgId: ORG_ID, name: "New Project" }),
    ).rejects.toThrow("Free plan allows up to 3 projects per organization");

    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(mockProvisionSplitForNewProject).not.toHaveBeenCalled();
  });

  it("does not count soft-deleted projects", async () => {
    const { caller, prisma } = createCaller({
      plan: "cloud:developer",
      activeProjectCount: 2,
    });

    await expect(
      caller.create({ orgId: ORG_ID, name: "Replacement Project" }),
    ).resolves.toMatchObject({ id: "new-project-id" });

    expect(prisma.project.count).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, deletedAt: null },
    });
  });

  it.each([
    ["cloud:pro", false],
    ["oss", false],
    ["cloud:developer", true],
  ] as const)(
    "does not limit %s organizations when admin is %s",
    async (plan, admin) => {
      const { caller, prisma } = createCaller({
        plan,
        admin,
        activeProjectCount: 3,
      });

      await expect(
        caller.create({ orgId: ORG_ID, name: "New Project" }),
      ).resolves.toMatchObject({ id: "new-project-id" });

      expect(prisma.project.create).toHaveBeenCalledTimes(1);
    },
  );
});

describe("projectsRouter.transfer - project limit enforcement", () => {
  it("rejects a transfer into a cloud:developer organization with three active projects", async () => {
    const targetOrgId = "target-project-limit-org";
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: "project-to-transfer",
          orgId: ORG_ID,
        }),
        count: jest.fn().mockResolvedValue(3),
        update: jest.fn(),
      },
      projectMembership: {
        deleteMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const transaction = jest.fn(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    const session = createSession({ plan: "cloud:developer" });
    session.user.organizations[0].projects.push({
      id: "project-to-transfer",
      name: "Project To Transfer",
      role: Role.OWNER,
    });
    session.user.organizations.push({
      id: targetOrgId,
      name: "Target Project Limit Organization",
      role: Role.OWNER,
      plan: "cloud:developer",
      cloudConfig: undefined,
      metadata: {},
      aiFeaturesEnabled: false,
      projects: [],
    });
    const caller = projectsRouter.createCaller({
      session,
      prisma: { ...prisma, $transaction: transaction } as never,
    } as never);

    await expect(
      caller.transfer({
        projectId: "project-to-transfer",
        targetOrgId,
      }),
    ).rejects.toThrow("Free plan allows up to 3 projects per organization");

    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(prisma.projectMembership.deleteMany).not.toHaveBeenCalled();
  });
});
