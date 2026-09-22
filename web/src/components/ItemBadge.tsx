import type React from "react";
import { Badge } from "@/src/components/ui/badge";
import {
  CircleDot,
  ClipboardPen,
  Database,
  Fan,
  ListTree,
  MoveHorizontal,
  User,
  FileText,
  FlaskConical,
  ListTodo,
  WandSparkles,
  TestTubeDiagonal,
  Clock,
  Bot,
  Wrench,
  Link,
  Search,
  Layers3,
  ShieldCheck,
} from "lucide-react";
import { cva } from "class-variance-authority";
import { type ObservationType } from "@langfuse/shared";
import { cn } from "@/src/utils/tailwind";

import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";
export type LangfuseItemType =
  | ObservationType
  | "TRACE"
  | "SESSION"
  | "USER"
  | "QUEUE_ITEM"
  | "DATASET"
  | "DATASET_RUN"
  | "DATASET_ITEM"
  | "ANNOTATION_QUEUE"
  | "PROMPT"
  | "EVALUATOR"
  | "RUNNING_EVALUATOR";

const iconMap = {
  TRACE: ListTree,
  GENERATION: Fan,
  EVENT: CircleDot,
  SPAN: MoveHorizontal,
  AGENT: Bot,
  TOOL: Wrench,
  CHAIN: Link,
  RETRIEVER: Search,
  EMBEDDING: Layers3,
  GUARDRAIL: ShieldCheck,
  SESSION: Clock,
  USER: User,
  QUEUE_ITEM: ClipboardPen,
  DATASET: Database,
  DATASET_RUN: FlaskConical,
  DATASET_ITEM: TestTubeDiagonal,
  ANNOTATION_QUEUE: ListTodo,
  PROMPT: FileText,
  RUNNING_EVALUATOR: Bot,
  EVALUATOR: WandSparkles,
} as const;

const iconVariants = cva(cn("h-4 w-4"), {
  variants: {
    type: {
      TRACE: "text-dark-green",
      GENERATION: "text-muted-magenta",
      EVENT: "text-muted-green",
      SPAN: "text-muted-blue",
      AGENT: "text-purple-600",
      TOOL: "text-orange-600",
      CHAIN: "text-pink-600",
      RETRIEVER: "text-teal-600",
      EMBEDDING: "text-amber-600",
      GUARDRAIL: "text-red-600",
      SESSION: "text-primary-accent",
      USER: "text-primary-accent",
      QUEUE_ITEM: "text-primary-accent",
      DATASET: "text-primary-accent",
      DATASET_RUN: "text-primary-accent",
      DATASET_ITEM: "text-primary-accent",
      ANNOTATION_QUEUE: "text-primary-accent",
      PROMPT: "text-primary-accent",
      EVALUATOR: "text-primary-accent", // usually text-indigo-600
      RUNNING_EVALUATOR: "text-primary-accent",
    },
  },
});

export function renderFilterIcon(value: string): React.ReactNode {
  const type = value as LangfuseItemType;
  const Icon = iconMap[type];
  if (!Icon) return null;
  return (
    <Icon className={cn("h-3.5 w-3.5 shrink-0", iconVariants({ type }))} />
  );
}

/**
 * Item types are protocol values; these are the labels shown for them. An
 * unknown type still falls back to the capitalised value.
 */
const itemLabels: Record<string, string> = {
  TRACE: i18nKey("Trace"),
  GENERATION: i18nKey("Generation"),
  EVENT: i18nKey("Event"),
  SPAN: i18nKey("Span"),
  AGENT: i18nKey("Agent"),
  TOOL: i18nKey("Tool"),
  CHAIN: i18nKey("Chain"),
  RETRIEVER: i18nKey("Retriever"),
  EMBEDDING: i18nKey("Embedding"),
  GUARDRAIL: i18nKey("Guardrail"),
  SESSION: i18nKey("Session"),
  USER: i18nKey("User"),
  QUEUE_ITEM: i18nKey("Queue item"),
  DATASET: i18nKey("Dataset"),
  DATASET_RUN: i18nKey("Dataset run"),
  DATASET_ITEM: i18nKey("Dataset item"),
  ANNOTATION_QUEUE: i18nKey("Annotation queue"),
  PROMPT: i18nKey("Prompt"),
  EVALUATOR: i18nKey("Evaluator"),
  RUNNING_EVALUATOR: i18nKey("Running evaluator"),
};

export function ItemBadge({
  type,
  showLabel = false,
  isSmall = false,
  className,
}: {
  type: LangfuseItemType;
  showLabel?: boolean;
  isSmall?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = iconMap[type] || ListTree; // Default to ListTree if unknown type

  // Modify this line to ensure the icon is properly sized
  const iconClass = cn(
    iconVariants({ type }),
    isSmall ? "h-3 w-3" : "h-4 w-4",
    className,
  );

  const label = t(
    itemLabels[type] ??
      String(type).charAt(0).toUpperCase() +
        String(type).slice(1).toLowerCase(),
  );

  return (
    <Badge
      variant="outline"
      title={label}
      className={cn(
        "bg-background flex max-w-fit items-center gap-1 overflow-hidden border-2 px-1 whitespace-nowrap",
        isSmall && "h-4",
      )}
    >
      <Icon className={iconClass} />
      {showLabel && (
        <span className="truncate" title={label.replace(/_/g, " ")}>
          {label.replace(/_/g, " ")}
        </span>
      )}
    </Badge>
  );
}
