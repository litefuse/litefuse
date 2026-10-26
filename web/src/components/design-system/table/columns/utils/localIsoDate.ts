// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream imports buildLocalIsoDatePresentation from \`@/src/utils/dates\`. Our
// (older) utils/dates.ts has no formatLocalIsoDate / Accuracy, and adding them
// there would mean editing a file outside the evaluator module.
//
// Both functions below are copied verbatim from upstream's utils/dates.ts so the
// rendered timestamps are identical; only their home changed.
// ─────────────────────────────────────────────────────────────────────────────

type Accuracy = "day" | "hour" | "minute" | "second" | "millisecond";

export const formatLocalIsoDate = (
  date: Date,
  useUTC = false,
  pAccuracy: Accuracy,
) => {
  const pad = (num: number) => String(num).padStart(2, "0");

  const year = useUTC ? date.getUTCFullYear() : date.getFullYear();
  const month = useUTC ? date.getUTCMonth() + 1 : date.getMonth() + 1;
  const day = useUTC ? date.getUTCDate() : date.getDate();
  const hours = useUTC ? date.getUTCHours() : date.getHours();
  const minutes = useUTC ? date.getUTCMinutes() : date.getMinutes();
  const seconds = useUTC ? date.getUTCSeconds() : date.getSeconds();
  const ms = useUTC ? date.getUTCMilliseconds() : date.getMilliseconds();

  let formatted = `${year}-${pad(month)}-${pad(day)}`;

  if (["hour", "minute", "second", "millisecond"].includes(pAccuracy)) {
    formatted += ` ${pad(hours)}`;
  }
  if (["minute", "second", "millisecond"].includes(pAccuracy)) {
    formatted += `:${pad(minutes)}`;
  }
  if (["second", "millisecond"].includes(pAccuracy)) {
    formatted += `:${pad(seconds)}`;
  }
  if (pAccuracy === "millisecond") {
    formatted += `.${String(ms).padStart(3, "0")}`;
  }

  return formatted;
};

export const buildLocalIsoDatePresentation = ({
  date,
  accuracy = "second",
}: {
  date: unknown;
  accuracy?: Accuracy;
}) => {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return null;
  }

  return {
    display: formatLocalIsoDate(date, false, accuracy),
    title: `Local: ${formatLocalIsoDate(date, false, "millisecond")}\nUTC: ${formatLocalIsoDate(date, true, "millisecond")}`,
  };
};
