import { z } from "zod/v4";
import { randomUUID } from "crypto";
import {
  type ExperimentMetadata,
  createDatasetItemFilterState,
  ExperimentCreateQueue,
  getDatasetItems,
  PromptService,
  QueueJobs,
  QueueName,
  redis,
  ZodModelConfig,
} from "@langfuse/shared/src/server";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import {
  extractVariables,
  validateDatasetItem,
  UnauthorizedError,
  PromptType,
  extractPlaceholderNames,
  type PromptMessage,
  isPresent,
  type DatasetItemDomain,
  singleFilter,
  optionalPaginationZod,
  type FilterState,
  isDorisFilterColumn,
  timeFilter,
} from "@langfuse/shared";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  getDatasetRunsTableCountCh,
  getDatasetRunsTableMetricsCh,
  getDatasetRunsTableRowsCh,
  getDatasetVersionForRun,
  getCategoricalScoresGroupedByName,
  getNumericScoresGroupedByName,
  getScoresForDatasetRuns,
  getTraceScoresForDatasetRuns,
} from "@langfuse/shared/src/server";
import { aggregateScores } from "@/src/features/scores/lib/aggregateScores";

const ValidConfigResponse = z.object({
  isValid: z.literal(true),
  totalItems: z.number(),
  variablesMap: z.record(z.string(), z.number()),
});

const InvalidConfigResponse = z.object({
  isValid: z.literal(false),
  message: z.string(),
});

const ConfigResponse = z.discriminatedUnion("isValid", [
  ValidConfigResponse,
  InvalidConfigResponse,
]);

const experimentRunsTableSchema = z.object({
  projectId: z.string(),
  filter: z.array(singleFilter),
  ...optionalPaginationZod,
});

const experimentRunTableMetricsSchema = z.object({
  projectId: z.string(),
  runIds: z.array(z.string()),
  filter: z.array(singleFilter),
});

const requiresDorisLookups = (filters: FilterState): boolean => {
  if (filters.length === 0) {
    return false;
  }

  return filters.some((filter) => isDorisFilterColumn(filter.column));
};

const resolveMetadata = (metadata: unknown) => {
  if (metadata === "") return undefined;
  if (typeof metadata !== "string") return metadata;

  try {
    return JSON.parse(metadata);
  } catch {
    return metadata;
  }
};

const countValidDatasetItems = (
  datasetItems: Omit<DatasetItemDomain, "status">[],
  variables: string[],
): Record<string, number> => {
  const variableMap: Record<string, number> = {};

  for (const { input } of datasetItems) {
    // Step 1: Validate item
    if (!isPresent(input) || !validateDatasetItem(input, variables)) {
      continue;
    }

    // Step 2: Count variable matches

    // String with single variable - count that variable
    if (typeof input === "string" && variables.length === 1) {
      variableMap[variables[0]] = (variableMap[variables[0]] || 0) + 1;
      continue;
    }

    // For object inputs, count each matching variable
    if (typeof input === "object" && !Array.isArray(input)) {
      for (const variable of variables) {
        if (variable in input) {
          variableMap[variable] = (variableMap[variable] || 0) + 1;
        }
      }
    }
  }

  return variableMap;
};

export const experimentsRouter = createTRPCRouter({
  runs: protectedProjectProcedure
    .input(experimentRunsTableSchema)
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:read",
      });

      if (!requiresDorisLookups(input.filter ?? [])) {
        const [runs, totalRuns] = await Promise.all([
          ctx.prisma.datasetRuns.findMany({
            where: {
              projectId: input.projectId,
            },
            include: {
              dataset: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: input.limit,
            skip:
              isPresent(input.page) && isPresent(input.limit)
                ? input.page * input.limit
                : undefined,
          }),
          ctx.prisma.datasetRuns.count({
            where: {
              projectId: input.projectId,
            },
          }),
        ]);

        return {
          totalRuns,
          runs,
        };
      }

      const [runs, totalRuns] = await Promise.all([
        getDatasetRunsTableRowsCh({
          projectId: input.projectId,
          filter: input.filter ?? [],
          limit: isPresent(input.limit) ? input.limit : undefined,
          offset:
            isPresent(input.page) && isPresent(input.limit)
              ? input.page * input.limit
              : undefined,
        }),
        getDatasetRunsTableCountCh({
          projectId: input.projectId,
          filter: input.filter ?? [],
        }),
      ]);

      const datasets = await ctx.prisma.dataset.findMany({
        where: {
          projectId: input.projectId,
          id: { in: Array.from(new Set(runs.map((run) => run.datasetId))) },
        },
        select: {
          id: true,
          name: true,
        },
      });
      const datasetById = new Map(
        datasets.map((dataset) => [dataset.id, dataset]),
      );

      return {
        totalRuns,
        runs: runs.map((run) => ({
          ...run,
          metadata: resolveMetadata(run.metadata),
          dataset: datasetById.get(run.datasetId) ?? {
            id: run.datasetId,
            name: run.datasetId,
          },
        })),
      };
    }),

  runsMetrics: protectedProjectProcedure
    .input(experimentRunTableMetricsSchema)
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:read",
      });

      if (input.runIds.length === 0) {
        return { runs: [] };
      }

      const runsWithMetrics = await getDatasetRunsTableMetricsCh({
        projectId: input.projectId,
        runIds: input.runIds ?? [],
        filter: input.filter ?? [],
      });

      const runsWithMetricsIds = runsWithMetrics.map((run) => run.id);
      const [traceScores, runScores] = await Promise.all([
        runsWithMetricsIds.length > 0
          ? getTraceScoresForDatasetRuns(input.projectId, runsWithMetricsIds)
          : [],
        getScoresForDatasetRuns({
          projectId: input.projectId,
          runIds: runsWithMetrics.map((run) => run.id),
          includeHasMetadata: true,
          excludeMetadata: true,
        }),
      ]);

      return {
        runs: runsWithMetrics.map((run) => ({
          id: run.id,
          name: run.name,
          datasetId: run.datasetId,
          countRunItems: run.countRunItems ?? 0,
          avgTotalCost: run.avgTotalCost ?? null,
          totalCost: run.totalCost ?? null,
          avgLatency: run.avgLatency ?? null,
          scores: aggregateScores(
            traceScores.filter((score) => score.datasetRunId === run.id),
          ),
          runScores: aggregateScores(
            runScores.filter((score) => score.datasetRunId === run.id),
          ),
        })),
      };
    }),

  runById: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        runId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:read",
      });

      const run = await ctx.prisma.datasetRuns.findUnique({
        where: {
          id_projectId: {
            id: input.runId,
            projectId: input.projectId,
          },
        },
        include: {
          dataset: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!run) return null;

      const datasetVersion = await getDatasetVersionForRun({
        projectId: input.projectId,
        datasetId: run.datasetId,
        runId: input.runId,
      });

      return {
        ...run,
        datasetVersion,
      };
    }),

  runFilterOptions: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        timestampFilter: timeFilter.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:read",
      });

      const { timestampFilter } = input;

      const [numericScoreNames, categoricalScoreNames] = await Promise.all([
        getNumericScoresGroupedByName(
          input.projectId,
          timestampFilter ? [timestampFilter] : [],
        ),
        getCategoricalScoresGroupedByName(
          input.projectId,
          timestampFilter ? [timestampFilter] : [],
        ),
      ]);

      return {
        agg_scores_avg: numericScoreNames.map((score) => score.name),
        agg_score_categories: categoricalScoreNames,
      };
    }),

  validateConfig: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        datasetId: z.string(),
        promptId: z.string(),
        datasetVersion: z.coerce.date().optional(),
      }),
    )
    .output(ConfigResponse)
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:CUD",
      });

      const prompt = await ctx.prisma.prompt.findFirst({
        where: {
          id: input.promptId,
          projectId: input.projectId,
        },
      });

      if (!prompt) {
        return {
          isValid: false,
          message: "Selected prompt not found.",
        };
      }

      const promptService = new PromptService(ctx.prisma, redis);
      const resolvedPrompt = await promptService.resolvePrompt(prompt);

      if (!resolvedPrompt) {
        return {
          isValid: false,
          message: "Selected prompt not found.",
        };
      }

      const extractedVariables = extractVariables(
        resolvedPrompt?.type === PromptType.Text
          ? (resolvedPrompt.prompt?.toString() ?? "")
          : JSON.stringify(resolvedPrompt?.prompt),
      );

      const promptMessages =
        resolvedPrompt?.type === PromptType.Chat &&
        Array.isArray(resolvedPrompt?.prompt)
          ? resolvedPrompt.prompt
          : [];
      const placeholderNames = extractPlaceholderNames(
        promptMessages as PromptMessage[],
      );

      const allVariables = [...extractedVariables, ...placeholderNames];

      if (!Boolean(allVariables.length)) {
        return {
          isValid: false,
          message: "Selected prompt has no variables or placeholders.",
        };
      }

      const items = await getDatasetItems({
        projectId: input.projectId,
        filterState: createDatasetItemFilterState({
          datasetIds: [input.datasetId],
          status: "ACTIVE",
        }),
        version: input.datasetVersion,
      });

      if (!Boolean(items.length)) {
        return {
          isValid: false,
          message: "Selected dataset is empty or all items are inactive.",
        };
      }

      const variablesMap = countValidDatasetItems(items, allVariables);

      if (!Boolean(Object.keys(variablesMap).length)) {
        return {
          isValid: false,
          message: "No dataset item contains any variables.",
        };
      }

      return {
        isValid: true,
        totalItems: items.length,
        variablesMap: variablesMap,
      };
    }),

  createExperiment: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1, "Please enter an experiment name"),
        runName: z.string().min(1, "Run name is required"),
        promptId: z.string().min(1, "Please select a prompt"),
        datasetId: z.string().min(1, "Please select a dataset"),
        datasetVersion: z.coerce.date().optional(),
        description: z.string().max(1000).optional(),
        modelConfig: z.object({
          provider: z.string().min(1, "Please select a provider"),
          model: z.string().min(1, "Please select a model"),
          modelParams: ZodModelConfig,
        }),
        structuredOutputSchema: z.record(z.string(), z.any()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "promptExperiments:CUD",
      });

      if (!redis) {
        throw new UnauthorizedError("Experiment creation failed");
      }

      const metadata: ExperimentMetadata = {
        prompt_id: input.promptId,
        provider: input.modelConfig.provider,
        model: input.modelConfig.model,
        model_params: input.modelConfig.modelParams,
        ...(input.structuredOutputSchema && {
          structured_output_schema: input.structuredOutputSchema,
        }),
        ...(input.datasetVersion && {
          dataset_version: input.datasetVersion,
        }),
      };

      const datasetRun = await ctx.prisma.datasetRuns.create({
        data: {
          name: input.runName,
          description: input.description,
          datasetId: input.datasetId,
          metadata: {
            ...metadata,
            experiment_name: input.name,
            experiment_run_name: input.runName,
          },
          projectId: input.projectId,
        },
      });

      const queue = ExperimentCreateQueue.getInstance();

      if (queue) {
        await queue.add(QueueName.ExperimentCreate, {
          name: QueueJobs.ExperimentCreateJob,
          id: randomUUID(),
          timestamp: new Date(),
          payload: {
            projectId: input.projectId,
            datasetId: input.datasetId,
            runId: datasetRun.id,
            description: input.description,
          },
          retryBaggage: {
            originalJobTimestamp: new Date(),
            attempt: 0,
          },
        });
      }

      return {
        success: true,
        datasetId: input.datasetId,
        runId: datasetRun.id,
        runName: input.runName,
      };
    }),
});
