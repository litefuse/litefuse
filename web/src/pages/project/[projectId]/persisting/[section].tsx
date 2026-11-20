import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import {
  buildChronicleEmbedUrl,
  chroniclePageForSection,
  navigateChronicleEmbed,
} from "@/src/features/persisting/chronicleUrl";

const SECTIONS: Record<string, string> = {
  datasets: "Datasets",
  runs: "Runs",
  analysis: "Analysis",
  storage: "Storage",
  requests: "Requests",
};

/** Match Chronicle content surface — covers the dark shell while the iframe boots. */
const EMBED_SURFACE = "#f5f7fa";

const EMBED_BOOT_CSS = `
html, body, #main {
  height: 100% !important;
  max-height: 100% !important;
  overflow: hidden !important;
  background: ${EMBED_SURFACE} !important;
}
.pc2-shell, .pc2-shell.embed {
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
  background: ${EMBED_SURFACE} !important;
}
`;

function applyEmbedBootStyles(doc: Document) {
  if (doc.getElementById("deeptrace-embed-height")) return;
  const style = doc.createElement("style");
  style.id = "deeptrace-embed-height";
  style.textContent = EMBED_BOOT_CSS;
  doc.head.appendChild(style);
}

function resolveSection(querySection: string, asPath: string): string {
  if (SECTIONS[querySection]) return querySection;
  const fromPath = asPath.match(/\/persisting\/([^/?#]+)/)?.[1] ?? "";
  return SECTIONS[fromPath] ? fromPath : "";
}

function embedPageMatches(win: Window, section: string): boolean {
  const current = new URLSearchParams(win.location.search).get("page");
  return current === chroniclePageForSection(section);
}

function initialEmbedSrc(section: string): string {
  if (!section || typeof window === "undefined") return "";
  return buildChronicleEmbedUrl(section);
}

export default function PersistingSectionPage() {
  const router = useRouter();
  const querySection =
    typeof router.query.section === "string" ? router.query.section : "";
  const section = resolveSection(querySection, router.asPath);
  const title = SECTIONS[section] ?? "Datasets";

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const sectionRef = useRef(section);
  // Sync src on first client paint so we never flash an empty dark frame.
  const [iframeSrc, setIframeSrc] = useState(() => initialEmbedSrc(section));
  // Hide iframe until first paint completes (entry from other Litefuse routes).
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    sectionRef.current = section;
  }, [section]);

  useEffect(() => {
    if (!section || typeof window === "undefined") return;

    if (!iframeSrc) {
      setFrameReady(false);
      readyRef.current = false;
      setIframeSrc(buildChronicleEmbedUrl(section));
      return;
    }

    const win = iframeRef.current?.contentWindow;
    if (readyRef.current && win) {
      try {
        if (!embedPageMatches(win, section)) {
          navigateChronicleEmbed(win, section);
        }
        return;
      } catch {
        // Cross-origin — fall through to a hard src update.
      }
    }

    // Frame not ready yet; keep the pending document URL in sync with the tab.
    if (!readyRef.current) {
      const nextSrc = buildChronicleEmbedUrl(section);
      if (nextSrc !== iframeSrc) {
        setFrameReady(false);
        setIframeSrc(nextSrc);
      }
    }
  }, [section, iframeSrc]);

  return (
    <Page
      headerProps={{
        title,
        help: {
          description: `Persisting Chronicle ${title} view.`,
        },
      }}
    >
      <div
        className="relative min-h-0 w-full flex-1"
        style={{ background: EMBED_SURFACE }}
      >
        {/* Stays visible until iframe onLoad — prevents dark Chronicle shell flash. */}
        {!frameReady ? (
          <div
            aria-hidden
            className="absolute inset-0 z-10"
            style={{ background: EMBED_SURFACE }}
          />
        ) : null}
        {iframeSrc ? (
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            title={title}
            className="absolute inset-0 h-full w-full border-0"
            style={{
              background: EMBED_SURFACE,
              opacity: frameReady ? 1 : 0,
            }}
            onLoad={() => {
              readyRef.current = true;
              const frame = iframeRef.current;
              const win = frame?.contentWindow;
              const doc = frame?.contentDocument;
              if (doc) {
                try {
                  applyEmbedBootStyles(doc);
                } catch {
                  // Height/boot CSS also ships via frame proxy / Chronicle assets.
                }
              }
              const current = sectionRef.current;
              if (win && current) {
                try {
                  if (!embedPageMatches(win, current)) {
                    navigateChronicleEmbed(win, current);
                  }
                } catch {
                  // Initial src already targets the first section.
                }
              }
              setFrameReady(true);
            }}
          />
        ) : null}
      </div>
    </Page>
  );
}
