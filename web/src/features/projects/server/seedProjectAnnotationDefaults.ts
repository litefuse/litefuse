import type { Prisma } from "@langfuse/shared/src/db";

export const BUILTIN_CORRECTNESS_SCORE_NAME = "Correctness";
export const BUILTIN_CORRECTNESS_DESCRIPTION =
  "Built-in numeric score config for correctness annotations.";
export const BUILTIN_CORRECTNESS_QUEUE_NAME = "Correctness Queue";
export const BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION =
  "Built-in queue for correctness-focused human annotation.";

type ProjectAnnotationDefaultsTx = Pick<
  Prisma.TransactionClient,
  "scoreConfig" | "annotationQueue"
>;

export async function seedProjectAnnotationDefaults(
  tx: ProjectAnnotationDefaultsTx,
  projectId: string,
) {
  const existingScoreConfig = await tx.scoreConfig.findFirst({
    where: {
      projectId,
      name: BUILTIN_CORRECTNESS_SCORE_NAME,
    },
  });

  const scoreConfig =
    existingScoreConfig ??
    (await tx.scoreConfig.create({
      data: {
        projectId,
        name: BUILTIN_CORRECTNESS_SCORE_NAME,
        dataType: "NUMERIC",
        minValue: 0,
        maxValue: 1,
        description: BUILTIN_CORRECTNESS_DESCRIPTION,
      },
    }));

  const existingQueue = await tx.annotationQueue.findFirst({
    where: {
      projectId,
      name: BUILTIN_CORRECTNESS_QUEUE_NAME,
    },
  });

  if (!existingQueue) {
    await tx.annotationQueue.create({
      data: {
        projectId,
        name: BUILTIN_CORRECTNESS_QUEUE_NAME,
        description: BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION,
        scoreConfigIds: [scoreConfig.id],
      },
    });
    return;
  }

  const needsUpdate =
    existingQueue.description !== BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION ||
    existingQueue.scoreConfigIds.length !== 1 ||
    existingQueue.scoreConfigIds[0] !== scoreConfig.id;

  if (needsUpdate) {
    await tx.annotationQueue.update({
      where: {
        id: existingQueue.id,
      },
      data: {
        description: BUILTIN_CORRECTNESS_QUEUE_DESCRIPTION,
        scoreConfigIds: [scoreConfig.id],
      },
    });
  }
}
