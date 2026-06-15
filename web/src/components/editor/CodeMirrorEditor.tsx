import CodeMirror, {
  EditorView,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, type Diagnostic } from "@codemirror/lint";
import { useTheme } from "next-themes";
import { cn } from "@/src/utils/tailwind";
import {
  useState,
  useCallback,
  type MutableRefObject,
  type RefObject,
} from "react";
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { StringStream } from "@codemirror/language";
import {
  isValidVariableName,
  MULTILINE_VARIABLE_REGEX,
  MUSTACHE_REGEX,
  UNCLOSED_VARIABLE_REGEX,
  PromptDependencyRegex,
  parsePromptDependencyTags,
} from "@langfuse/shared";
import { lightTheme } from "@/src/components/editor/light-theme";
import { darkTheme } from "@/src/components/editor/dark-theme";

// Global composition state tracker to prevent search updates during IME input
// This is a WeakMap so it automatically garbage collects when editors are destroyed
const compositionState = new WeakMap<EditorView, boolean>();

// Custom language mode for prompts that highlights mustache variables and prompt dependency tags
const promptLanguage = StreamLanguage.define({
  name: "prompt",
  startState: () => ({}),
  token: (stream: StringStream) => {
    // Highlight prompt tags
    if (stream.match("@@@langfusePrompt:")) {
      stream.skipTo("@@@") || stream.skipToEnd();
      stream.match("@@@");

      return "keyword";
    }

    // Highlight mustache variables
    if (stream.match("{{")) {
      const start = stream.pos;
      stream.skipTo("}}") || stream.skipToEnd();
      const content = stream.string.slice(start, stream.pos);
      stream.match("}}");
      return isValidVariableName(content) ? "variable" : "error";
    }
    stream.next();
    return null;
  },
});

// Linter for prompt variables
const promptLinter = linter((view) => {
  const diagnostics: Diagnostic[] = [];
  const content = view.state.doc.toString();

  // Check for multiline variables
  for (const match of content.matchAll(MULTILINE_VARIABLE_REGEX)) {
    diagnostics.push({
      from: match.index,
      to: match.index + match[0].length,
      severity: "error",
      message: "Variables cannot span multiple lines",
    });
  }

  // Check for unclosed variables
  for (const match of content.matchAll(UNCLOSED_VARIABLE_REGEX)) {
    diagnostics.push({
      from: match.index,
      to: match.index + 2,
      severity: "error",
      message: "Unclosed variable brackets",
    });
  }

  // Check variable format
  for (const match of content.matchAll(MUSTACHE_REGEX)) {
    const variable = match[1];
    if (!variable || variable.trim() === "") {
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: "error",
        message: "Empty variable is not allowed",
      });
    } else if (!isValidVariableName(variable)) {
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: "error",
        message:
          "Variable must start with a letter and can only contain letters and underscores",
      });
    }
  }

  // Check for malformed prompt dependency tags
  for (const match of content.matchAll(PromptDependencyRegex)) {
    const tagContent = match[0];
    try {
      const parsedTags = parsePromptDependencyTags(tagContent);

      if (parsedTags.length === 0) {
        diagnostics.push({
          from: match.index,
          to: match.index + match[0].length,
          severity: "warning",
          message: "Malformed prompt dependency tag",
        });
      }
    } catch {
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: "warning",
        message: "Invalid prompt dependency tag format",
      });
    }
  }

  return diagnostics;
});

// Create a language support instance that combines the language and its configuration
const promptSupport = new LanguageSupport(promptLanguage);

export function applyCodeMirrorSearchQuery(
  editorRef: RefObject<ReactCodeMirrorRef | null> | undefined,
  searchValue: string,
) {
  const view = editorRef?.current?.view;
  if (!view) {
    return;
  }

  try {
    // Skip search updates during IME composition to prevent position mapping errors
    if (compositionState.get(view)) {
      return;
    }

    // Get current document length to validate search won't cause issues
    const docLength = view.state.doc.length;

    // If document is empty or very short, skip search operations
    // This prevents position mapping errors when document changes
    if (docLength === 0) {
      return;
    }

    // If clearing search, also clear selection to avoid position mapping issues
    // when document content changes (e.g., message deleted)
    if (searchValue === "") {
      view.dispatch({
        selection: { anchor: 0, head: 0 },
        scrollIntoView: false,
      });
    }

    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: searchValue,
          caseSensitive: false,
          literal: true,
        }),
      ),
    });
  } catch (error) {
    // Ignore search-related errors during document changes
    // This can happen when the document content is externally modified
    // (e.g., React re-renders with new value prop) while search is active
    console.warn("Search query update failed:", error);
  }
}

export function selectCodeMirrorRange(
  editorRef: RefObject<ReactCodeMirrorRef | null> | undefined,
  range: { from: number; to: number } | null,
) {
  const view = editorRef?.current?.view;
  if (!view || !range) {
    return;
  }

  try {
    const docLength = view.state.doc.length;

    // Clamp positions to valid range [0, docLength]
    const from = Math.max(0, Math.min(range.from, docLength));
    const to = Math.max(0, Math.min(range.to, docLength));

    // If the clamped range would be inverted or empty, just place cursor at end
    if (from >= docLength || to === 0) {
      view.dispatch({
        selection: { anchor: docLength, head: docLength },
        scrollIntoView: true,
      });
      return;
    }

    view.dispatch({
      selection: {
        anchor: from,
        head: to,
      },
      scrollIntoView: true,
    });
  } catch (error) {
    // Ignore position mapping errors during document changes
    console.warn("Range selection failed:", error);
  }
}

export function CodeMirrorEditor({
  value,
  onChange,
  editable = true,
  lineWrapping = true,
  lineNumbers = true,
  className,
  onBlur,
  mode,
  minHeight,
  maxHeight,
  placeholder,
  editorRef,
  enableSearchKeymap = true,
  onEditorMount,
}: {
  value: string;
  onChange?: (value: string) => void;
  editable?: boolean;
  onBlur?: () => void;
  lineNumbers?: boolean;
  lineWrapping?: boolean;
  className?: string;
  mode: "json" | "text" | "prompt";
  minHeight?: number | string;
  maxHeight?: number | string;
  placeholder?: string;
  editorRef?: RefObject<ReactCodeMirrorRef | null>;
  enableSearchKeymap?: boolean;
  onEditorMount?: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const codeMirrorTheme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  // used to disable linter when field is empty
  const [linterEnabled, setLinterEnabled] = useState<boolean>(
    !!value && value !== "",
  );

  // Track composition state to avoid CodeMirror errors during IME input

  const handleEditorRef = useCallback(
    (instance: ReactCodeMirrorRef | null) => {
      if (editorRef) {
        (editorRef as MutableRefObject<ReactCodeMirrorRef | null>).current =
          instance;
      }

      if (instance) {
        onEditorMount?.();
      }
    },
    [editorRef, onEditorMount],
  );

  return (
    <CodeMirror
      value={value}
      theme={codeMirrorTheme}
      ref={editorRef || onEditorMount ? handleEditorRef : undefined}
      basicSetup={false}
      lang={mode === "json" ? "json" : undefined}
      extensions={[
        // Line wrapping
        ...(lineWrapping ? [EditorView.lineWrapping] : []),

        // Only add json mode if needed
        ...(mode === "json" ? [json()] : []),

        // Only add json linter if needed and enabled
        ...(mode === "json" && linterEnabled
          ? [linter(jsonParseLinter())]
          : []),

        // Only add prompt support in prompt mode
        ...(mode === "prompt" ? [promptSupport, promptLinter] : []),

        // Theme to remove outline and set content styles
        EditorView.theme({
          "&.cm-focused": {
            outline: "none",
          },
          ".cm-content": {
            ...(minHeight
              ? {
                  minHeight:
                    typeof minHeight === "number"
                      ? `${minHeight}px`
                      : minHeight,
                }
              : {}),
          },
          ".cm-scroller": {
            overflow: "auto",
          },
        }),
      ]}
      defaultValue={value}
      onChange={(c) => {
        if (onChange) onChange(c);
        setLinterEnabled(c !== "");
      }}
      onBlur={onBlur}
      className={cn(
        "overflow-hidden overflow-y-auto rounded-md border text-xs",
        className,
      )}
      editable={editable}
      placeholder={placeholder}
    />
  );
}
