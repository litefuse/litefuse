import { useMemo } from "react";
import { z } from "zod/v4";
import {
  type EvaluatorBlockReason,
  type FilterState,
  singleFilter,
  type OrderByState,
} from "@langfuse/shared";
import { api } from "@/src/utils/api";
import {
  getLazyEvaluatorDisplayStatus,
  useLazyEvaluatorExecutionCountsByIds,
} from "@/src/features/evals/hooks/useLazyEvaluatorExecutionCounts";
import { generateJobExecutionCounts } from "@/src/features/evals/utils/job-execution-utils";
import { isLegacyEvalTarget } from "@/src/features/evals/utils/typeHelpers";
import { RAGAS_TEMPLATE_PREFIX } from "@/src/features/evals/types";

export type EvaluatorDataRow = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  maintainer: string;
  rawStatus: string;
  template?: {
    id: string;
    name: string;
    version: number;
  };
  blockMessage?: string | null;
  blockReason?: EvaluatorBlockReason | null;
  scoreName: string;
  target: string;
  filter: FilterState;
  result: {
    level: string;
    count: number;
    symbol: string;
  }[];
  isResultLoading: boolean;
  logs?: string;
  actions?: string;
  isLegacy?: boolean;
};

type UseEvaluatorTableDataParams = {
  projectId: string;
  page: number;
  limit: number;
  filter: FilterState;
  orderBy: OrderByState;
  searchQuery: string | null;
};

export const useEvaluatorTableData = ({
  projectId,
  page,
  limit,
  filter,
  orderBy,
  searchQuery,
}: UseEvaluatorTableDataParams) => {
  const evaluators = api.evals.allConfigs.useQuery({
    page,
    limit,
    projectId,
    filter,
    orderBy,
    searchQuery,
  });

  const evaluatorIds =
    evaluators.data?.configs.map((config) => config.id) ?? [];

  const lazyExecutionCounts = useLazyEvaluatorExecutionCountsByIds({
    projectId,
    evaluatorIds,
    enabled: evaluators.isSuccess,
  });

  const rows = useMemo(
    () =>
      (evaluators.data?.configs ?? []).map((jobConfig) => {
        const executionCounts =
          lazyExecutionCounts.jobExecutionCountsByEvaluatorId[jobConfig.id];
        const status =
          getLazyEvaluatorDisplayStatus({
            evaluator: jobConfig,
            jobExecutionCounts: executionCounts,
          }) ?? jobConfig.displayStatus;

        return {
          id: jobConfig.id,
          status,
          rawStatus: jobConfig.status,
          createdAt: jobConfig.createdAt.toLocaleString(),
          updatedAt: jobConfig.updatedAt.toLocaleString(),
          template: jobConfig.evalTemplate
            ? {
                id: jobConfig.evalTemplate.id,
                name: jobConfig.evalTemplate.name,
                version: jobConfig.evalTemplate.version,
              }
            : undefined,
          blockMessage: jobConfig.blockMessage,
          blockReason: jobConfig.blockReason,
          scoreName: jobConfig.scoreName,
          target: jobConfig.targetObject,
          filter: z.array(singleFilter).parse(jobConfig.filter),
          result: generateJobExecutionCounts(executionCounts),
          isResultLoading:
            lazyExecutionCounts.isLoading &&
            !lazyExecutionCounts.jobExecutionCountsByEvaluatorId[jobConfig.id],
          maintainer: jobConfig.evalTemplate
            ? jobConfig.evalTemplate.projectId
              ? "User maintained"
              : jobConfig.evalTemplate.name.startsWith(RAGAS_TEMPLATE_PREFIX)
                ? "Litefuse and Ragas maintained"
                : "Litefuse maintained"
            : "Not available",
          isLegacy: isLegacyEvalTarget(jobConfig.targetObject),
        } satisfies EvaluatorDataRow;
      }),
    [
      evaluators.data?.configs,
      lazyExecutionCounts.isLoading,
      lazyExecutionCounts.jobExecutionCountsByEvaluatorId,
    ],
  );

  return {
    evaluators,
    rows,
    totalCount: evaluators.data?.totalCount ?? null,
    hasLegacyEvals: rows.some(
      (row) => row.status === "ACTIVE" && Boolean(row.isLegacy),
    ),
  };
};
