import { JsonNested } from "../../utils/zod";
import { parseJsonPrioritised } from "../../utils/json";
import { env } from "../../env";

/**
 * Rendering properties used to control how data is processed and returned
 * in tRPC routes and repository functions.
 */
export interface RenderingProps {
  /**
   * Whether to truncate input/output fields to a specific character limit
   */
  truncated: boolean;

  /**
   * Whether to skip JSON parsing of input/output fields and return them as raw strings.
   * This is useful when the client will handle JSON parsing to avoid double parsing.
   */
  shouldJsonParse: boolean;
}

/**
 * Default rendering properties
 */
export const DEFAULT_RENDERING_PROPS: RenderingProps = {
  truncated: false,
  shouldJsonParse: true,
};

/**
 * Transform input/output fields based on rendering properties.
 */
export const applyInputOutputRendering = (
  io: unknown,
  renderingProps: RenderingProps,
): JsonNested | string | null => {
  if (!io) return null;

  // If io is an object (not a string), stringify it first.
  // When shouldJsonParse is true, we re-parse the stringified object to normalize.
  // When shouldJsonParse is false, we return the stringified result (maintaining the first commit's fix).
  if (typeof io === "object" && io !== null) {
    const stringified = JSON.stringify(io);
    return renderingProps.shouldJsonParse
      ? (parseJsonPrioritised(stringified) ?? null)
      : stringified;
  }

  // For string input, handle truncation. Coerce any remaining non-string
  // primitive (number/boolean) to its string form for safety.
  let result: string = typeof io === "string" ? io : String(io);

  if (
    renderingProps.truncated &&
    result.length > env.LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT
  ) {
    result =
      result.slice(0, env.LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT) +
      "...[truncated]";
  }

  if (
    renderingProps.truncated &&
    result.length === env.LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT
  ) {
    result = result + "...[truncated]";
  }

  return renderingProps.shouldJsonParse && typeof result === "string"
    ? (parseJsonPrioritised(result) ?? null)
    : result;
};
