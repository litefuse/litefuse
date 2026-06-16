/**
 * Helpers for deciding whether an OTel batch is eligible for the v4
 * direct-event-write path.
 *
 * Used by both the web OTel route (synchronous direct write) and the
 * legacy worker queue handler (will be removed after the direct path is
 * the only one). Lives in shared so both can import from one place.
 */

import { compareVersions } from "../utils/compareVersions";
import { logger } from "../logger";
import type { ResourceSpan } from "./OtelIngestionProcessor";

/**
 * Check if HTTP headers from the SDK request indicate the batch is eligible
 * for direct event writes.
 *
 * Requirements:
 * - x-langfuse-sdk-name "python" with x-langfuse-sdk-version >= 4.0.0
 * - x-langfuse-sdk-name "javascript" with x-langfuse-sdk-version >= 5.0.0
 * - x-langfuse-ingestion-version === "4" (custom OTel exporter opt-in)
 */
export function checkHeaderBasedDirectWrite(params: {
  sdkName?: string;
  sdkVersion?: string;
  ingestionVersion?: string;
}): boolean {
  const { sdkName, sdkVersion, ingestionVersion } = params;

  // Check x-langfuse-ingestion-version (>= 4 means direct write eligible).
  // Values > 4 are rejected at the API route, so anything reaching here is valid.
  const parsed = ingestionVersion ? parseInt(ingestionVersion, 10) : NaN;
  if (!isNaN(parsed) && parsed >= 4) {
    return true;
  }

  // Check Langfuse SDK name + version
  if (!sdkName || !sdkVersion) {
    return false;
  }

  try {
    // compareVersions returns null when current >= minimum (no update needed).
    // Strip pre-release/build metadata so that e.g. 4.0.0-rc.1 qualifies as 4.0.0.
    // Also normalize Python PEP440 shorthand (e.g. 4.0.0b1, 4.0.0rc1) to the core version.
    const baseVersion = extractBaseSdkVersion(sdkVersion);

    if (sdkName === "python") {
      return compareVersions(baseVersion, "v4.0.0") === null;
    }

    if (sdkName === "javascript") {
      return compareVersions(baseVersion, "v5.0.0") === null;
    }
  } catch {
    logger.warn(
      `Failed to parse SDK version from headers: ${sdkName}@${sdkVersion}`,
    );
  }

  return false;
}

export function extractBaseSdkVersion(sdkVersion: string): string {
  const version = sdkVersion.trim();

  // Standard semver / semver pre-release / build metadata
  if (/^v?\d+\.\d+\.\d+(?:[-+].+)?$/i.test(version)) {
    return version.split(/[-+]/)[0];
  }

  // Python PEP 440 pre-release shorthand: 4.0.0a1, 4.0.0b1, 4.0.0rc1
  const pep440Match = version.match(/^(v?\d+\.\d+\.\d+)(?:a|b|rc)\d+$/i);
  if (pep440Match?.[1]) {
    return pep440Match[1];
  }

  return version;
}

/**
 * SDK information extracted from OTEL resourceSpans.
 */
export type SdkInfo = {
  scopeName: string | null;
  scopeVersion: string | null;
  telemetrySdkLanguage: string | null;
};

/**
 * Extract SDK information from resourceSpans.
 * Gets scope name/version and telemetry SDK language from the OTEL structure.
 */
export function getSdkInfoFromResourceSpans(
  resourceSpans: ResourceSpan,
): SdkInfo {
  try {
    // Get the first scopeSpan (all spans in a batch share the same scope)
    const firstScopeSpan = resourceSpans?.scopeSpans?.[0];
    const scopeName = firstScopeSpan?.scope?.name ?? null;
    const scopeVersion = firstScopeSpan?.scope?.version ?? null;

    // Extract telemetry SDK language from resource attributes
    const resourceAttributes = resourceSpans?.resource?.attributes ?? [];
    const telemetrySdkLanguage =
      resourceAttributes.find((attr) => attr.key === "telemetry.sdk.language")
        ?.value?.stringValue ?? null;

    return { scopeName, scopeVersion, telemetrySdkLanguage };
  } catch (error) {
    logger.warn("Failed to extract SDK info from resourceSpans", error);
    return { scopeName: null, scopeVersion: null, telemetrySdkLanguage: null };
  }
}

/**
 * Check if SDK meets version requirements for direct event writes.
 *
 * Requirements:
 * - Scope name must contain 'langfuse' (case-insensitive)
 * - Python SDK: scope_version >= 3.9.0
 * - JS/JavaScript SDK: scope_version >= 4.4.0
 */
export function checkSdkVersionRequirements(
  sdkInfo: SdkInfo,
  isSdkExperimentBatch: boolean,
): boolean {
  const { scopeName, scopeVersion, telemetrySdkLanguage } = sdkInfo;

  // Must be a Langfuse SDK
  if (!scopeName || !String(scopeName).toLowerCase().includes("langfuse")) {
    return false;
  }

  if (!scopeVersion || !telemetrySdkLanguage) {
    return false;
  }

  try {
    // Python SDK >= 3.9.0
    if (telemetrySdkLanguage === "python" && isSdkExperimentBatch) {
      const comparison = compareVersions(scopeVersion, "v3.9.0");
      return comparison === null; // null means current >= latest
    }

    // JS/JavaScript SDK >= 4.4.0
    if (
      (telemetrySdkLanguage === "js" ||
        telemetrySdkLanguage === "javascript") &&
      isSdkExperimentBatch
    ) {
      const comparison = compareVersions(scopeVersion, "v4.4.0");
      return comparison === null; // null means current >= latest
    }

    return false;
  } catch (error) {
    logger.warn(
      `Failed to parse SDK version ${scopeVersion} for language ${telemetrySdkLanguage}`,
      error,
    );
    return false;
  }
}
