import { auditLog } from "@/src/features/audit-logs/auditLog";
import { generateBatchActionId } from "@/src/features/table/server/helpers";
import {
  type Role,
  type BatchExportTableName,
  type BatchActionQuery,
  type ActionId,
  type BatchActionType,
} from "@langfuse/shared";
import {
  getPgBossQueue,
  logger,
  QueueJobs,
  QueueName,
} from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";

type CreateBatchActionJob = {
  projectId: string;
  actionId: Exclude<
    ActionId,
    "observation-add-to-dataset" | "observation-run-batched-evaluation"
  >;
  tableName: BatchExportTableName;
  actionType: BatchActionType;
  session: {
    user: {
      id: string;
    };
    orgId: string;
    orgRole: Role;
    projectId?: string;
    projectRole?: Role;
  };
  query: BatchActionQuery;
  targetId?: string;
};

/**
 * ⚠️ Only use after verifying that the user has the necessary permissions to perform the action.
 */
export const createBatchActionJob = async ({
  projectId,
  actionId,
  tableName,
  actionType,
  session,
  query,
  targetId,
}: CreateBatchActionJob) => {
  const batchActionId = generateBatchActionId(projectId, actionId, tableName);

  // Create audit log >> generate based on actionId
  await auditLog({
    session,
    resourceType: "batchAction",
    resourceId: batchActionId,
    projectId: projectId,
    action: actionType as string,
  });

  // Notify worker
  await getPgBossQueue(QueueName.BatchActionQueue).send(
    QueueJobs.BatchActionProcessingJob,
    {
      projectId,
      actionId,
      tableName,
      cutoffCreatedAt: new Date(),
      query,
      targetId: targetId,
      type: actionType,
    },
    {
      singletonKey: batchActionId,
    },
  );

  return;
};
