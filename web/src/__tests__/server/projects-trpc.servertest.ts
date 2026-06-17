/** @jest-environment node */

import {
  BUILTIN_CORRECTNESS_DESCRIPTION,
  BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION,
  BUILTIN_CORRECTNESS_QUEUE_NAME,
  BUILTIN_CORRECTNESS_SCORE_NAME,
  seedProjectAnnotationDefaults,
} from "@/src/features/projects/server/seedProjectAnnotationDefaults";

describe("seedProjectAnnotationDefaults", () => {
  it("creates the built-in correctness score config and queue when missing", async () => {
    const scoreConfigFindFirst = jest.fn().mockResolvedValue(null);
    const scoreConfigCreate = jest.fn().mockResolvedValue({
      id: "score-config-1",
    });
    const annotationQueueFindFirst = jest.fn().mockResolvedValue(null);
    const annotationQueueCreate = jest.fn().mockResolvedValue({
      id: "queue-1",
    });
    const annotationQueueUpdate = jest.fn();

    await seedProjectAnnotationDefaults(
      {
        scoreConfig: {
          findFirst: scoreConfigFindFirst,
          create: scoreConfigCreate,
        },
        annotationQueue: {
          findFirst: annotationQueueFindFirst,
          create: annotationQueueCreate,
          update: annotationQueueUpdate,
        },
      } as Parameters<typeof seedProjectAnnotationDefaults>[0],
      "project-1",
    );

    expect(scoreConfigFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        name: BUILTIN_CORRECTNESS_SCORE_NAME,
      },
    });
    expect(scoreConfigCreate).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        name: BUILTIN_CORRECTNESS_SCORE_NAME,
        dataType: "NUMERIC",
        minValue: 0,
        maxValue: 1,
        description: BUILTIN_CORRECTNESS_DESCRIPTION,
      },
    });
    expect(annotationQueueCreate).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        name: BUILTIN_CORRECTNESS_QUEUE_NAME,
        description: BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION,
        scoreConfigIds: ["score-config-1"],
      },
    });
    expect(annotationQueueUpdate).not.toHaveBeenCalled();
  });

  it("reuses existing built-ins without creating duplicates", async () => {
    const scoreConfigCreate = jest.fn();
    const annotationQueueCreate = jest.fn();
    const annotationQueueUpdate = jest.fn();

    await seedProjectAnnotationDefaults(
      {
        scoreConfig: {
          findFirst: jest.fn().mockResolvedValue({
            id: "score-config-1",
          }),
          create: scoreConfigCreate,
        },
        annotationQueue: {
          findFirst: jest.fn().mockResolvedValue({
            id: "queue-1",
            description: BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION,
            scoreConfigIds: ["score-config-1"],
          }),
          create: annotationQueueCreate,
          update: annotationQueueUpdate,
        },
      } as Parameters<typeof seedProjectAnnotationDefaults>[0],
      "project-1",
    );

    expect(scoreConfigCreate).not.toHaveBeenCalled();
    expect(annotationQueueCreate).not.toHaveBeenCalled();
    expect(annotationQueueUpdate).not.toHaveBeenCalled();
  });
});
