/** @jest-environment node */

import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { prisma } from "@langfuse/shared/src/db";
import { ScoreConfigDataType } from "@langfuse/shared";
import type { Session } from "next-auth";
import { randomUUID } from "crypto";

describe("projects tRPC", () => {
  const orgIds: string[] = [];

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: {
        id: { in: orgIds },
      },
    });
  });

  it("creates default score configs for new projects", async () => {
    const org = await prisma.organization.create({
      data: {
        id: randomUUID(),
        name: `Test Org ${randomUUID().slice(0, 8)}`,
      },
    });
    orgIds.push(org.id);

    const session: Session = {
      expires: "1",
      user: {
        id: randomUUID(),
        name: "Test Owner",
        email: "owner@example.com",
        canCreateOrganizations: true,
        organizations: [
          {
            id: org.id,
            name: org.name,
            role: "OWNER",
            plan: "cloud:hobby",
            cloudConfig: undefined,
            metadata: {},
            projects: [],
          },
        ],
        featureFlags: {
          excludeClickhouseRead: false,
          templateFlag: true,
        },
        admin: false,
      },
      environment: {
        enableExperimentalFeatures: false,
        selfHostedInstancePlan: "cloud:hobby",
      },
    };

    const ctx = createInnerTRPCContext({ session, headers: {} });
    const caller = appRouter.createCaller({ ...ctx, prisma });

    const project = await caller.projects.create({
      orgId: org.id,
      name: `Test Project ${randomUUID().slice(0, 8)}`,
    });

    const scoreConfigs = await prisma.scoreConfig.findMany({
      where: {
        projectId: project.id,
        name: {
          in: [
            "is_correct",
            "accuracy",
            "relevance",
            "helpfulness",
            "toxicity",
          ],
        },
      },
    });

    expect(scoreConfigs).toHaveLength(5);

    const isCorrect = scoreConfigs.find(
      (config) => config.name === "is_correct",
    );
    expect(isCorrect).toMatchObject({
      dataType: ScoreConfigDataType.BOOLEAN,
      minValue: null,
      maxValue: null,
    });
    expect(isCorrect?.categories).toEqual([
      { label: "True", value: 1 },
      { label: "False", value: 0 },
    ]);

    const accuracy = scoreConfigs.find((config) => config.name === "accuracy");
    expect(accuracy).toMatchObject({
      dataType: ScoreConfigDataType.NUMERIC,
      minValue: 0,
      maxValue: 1,
      categories: null,
    });

    for (const name of ["relevance", "helpfulness", "toxicity"]) {
      const config = scoreConfigs.find((config) => config.name === name);
      expect(config).toMatchObject({
        dataType: ScoreConfigDataType.NUMERIC,
        minValue: 0,
        maxValue: 1,
        categories: null,
      });
    }
  });
});
