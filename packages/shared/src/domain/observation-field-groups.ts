export const OBSERVATION_FIELD_GROUPS = [
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "prompt",
  "metrics",
  "trace_context",
] as const;

export type ObservationFieldGroup = (typeof OBSERVATION_FIELD_GROUPS)[number];

export const DEFAULT_OBSERVATION_FIELD_GROUPS: ObservationFieldGroup[] = [
  ...OBSERVATION_FIELD_GROUPS,
];

export const OBSERVATION_FIELD_GROUP_OPTIONS: Array<{
  value: ObservationFieldGroup;
  label: string;
  description: string;
}> = [
  {
    value: "core",
    label: "Core",
    description:
      "Always-required identifiers and timestamps such as observation ID, trace ID, type, and start or end time.",
  },
  {
    value: "basic",
    label: "Basic",
    description:
      "Names, levels, environments, session or user references, and other general observation attributes.",
  },
  {
    value: "time",
    label: "Time",
    description:
      "Additional timing fields such as completion start time and record creation or update timestamps.",
  },
  {
    value: "io",
    label: "Input / Output",
    description:
      "Observation input and output payloads. Usually the largest part of the export.",
  },
  {
    value: "metadata",
    label: "Metadata",
    description:
      "Structured metadata attached to observations, including stored metadata arrays for enriched observations.",
  },
  {
    value: "model",
    label: "Model",
    description: "Model names and parameters used by the observation.",
  },
  {
    value: "usage",
    label: "Usage & Cost",
    description:
      "Usage details, cost details, and aggregated total cost fields.",
  },
  {
    value: "prompt",
    label: "Prompt",
    description:
      "Prompt identifiers, names, and versions linked to the observation.",
  },
  {
    value: "metrics",
    label: "Metrics",
    description: "Latency and time-to-first-token style performance metrics.",
  },
  {
    value: "trace_context",
    label: "Trace Context",
    description:
      "Trace-level context such as trace name, release, and tags linked to the observation.",
  },
];
