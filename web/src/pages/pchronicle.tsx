import { useMemo } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { useTranslation } from "react-i18next";
import { env } from "@/src/env.mjs";

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
 * Local standalone preview of Persisting / Chronicle via port 3000.
 * Keeps /pchronicle in the address bar; Chronicle loads in a full-viewport iframe.
 * Dev-only — returns 404 in production.
 */
export default function PChroniclePreviewPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const src = useMemo(() => {
    const raw =
      typeof router.query.page === "string" ? router.query.page : "catalog";
    const page = ALLOWED_PAGES.has(raw) ? raw : "catalog";
    const basePath = env.NEXT_PUBLIC_BASE_PATH ?? "";
    return `${basePath}/api/persisting/frame?page=${encodeURIComponent(page)}&embed=0`;
  }, [router.query.page]);

  return (
    <>
      <Head>
        <title>{t("Chronicle Preview")}</title>
      </Head>
      <iframe
        src={src}
        title={t("Chronicle Preview")}
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

export function getServerSideProps() {
  if (process.env.NODE_ENV === "production") {
    return { notFound: true as const };
  }
  return { props: {} };
}
