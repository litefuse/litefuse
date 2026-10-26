import { EvalTemplateType, type ColumnDefinition } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const evaluatorStatusOptions = [
  { value: "ACTIVE", displayValue: "Active" },
  { value: "INACTIVE", displayValue: "Inactive" },
  { value: "BLOCKED", displayValue: "Blocked" },
];

const evaluatorTypeOptions = [
  {
    value: EvalTemplateType.LLM_AS_JUDGE,
    displayValue: "LLM as a judge",
  },
  { value: EvalTemplateType.CODE, displayValue: "Code" },
  {
    value: EvalTemplateType.DECISION_MODEL,
    displayValue: "Decision model (experimental)",
  },
];

export const evaluatorTableFilterColumns: ColumnDefinition[] = [
  {
    name: i18nKey("Name"),
    id: "name",
    type: "stringOptions",
    internal: "name",
    options: [],
  },
  {
    name: i18nKey("Status"),
    id: "status",
    type: "stringOptions",
    internal: "status",
    options: evaluatorStatusOptions,
  },
  {
    name: i18nKey("Type"),
    id: "type",
    type: "stringOptions",
    internal: "type",
    options: evaluatorTypeOptions,
  },
  {
    name: i18nKey("Model"),
    id: "model",
    type: "stringOptions",
    internal: "model",
    options: [],
  },
  {
    name: i18nKey("Creator"),
    id: "creator",
    type: "stringOptions",
    internal: "creator",
    options: [],
  },
];

export const evaluationRuleTableFilterColumns: ColumnDefinition[] = [
  {
    name: i18nKey("Name"),
    id: "name",
    type: "stringOptions",
    internal: "name",
    options: [],
  },
  {
    name: i18nKey("Creator"),
    id: "creator",
    type: "stringOptions",
    internal: "creator",
    options: [],
  },
  {
    name: i18nKey("Enabled"),
    id: "enabled",
    type: "boolean",
    internal: "enabled",
  },
  {
    name: i18nKey("Upgrade required"),
    id: "upgradeRequired",
    type: "boolean",
    internal: "upgradeRequired",
  },
];

export const evaluatorTableFilterConfig: FilterConfig = {
  tableName: "evaluators-v2",
  columnDefinitions: evaluatorTableFilterColumns,
  defaultExpanded: ["status", "type"],
  facets: [
    { type: "categorical", column: "name", label: i18nKey("Name") },
    { type: "categorical", column: "status", label: i18nKey("Status") },
    { type: "categorical", column: "type", label: i18nKey("Type") },
    { type: "categorical", column: "model", label: i18nKey("Model") },
    { type: "categorical", column: "creator", label: i18nKey("Creator") },
  ],
};

export const evaluationRuleTableFilterConfig: FilterConfig = {
  tableName: "evaluation-rules-v2",
  columnDefinitions: evaluationRuleTableFilterColumns,
  defaultExpanded: ["enabled"],
  facets: [
    { type: "categorical", column: "name", label: i18nKey("Name") },
    { type: "categorical", column: "creator", label: i18nKey("Creator") },
    {
      type: "boolean",
      column: "enabled",
      label: i18nKey("Enabled"),
      trueLabel: "Enabled",
      falseLabel: "Disabled",
    },
    {
      type: "boolean",
      column: "upgradeRequired",
      label: i18nKey("Upgrade required"),
      trueLabel: "Required",
      falseLabel: "Not required",
    },
  ],
};

export const evaluatorTableFilterOptions = {
  status: evaluatorStatusOptions,
  type: evaluatorTypeOptions,
};

export const evaluationRuleTableFilterOptions = {};
