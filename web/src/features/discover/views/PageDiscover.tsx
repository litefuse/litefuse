// @ts-nocheck
import React from "react";
import { css } from "@emotion/css";
import { LoadingBar } from "components/ui/loading-bar";
import DiscoverFilter from "components/discover-filter";
import DiscoverSidebar from "components/discover-sidebar";
import { DiscoverHistogram } from "components/discover-histogram";
import DiscoverContent from "components/discover-content";
import DiscoverHeader from "../components/discover-header";
import { testIds } from "../components/testIds";
import { useDiscoverData } from "./PageDiscover/useDiscoverData";

export default function PageDiscover() {
  const { loading, onQuerying } = useDiscoverData();
  const overrideClassName = css`
    [data-discover-controls] > div {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }

    [data-discover-controls] > div:first-of-type {
      padding: 0.85rem 1rem 0.7rem !important;
      border-bottom: 1px solid hsl(var(--border) / 0.85) !important;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    [data-discover-controls] > div:nth-of-type(2) {
      padding: 0.75rem 1rem 0 !important;
    }

    [data-discover-controls] > div:last-of-type {
      margin-top: 0 !important;
      padding: 0.7rem 1rem 0.9rem !important;
      border-radius: 0 !important;
      border-top: 1px solid hsl(var(--border) / 0.6);
    }

    [data-discover-sidebar] > div > div {
      background: transparent !important;
      box-shadow: none !important;
    }

    [data-discover-sidebar] > div > div:first-of-type {
      padding: 0 0 0.9rem !important;
      border-bottom: 1px solid hsl(var(--border) / 0.8);
      gap: 0.75rem;
    }

    [data-discover-sidebar] > div > div:last-of-type {
      margin-top: 0 !important;
      padding: 0.9rem 0 0 !important;
    }

    [data-discover-content] > div:first-of-type {
      overflow-x: auto;
    }

    [data-discover-content] table {
      min-width: 100%;
    }
  `;

  return (
    <div className={`flex h-full w-full flex-col ${overrideClassName}`}>
      {/* Query Builder toolbar */}
      <div
        data-discover-controls
        data-testid={testIds.pageTwo.container}
        className="border-border/70 shrink-0 border-b"
      >
        <DiscoverHeader
          onQuerying={onQuerying}
          loading={loading.getTableData || loading.getTableDataCharts}
        />
        <DiscoverFilter />
      </div>

      {/* Main content area */}
      <div className="grid min-h-0 flex-1 xl:grid-cols-[18rem_minmax(0,1fr)]">
        {/* Sidebar */}
        <div
          data-discover-sidebar
          className="border-border/70 overflow-auto border-r p-4"
        >
          <DiscoverSidebar />
        </div>

        {/* Histogram + table */}
        <div className="relative min-h-0 overflow-auto">
          <div className="pointer-events-none sticky inset-x-0 top-0 z-10">
            {loading.getTableDataCharts && <LoadingBar width={100} />}
          </div>
          <div className="border-border/80 border-b px-4 py-4 sm:px-5">
            <DiscoverHistogram />
          </div>
          <div data-discover-content className="px-2 pb-2 sm:px-3">
            <DiscoverContent fetchNextPage={() => {}} />
          </div>
        </div>
      </div>
    </div>
  );
}
