/**
 * Simple metadata badges for ObservationDetailView
 * Each badge handles its own null checks and returns null when data is unavailable
 */

import { Badge } from "@/src/components/ui/badge";
import { formatIntervalSeconds } from "@/src/utils/dates";

import { useTranslation } from "react-i18next";
export function LatencyBadge({
  latencySeconds,
}: {
  latencySeconds: number | null;
}) {
  const { t } = useTranslation();
  if (latencySeconds == null) return null;

  return (
    <Badge variant="tertiary">
      {t("Latency: {{value}}", {
        value: formatIntervalSeconds(latencySeconds),
      })}
    </Badge>
  );
}

export function TimeToFirstTokenBadge({
  timeToFirstToken,
}: {
  timeToFirstToken: number | null | undefined;
}) {
  const { t } = useTranslation();
  if (timeToFirstToken == null) return null;

  return (
    <Badge variant="tertiary">
      {t("Time to first token: {{value}}", {
        value: formatIntervalSeconds(timeToFirstToken),
      })}
    </Badge>
  );
}

export function EnvironmentBadge({
  environment,
}: {
  environment: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (!environment) return null;

  return (
    <Badge variant="tertiary">
      {t("Env: {{value}}", { value: environment })}
    </Badge>
  );
}

export function VersionBadge({
  version,
}: {
  version: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (!version) return null;

  return (
    <Badge variant="tertiary">
      {t("Version: {{value}}", { value: version })}
    </Badge>
  );
}

export function LevelBadge({ level }: { level: string | null | undefined }) {
  if (!level || level === "DEFAULT") return null;

  return (
    <Badge
      variant={
        level === "ERROR"
          ? "destructive"
          : level === "WARNING"
            ? "warning"
            : "tertiary"
      }
    >
      {level}
    </Badge>
  );
}

export function StatusMessageBadge({
  statusMessage,
}: {
  statusMessage: string | null | undefined;
}) {
  if (!statusMessage) return null;

  return <Badge variant="tertiary">{statusMessage}</Badge>;
}
