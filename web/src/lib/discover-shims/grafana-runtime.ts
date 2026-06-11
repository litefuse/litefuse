/**
 * Shim for @grafana/runtime
 *
 * Replaces Grafana's backend service with a plain fetch call to the
 * Next.js API route /api/project/[projectId]/discover-query.
 *
 * The projectId is injected at runtime via `setDiscoverProjectId()`.
 */
import React from "react";
import { Observable } from "rxjs";

// ---------------------------------------------------------------------------
// Project-ID injection
// ---------------------------------------------------------------------------

let _projectId = "";

function getProjectIdFromPathname(pathname: string) {
  const match = pathname.match(/^\/project\/([^/]+)\/logging(?:\/|$)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function resolveDiscoverProjectId() {
  if (_projectId) {
    return _projectId;
  }

  if (typeof window === "undefined") {
    return "";
  }

  return getProjectIdFromPathname(window.location.pathname);
}

export function setDiscoverProjectId(projectId: string) {
  _projectId = projectId;
}

export function getDiscoverProjectId() {
  return resolveDiscoverProjectId();
}

// ---------------------------------------------------------------------------
// getBackendSrv  (returned object mimics Grafana's BackendSrv)
// ---------------------------------------------------------------------------

interface FetchOptions {
  url: string;
  method?: string;
  data?: any;
  credentials?: string;
}

interface FetchResponse<T = any> {
  data: T;
  ok: boolean;
  status: number;
}

export function getBackendSrv() {
  return {
    fetch<T = any>(options: FetchOptions): Observable<FetchResponse<T>> {
      return new Observable<FetchResponse<T>>((subscriber) => {
        const { data } = options;
        const projectId = resolveDiscoverProjectId();

        fetch(`/api/project/${projectId}/discover-query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ queries: data?.queries ?? [] }),
        })
          .then(async (res) => {
            const json = await res.json();
            subscriber.next({ data: json, ok: res.ok, status: res.status });
            subscriber.complete();
          })
          .catch((err) => {
            subscriber.error(err);
          });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// getDataSourceSrv  (no real datasources in Next.js — return empty list)
// ---------------------------------------------------------------------------

export function getDataSourceSrv() {
  return {
    getList() {
      return [];
    },
    get() {
      return Promise.resolve(null);
    },
  };
}

// ---------------------------------------------------------------------------
// createQueryRunner  (stub — query running is handled via getBackendSrv())
// ---------------------------------------------------------------------------

export function createQueryRunner() {
  return {
    run: (_options: any) => {},
    getFullData: () => ({ errors: [], series: [] }),
  };
}

// ---------------------------------------------------------------------------
// DataSourcePicker  (replaced by static label — no datasource selection needed)
// ---------------------------------------------------------------------------

interface DataSourcePickerProps {
  width?: number;
  type?: string;
  current?: any;
  placeholder?: string;
  noDefault?: boolean;
  filter?: (ds: any) => boolean;
  onChange?: (item: any) => void;
  [key: string]: any;
}

export function DataSourcePicker(_props: DataSourcePickerProps) {
  return React.createElement(
    "span",
    { className: "text-xs text-muted-foreground" },
    "Apache Doris",
  );
}

// ---------------------------------------------------------------------------
// PluginPage
// ---------------------------------------------------------------------------

export function PluginPage({
  children,
  className,
}: {
  children?: React.ReactNode;
  pageNav?: any;
  className?: string;
}) {
  return React.createElement(
    "div",
    { className: className ?? "flex flex-col" },
    children,
  );
}

// ---------------------------------------------------------------------------
// PanelRenderer  (stub — not used in discover/traces flow)
// ---------------------------------------------------------------------------

export function PanelRenderer(_props: any) {
  return null;
}
