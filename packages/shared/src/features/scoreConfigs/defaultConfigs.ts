import { ScoreConfigDataType, type Prisma } from "@prisma/client";

export const DEFAULT_SCORE_CONFIG_DEFINITIONS = [
  {
    name: "is_correct",
    dataType: ScoreConfigDataType.BOOLEAN,
    categories: [
      { label: "True", value: 1 },
      { label: "False", value: 0 },
    ],
    description: "Whether the output is correct.",
  },
  {
    name: "accuracy",
    dataType: ScoreConfigDataType.NUMERIC,
    minValue: 0,
    maxValue: 1,
    description: "Accuracy score from 0 to 1.",
  },
  {
    name: "relevance",
    dataType: ScoreConfigDataType.NUMERIC,
    minValue: 0,
    maxValue: 1,
    description: "Relevance score from 0 to 1.",
  },
  {
    name: "helpfulness",
    dataType: ScoreConfigDataType.NUMERIC,
    minValue: 0,
    maxValue: 1,
    description: "Helpfulness score from 0 to 1.",
  },
  {
    name: "toxicity",
    dataType: ScoreConfigDataType.NUMERIC,
    minValue: 0,
    maxValue: 1,
    description: "Toxicity score from 0 to 1.",
  },
] satisfies Omit<Prisma.ScoreConfigCreateManyInput, "projectId">[];

export const getDefaultScoreConfigsForProject = (
  projectId: string,
): Prisma.ScoreConfigCreateManyInput[] =>
  DEFAULT_SCORE_CONFIG_DEFINITIONS.map((config) => ({
    ...config,
    projectId,
  }));
