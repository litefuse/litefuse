import type { z } from "zod/v4";
import type { ChatMlMessageSchema } from "@/src/components/schemas/ChatMlSchema";
import type { combineInputOutputMessages } from "@/src/utils/chatml";
import type { TFunction } from "i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

export type ChatMlMessage = z.infer<typeof ChatMlMessageSchema>;

/**
 * Get display title for a message based on name or role.
 *
 * Returns the raw value: it doubles as the panel-role discriminator in the
 * viewers. Use getMessageLabel for the text a person reads.
 */
export function getMessageTitle(message: ChatMlMessage): string {
  return message.name ?? message.role ?? "";
}

/** Chat roles arrive from the SDK; these are the labels shown for them. */
const roleLabels: Record<string, string> = {
  system: i18nKey("System"),
  developer: i18nKey("Developer"),
  assistant: i18nKey("Assistant"),
  user: i18nKey("User"),
  tool: i18nKey("Tool"),
};

/**
 * The visible caption. A message `name` is user data and is shown verbatim;
 * only a known role gets translated.
 */
export function getMessageLabel(message: ChatMlMessage, t: TFunction): string {
  if (message.name) return message.name;
  const role = message.role ?? "";
  const label = roleLabels[role.toLowerCase()];
  return label ? t(label) : role;
}

/**
 * Check if message has renderable content (text or audio).
 */
export function hasRenderableContent(message: ChatMlMessage): boolean {
  const hasContent = message.content != null && message.content !== "";
  return hasContent || !!message.audio;
}

/**
 * Check if message has additional data beyond role and content.
 */
export function hasAdditionalData(message: ChatMlMessage): boolean {
  const messageKeys = Object.keys(message).filter(
    (key) => key !== "role" && key !== "content",
  );
  return messageKeys.length > 0;
}

/**
 * Check if message has passthrough JSON data.
 */
export function hasPassthroughJson(message: ChatMlMessage): boolean {
  return message.json != null;
}

/**
 * Check if message is a placeholder type.
 */
export function isPlaceholderMessage(message: ChatMlMessage): boolean {
  return message.type === "placeholder";
}

/**
 * Check if message only has JSON (no valid ChatML content).
 * Message parsed as ChatML but only has json field (non-ChatML object).
 * Valid ChatML needs content OR tool_calls OR audio (role alone is insufficient).
 */
export function isOnlyJsonMessage(message: ChatMlMessage): boolean {
  const hasValidChatMlContent =
    message.content != null ||
    message.tool_calls != null ||
    message.audio != null;
  return !hasValidChatMlContent && message.json != null;
}

/**
 * Check if message should be rendered (has content, audio, additional data, or is placeholder).
 */
export function shouldRenderMessage(message: ChatMlMessage): boolean {
  return (
    hasRenderableContent(message) ||
    hasAdditionalData(message) ||
    isPlaceholderMessage(message)
  );
}

/**
 * Parse tool calls from a ChatML message.
 * Handles both standard tool_calls array and passthrough json.tool_calls.
 */
export function parseToolCallsFromMessage(
  message: ReturnType<typeof combineInputOutputMessages>[0],
): unknown[] {
  return message.tool_calls && Array.isArray(message.tool_calls)
    ? message.tool_calls
    : message.json?.tool_calls && Array.isArray(message.json?.tool_calls)
      ? message.json.tool_calls
      : [];
}

/**
 * Check if message has thinking content.
 */
export function hasThinkingContent(message: ChatMlMessage): boolean {
  return Array.isArray(message.thinking) && message.thinking.length > 0;
}

/**
 * Check if message has redacted thinking content.
 */
export function hasRedactedThinkingContent(message: ChatMlMessage): boolean {
  return (
    Array.isArray(message.redacted_thinking) &&
    message.redacted_thinking.length > 0
  );
}
