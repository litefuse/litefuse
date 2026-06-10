import { parseJsonPrioritised } from "../../utils/json";
import { MetadataDomain } from "../../domain";

export function parseMetadataCHRecordToDomain(
  metadata: Record<string, string> | string,
): MetadataDomain {
  if (!metadata) return {};

  // Doris returns metadata as a JSON string, ClickHouse returns it as a Record
  let parsed: Record<string, string>;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {};
      }
    } catch {
      return {};
    }
  } else {
    parsed = metadata;
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, val]) => [
      key,
      val === null ? null : parseJsonPrioritised(val),
    ]),
  );
}
