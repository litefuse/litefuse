// @ts-nocheck
import { Button } from "components/ui/button";
import { IconButton } from "components/ui/icon-button";
import React from "react";
import { useTranslation } from "react-i18next";

interface SurroundingLogsActionsProps {
  getSurroundingData: (params: { time: string }) => void;
  getSurroundingDataLoading: boolean;
  time: string;
  timeFieldPageSize: number;
  setTimeFieldPageSize: (value: number) => void;
  tips: string;
  count: number;
  type: "before" | "after";
}

export function SurroundingLogsActions(props: SurroundingLogsActionsProps) {
  const {
    getSurroundingData,
    getSurroundingDataLoading,
    time,
    timeFieldPageSize,
    tips,
    count,
    type,
  } = props;
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          getSurroundingData({ time: time });
        }}
        type="reset"
      >
        {!getSurroundingDataLoading && (
          <>
            {type === "before" ? (
              <IconButton name="arrow-up" aria-label={`Load After`} />
            ) : (
              <IconButton name="arrow-down" aria-label={`Load Before`} />
            )}
          </>
        )}
        {`Load`} {timeFieldPageSize} {t`Items`}
      </Button>
      <span className="text-muted-foreground text-xs">
        {count} {`Items`} {` `}
        {tips}
      </span>
    </div>
  );
}
