import { useMemo } from "react";
import { Button } from "@/src/components/ui/button";
import { AlertTriangle, Pencil } from "lucide-react";
import { JSONView } from "@/src/components/ui/CodeJsonViewer";
import { cn } from "@/src/utils/tailwind";
import type { FinalPreviewStepProps, DialogStep } from "./types";
import { applyFullMapping } from "@langfuse/shared";
import type { MappingError } from "@langfuse/shared";

import { useTranslation } from "react-i18next";

/** The JSON literal as rendered, not translatable text. */
const NULL_LITERAL = "null";
export function FinalPreviewStep({
  dataset,
  mapping,
  observationData,
  totalCount,
  onEditStep,
}: FinalPreviewStepProps) {
  const { t } = useTranslation();
  // Compute the full preview
  const previewResult = useMemo(() => {
    if (!observationData) return null;

    return applyFullMapping({
      observation: {
        input: observationData.input,
        output: observationData.output,
        metadata: observationData.metadata,
      },
      mapping,
    });
  }, [observationData, mapping]);

  // Group errors by target field
  const errorsByField = useMemo(() => {
    const errors = previewResult?.errors ?? [];
    const grouped: Record<string, MappingError[]> = {};
    for (const err of errors) {
      if (!grouped[err.targetField]) {
        grouped[err.targetField] = [];
      }
      grouped[err.targetField].push(err);
    }
    return grouped;
  }, [previewResult?.errors]);

  const hasWarnings = (previewResult?.errors?.length ?? 0) > 0;

  const stepForField: Record<string, DialogStep> = {
    input: "input-mapping" as DialogStep,
    expectedOutput: "output-mapping" as DialogStep,
    metadata: "metadata-mapping" as DialogStep,
  };

  return (
    <div className="h-[62vh] space-y-6 p-6">
      <div>
        <h3 className="text-lg font-semibold">{t("Review Configuration")}</h3>
        <p className="text-muted-foreground text-sm">
          {t('Adding {{count}} observation to dataset "{{dataset}}"', {
            count: totalCount,
            dataset: dataset.name,
          })}
        </p>
      </div>

      {/* Overall warning banner */}
      {hasWarnings && (
        <div className="rounded-md border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
                {t("Some JSON paths did not match the preview observation")}
              </p>
              <p className="text-xs text-amber-600/80 dark:text-amber-500/80">
                {t(
                  "Observations with failed mappings will be skipped during processing.",
                )}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {Object.entries(errorsByField).map(([field]) => (
                  <Button
                    key={field}
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-amber-600 underline dark:text-amber-500"
                    onClick={() => {
                      const step = stepForField[field];
                      if (step) onEditStep(step);
                    }}
                  >
                    {t("Edit {{field}} mapping", {
                      field:
                        field === "expectedOutput"
                          ? t("expected output")
                          : field,
                    })}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="text-muted-foreground text-sm">
        {t("Sample dataset item preview (from first selected observation):")}
      </div>

      {!observationData ? (
        <div className="bg-muted/30 flex h-64 items-center justify-center rounded-md border p-4">
          <p className="text-muted-foreground text-sm">
            {t("No observation data available for preview")}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Input Preview */}
          <PreviewCard
            label={t("Input")}
            data={previewResult?.input}
            onEdit={() => onEditStep("input-mapping" as DialogStep)}
            errors={errorsByField["input"]}
          />

          {/* Expected Output Preview */}
          <PreviewCard
            label={t("Expected Output")}
            data={previewResult?.expectedOutput}
            onEdit={() => onEditStep("output-mapping" as DialogStep)}
            errors={errorsByField["expectedOutput"]}
          />

          {/* Metadata Preview */}
          <PreviewCard
            label={t("Metadata")}
            data={previewResult?.metadata}
            onEdit={() => onEditStep("metadata-mapping" as DialogStep)}
            errors={errorsByField["metadata"]}
          />
        </div>
      )}
    </div>
  );
}

type PreviewCardProps = {
  label: string;
  data: unknown;
  onEdit: () => void;
  errors?: MappingError[];
};

function PreviewCard({ label, data, onEdit, errors }: PreviewCardProps) {
  const { t } = useTranslation();
  const hasErrors = errors && errors.length > 0;

  return (
    <div
      className={cn("rounded-lg border", hasErrors && "border-amber-500/50")}
    >
      <div className="bg-muted/30 flex items-center justify-between border-b px-4 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {hasErrors && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
          )}
          {label}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="h-7 gap-1 text-xs"
        >
          <Pencil className="h-3 w-3" />
          {t("Edit")}
        </Button>
      </div>
      <div className="max-h-62 overflow-auto">
        {data === null ? (
          <div className="text-muted-foreground p-4 text-sm italic">
            {NULL_LITERAL}
          </div>
        ) : (
          <JSONView json={data} className="text-xs" />
        )}
      </div>
      {hasErrors && (
        <div className="border-t border-amber-500/50 bg-amber-50 px-4 py-2 dark:bg-amber-950/30">
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t(
              "{{count}} path did not match in preview observation. These items will be skipped during processing.",
              { count: errors.length },
            )}
          </p>
        </div>
      )}
    </div>
  );
}
