import { DECISION_MODEL_LIMITS } from "@langfuse/shared";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type TFunction } from "i18next";

import { Button } from "@/src/components/ui/button";
import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { SortableList } from "@/src/features/evals/v2/components/SortableList/SortableList";
import { moveItem } from "@/src/features/evals/v2/fns/moveItem";

export type ScoreLevelDraft = { description: string };

function levelPlaceholder(index: number, count: number, t: TFunction) {
  if (index === 0) return t("Lowest level, e.g. Calm, just stating facts");
  if (index === count - 1) {
    return t("Highest level, e.g. Very angry or threatening to leave");
  }
  return t("Describe this level");
}

/**
 * Ordered levels of a Score question, low to high. The level number is its
 * position; the model only sees the descriptions, so each one has to describe
 * a recognisable situation rather than a degree.
 */
export function ScoreLevelsEditor({
  levels,
  onChange,
  error,
}: {
  levels: ScoreLevelDraft[];
  onChange: (levels: ScoreLevelDraft[]) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const update = (index: number, description: string) =>
    onChange(levels.map((level, i) => (i === index ? { description } : level)));
  const remove = (index: number) =>
    onChange(levels.filter((_, i) => i !== index));
  const canRemove = levels.length > DECISION_MODEL_LIMITS.minScoreLevels;

  return (
    <div className="flex flex-col gap-2">
      <Label className="flex items-center gap-1.5">
        {t("Levels, low to high")}
        <InfoTooltip label={t("About levels")}>
          {t(
            "Each level is one point on the scale. The model judges every level on its own against the state and returns a position between them, so describe situations (“broken, but a workaround exists”), not degrees (“moderately severe”). Two to ten levels; drag to reorder.",
          )}
        </InfoTooltip>
        <span className="text-muted-foreground text-xs font-normal">
          {t("{{current}} of {{max}}", {
            current: levels.length,
            max: DECISION_MODEL_LIMITS.maxScoreLevels,
          })}
        </span>
      </Label>
      <SortableList
        items={levels}
        getId={(_level, index) => `level-${index}`}
        getLabel={(_level, index) => t("level {{index}}", { index })}
        onReorder={(from, to) => onChange(moveItem(levels, from, to))}
        renderItem={(level, index) => (
          <div className="grid grid-cols-[2rem_1fr_auto] items-center gap-2">
            <span
              className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md font-mono text-xs"
              aria-hidden="true"
            >
              {index}
            </span>
            <Input
              value={level.description}
              onChange={(event) => update(index, event.target.value)}
              placeholder={levelPlaceholder(index, levels.length, t)}
              aria-label={t("Level {{index}} description", { index })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="hover:text-destructive"
              disabled={!canRemove}
              onClick={() => remove(index)}
              title={
                canRemove
                  ? t("Remove level")
                  : t("Keep at least {{min}} levels", {
                      min: DECISION_MODEL_LIMITS.minScoreLevels,
                    })
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      />
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={levels.length >= DECISION_MODEL_LIMITS.maxScoreLevels}
          onClick={() => onChange([...levels, { description: "" }])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("Add level")}
        </Button>
        <span className="text-muted-foreground text-xs">
          {t(
            "The score is the probability-weighted average of the level numbers, so it can be a decimal from 0 to {{max}}.",
            { max: Math.max(levels.length - 1, 0) },
          )}
        </span>
      </div>
      {error ? (
        <p className="text-destructive text-xs">
          {t(error, { value: DECISION_MODEL_LIMITS.minScoreLevels })}
        </p>
      ) : null}
    </div>
  );
}
