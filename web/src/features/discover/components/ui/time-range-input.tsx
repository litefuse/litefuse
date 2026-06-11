// @ts-nocheck
"use client";

export interface TimeRange {
  from: Date | any;
  to: Date | any;
  raw?: any;
}

export function TimeRangeInput({
  value,
  onChange,
}: {
  value?: TimeRange;
  onChange?: (range: TimeRange) => void;
  timeZone?: string;
  isReversed?: boolean;
}) {
  const formatDate = (date?: Date) => {
    if (!date) {
      return "";
    }

    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };

  return (
    <div className="flex items-center gap-1 text-xs">
      <input
        type="datetime-local"
        value={formatDate(value?.from)}
        onChange={(event) => {
          if (onChange && value) {
            onChange({ ...value, from: new Date(event.target.value) });
          }
        }}
        className="border-border bg-background h-7 rounded border px-1.5 text-xs focus:outline-none"
      />
      <span className="text-muted-foreground">-</span>
      <input
        type="datetime-local"
        value={formatDate(value?.to)}
        onChange={(event) => {
          if (onChange && value) {
            onChange({ ...value, to: new Date(event.target.value) });
          }
        }}
        className="border-border bg-background h-7 rounded border px-1.5 text-xs focus:outline-none"
      />
    </div>
  );
}
