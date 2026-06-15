// @ts-nocheck
/**
 * Shim for jotai-location
 *
 * `atomWithLocation` normally syncs a jotai atom with window.location.
 * In Next.js, URL sync is handled via next/router.  This stub keeps the
 * atom in memory so callers compile and query-param writing is a no-op.
 * For full URL persistence, individual components should use useRouter.
 */
import { atom } from "jotai";

interface LocationValue {
  pathname?: string;
  searchParams?: URLSearchParams;
}

export function atomWithLocation() {
  const initial: LocationValue =
    typeof window !== "undefined"
      ? {
          pathname: window.location.pathname,
          searchParams: new URLSearchParams(window.location.search),
        }
      : {};

  return atom<LocationValue>(initial);
}
