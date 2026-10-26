import { useEffect, useRef, useState } from "react";
import {
  copyRichTextToClipboard,
  copyTextToClipboard,
} from "@/src/utils/clipboard";

/**
 * Copies text to the clipboard and exposes a temporary success state for UI feedback.
 */
export function useCopyToClipboard({
  successDuration = 1_000,
}: {
  successDuration?: number;
} = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const runCopy = async (copyToClipboard: () => Promise<void> | void) => {
    setIsCopied(true);
    try {
      await copyToClipboard();
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setIsCopied(false);
      }, successDuration);
    }
  };

  // LITEFUSE NOTE: our clipboard helpers report success with a `boolean`, while
  // this hook (ported from upstream) only waits for completion. Await and drop the
  // result so the callback signatures line up.
  const copy = async (text: string) => {
    await runCopy(async () => {
      await copyTextToClipboard(text);
    });
  };

  const copyRich = async (content: { text: string; html: string }) => {
    await runCopy(async () => {
      await copyRichTextToClipboard(content);
    });
  };

  return { copy, copyRich, isCopied };
}
