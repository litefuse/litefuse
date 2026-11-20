import { useMemo } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

const ALLOWED_PAGES = new Set([
  "catalog",
  "runs",
  "tools",
  "physical",
  "requests",
  "detail",
  "home",
]);

/**
 * Local standalone preview of Persisting / pChronicle via port 3000.
 * Keeps /pchronicle in the address bar; Chronicle loads in a full-viewport iframe.
 */
export default function PChroniclePreviewPage() {
  const router = useRouter();

  const src = useMemo(() => {
    const raw =
      typeof router.query.page === "string" ? router.query.page : "catalog";
    const page = ALLOWED_PAGES.has(raw) ? raw : "catalog";
    return `/api/persisting/frame?page=${encodeURIComponent(page)}&embed=0`;
  }, [router.query.page]);

  return (
    <>
      <Head>
        <title>pChronicle</title>
      </Head>
      <iframe
        src={src}
        title="pChronicle"
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
          background: "#f5f7fa",
        }}
      />
    </>
  );
}
