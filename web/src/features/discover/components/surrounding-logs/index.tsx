// @ts-nocheck
"use client";

import { showErrorToast } from "@/src/features/notifications/showErrorToast";
import type { Row, ColumnDef } from "@tanstack/react-table";
import JsonView from "@uiw/react-json-view";
import React, { useEffect, useMemo, useState } from "react";
import {
  ColumnStyleWrapper,
  HoverStyle,
} from "../discover-content/discover-content.style";
import {
  SELECTDB_THEME,
  SELECTDB_THEME_LIGHT,
} from "../discover-content/json-viewer.theme";
import { useAtom, useAtomValue } from "jotai";
import { useRequest } from "ahooks";
import { css } from "@emotion/css";
import { useRouter } from "next/router";
import { SurroundingContentItem } from "./surrounding-content-item";
import { SurroundingLogsActions } from "./logs-actions";
import SurroundingDiscoverFilter from "./discover-filter";
import { Button } from "components/ui/button";
import { IconButton } from "components/ui/icon-button";
import { LoadingBar } from "components/ui/loading-bar";
import { Tab, TabContent, TabsBar } from "components/ui/tabs";
import { useDiscoverTheme } from "components/ui/theme";
import type { SurroundingParams } from "./types";
import SDCollapsibleTable from "components/selectdb-ui/sd-collapsible-table";
import {
  selectedRowAtom,
  currentTimeFieldAtom,
  currentClusterAtom,
  currentTableAtom,
  currentCatalogAtom,
  currentDatabaseAtom,
  surroundingTableDataAtom,
  afterCountAtom,
  afterTimeAtom,
  afterTimeFieldPageSizeAtom,
  beforeCountAtom,
  beforeTimeAtom,
  beforeTimeFieldPageSizeAtom,
  surroundingDataFilterAtom,
  surroundingSelectedFieldsAtom,
} from "store/discover";
// import dayjs from 'dayjs';
import { get, sortBy } from "lodash-es";
import { getSurroundingDataService } from "services/discover";
import { convertRowsToTableData, formatTimestampToDateTime } from "utils/data";
import { generateTableDataUID } from "utils/utils";
import { SurroundingContentTableActions } from "./content/content-table-actions";

export default function SurroundingLogs() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const theme = useDiscoverTheme();
  const selectedRow = useAtomValue(selectedRowAtom);
  const currentTimeField = useAtomValue(currentTimeFieldAtom);
  const [selectedSurroundingFields, setSelectedSurroundingFields] = useAtom(
    surroundingSelectedFieldsAtom,
  );
  const [surroundingDataFilter] = useAtom<any>(surroundingDataFilterAtom);
  const hasSelectedFields = selectedSurroundingFields.length > 0;
  const [fields, setFields] = useState<any[]>([]);
  const currentCluster = useAtomValue(currentClusterAtom);
  const currentTable = useAtomValue(currentTableAtom);
  const currentCatalog = useAtomValue(currentCatalogAtom);
  const currentDatabase = useAtomValue(currentDatabaseAtom);
  const [surroundingTableData, setSurroundingTableData] = useAtom(
    surroundingTableDataAtom,
  );
  const [beforeCount, setBeforeCount] = useAtom(beforeCountAtom);
  const [afterCount, setAfterCount] = useAtom(afterCountAtom);
  const [beforeTimeFieldPageSize, setBeforeTimeFieldPageSize] = useAtom(
    beforeTimeFieldPageSizeAtom,
  );
  const [afterTimeFieldPageSize, setAfterTimeFieldPageSize] = useAtom(
    afterTimeFieldPageSizeAtom,
  );
  const [beforeTime, setBeforeTime] = useAtom(beforeTimeAtom);
  const [afterTime, setAfterTime] = useAtom(afterTimeAtom);
  const [state, updateState] = useState([
    {
      label: "Table",
      value: "Table",
      active: true,
    },
    {
      label: "JSON",
      value: "JSON",
      active: false,
    },
  ]);

  function handleRemove(field: any) {
    const index = selectedSurroundingFields.findIndex(
      (item: any) => item.Field === field.Field,
    );
    selectedSurroundingFields.splice(index, 1);
    setSelectedSurroundingFields([...selectedSurroundingFields]);
  }

  const {
    loading: getAfterSurroundingDataLoading,
    run: getAfterSurroundingData,
  } = useRequest(
    async ({ pageSize = afterTimeFieldPageSize, time = afterTime }: any) => {
      const params: SurroundingParams = getQueryParams({
        pageSize,
        operator: ">",
        time,
      });
      const { rows } = await getSurroundingDataService(projectId, params);
      return convertRowsToTableData(rows);
    },
    {
      manual: true,
      onSuccess: (rowsData: any) => {
        const result = generateSurroundingResult(rowsData, currentTimeField);
        if (result.length > 0) {
          let data = [...surroundingTableData];
          data.push(...result);
          setAfterCount(afterCount + result.length);
          setAfterTime(result[result.length - 1]._original[currentTimeField]);
          setSurroundingTableData(data);
        }
      },
      onError: (err) => {
        showErrorToast("Query failed", err?.message ?? String(err));
      },
    },
  );

  function getQueryParams({
    pageSize = 5,
    operator = ">",
    time = selectedRow.time,
  }: any) {
    const params: SurroundingParams = {
      catalog: currentCatalog,
      database: currentDatabase,
      table: currentTable,
      timeField: currentTimeField,
      time,
      data_filters: [],
      pageSize,
      operator,
      cluster: currentCluster,
      theme: theme.isDark ? "dark" : "light",
    };
    if (surroundingDataFilter.length > 0) {
      params.data_filters = surroundingDataFilter;
    }
    return params;
  }

  const {
    loading: getBeforeSurroundingDataLoading,
    run: getBeforeSurroundingData,
  } = useRequest(
    async ({
      pageSize = beforeTimeFieldPageSize,
      time = selectedRow.time,
    }: any) => {
      const params: SurroundingParams = getQueryParams({
        pageSize,
        operator: "<",
        time,
      });
      const { rows } = await getSurroundingDataService(projectId, params);
      return convertRowsToTableData(rows);
    },
    {
      manual: true,
      onSuccess: (rowsData: any) => {
        const result = generateSurroundingResult(rowsData, currentTimeField);
        if (result.length > 0) {
          let data = [...surroundingTableData];
          data.unshift(...result);
          setBeforeCount(beforeCount + result.length);
          setBeforeTime(result[0]._original[currentTimeField]);
          setSurroundingTableData(data);
        }
      },
      onError: (err) => {
        showErrorToast("Query failed", err?.message ?? String(err));
      },
    },
  );

  function scrollToSelectedRow() {
    const selectedElement = document.getElementById("selected");
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  const { loading: initLoading } = useRequest(
    async () => {
      const prevTimeParams: SurroundingParams = getQueryParams({
        operator: "<",
      });
      const afterTimeParams: SurroundingParams = getQueryParams({
        operator: ">",
      });
      const [res1, res2] = await Promise.all([
        getSurroundingDataService(projectId, prevTimeParams),
        getSurroundingDataService(projectId, afterTimeParams),
      ]);
      return [
        convertRowsToTableData(res1.rows),
        convertRowsToTableData(res2.rows),
      ];
    },
    {
      refreshDeps: [surroundingDataFilter],
      onSuccess: async ([rowsData1, rowsData2]: any) => {
        const result1 = generateSurroundingResult(rowsData1, currentTimeField);
        const result2 = generateSurroundingResult(rowsData2, currentTimeField);
        const selectedResult = generateSurroundingResult(
          [selectedRow._original],
          currentTimeField,
        );
        const data = [...result1, ...selectedResult, ...result2];
        const rowsDataWithUid = await generateTableDataUID(data);
        if (result1.length > 0) {
          setBeforeCount(result1.length);
          setBeforeTime(result1[0]._original[currentTimeField]);
        } else {
          setBeforeTime(selectedRow.time);
        }
        if (result2.length > 0) {
          setAfterCount(result2.length);
          setAfterTime(result2[result2.length - 1]._original[currentTimeField]);
        } else {
          setAfterTime(selectedRow.time);
        }
        setSurroundingTableData(rowsDataWithUid);
        setTimeout(() => {
          scrollToSelectedRow();
        }, 50);
      },
      onError: (err) => {
        console.log(err);
        showErrorToast("Query failed", err?.message ?? String(err));
      },
    },
  );

  useEffect(() => {
    const data = surroundingTableData.map((item) => {
      return {
        _original: item._original,
        time: item._original?.[currentTimeField] || "",
        _source: item._source,
        _uid: item._uid,
        selected: item._uid === selectedRow._uid,
      };
    });
    setFields(data);
  }, [surroundingTableData, currentTimeField, selectedRow._uid]);

  const renderBeforeLoadingBar = () => {
    if (initLoading || getBeforeSurroundingDataLoading) {
      return (
        <div
          className={css`
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
          `}
        >
          <LoadingBar width={100} />
        </div>
      );
    }
    return null;
  };

  const renderAfterLoadingBar = () => {
    if (initLoading || getAfterSurroundingDataLoading) {
      return (
        <div
          className={css`
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
          `}
        >
          <LoadingBar width={100} />
        </div>
      );
    }
    return null;
  };

  const renderSubComponent = ({ row }: { row: Row<any> }) => {
    const subTableData = Object.keys(row.original._original).map((key) => {
      return {
        field: key,
        value: row.original._original[key],
      };
    });
    return (
      <div
        className={css`
          position: relative;
        `}
      >
        <TabsBar>
          {state.map((tab, index) => {
            return (
              <Tab
                key={index}
                label={tab.label}
                active={tab.active}
                onChangeTab={() =>
                  updateState(
                    state.map((tab, idx) => ({
                      ...tab,
                      active: idx === index,
                    })),
                  )
                }
                counter={subTableData.length}
              />
            );
          })}
        </TabsBar>
        <TabContent>
          {state[0].active && (
            <table className="bg-b1/20 dark:bg-n9/60 pl-4 backdrop-blur-md">
              <tbody>
                {subTableData.map((item: any) => {
                  let fieldValue = item.value;
                  const fieldName = item.field;
                  if (typeof fieldValue === "object") {
                    fieldValue = JSON.stringify(fieldValue);
                  }
                  const tableRowStyle = css`
                    &:hover {
                      .filter-table-content {
                        visibility: visible;
                      }
                    }
                  `;
                  return (
                    <tr className={`${tableRowStyle}`} key={fieldName}>
                      <td
                        className={css`
                          height: 32px;
                          width: 70px;
                        `}
                      >
                        <div
                          className={`filter-table-content ${css`
                            visibility: hidden;
                          `}`}
                        >
                          <SurroundingContentTableActions
                            fieldName={fieldName}
                            fieldValue={fieldValue}
                          />
                        </div>
                      </td>
                      <td className="h-8 text-xs">{fieldName || "-"}</td>
                      <td className="h-8 text-xs whitespace-pre-wrap">
                        <div className="w-full break-all whitespace-pre-wrap">
                          {fieldValue || "-"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {state[1].active && (
            <div>
              <JsonView
                value={row.original._original}
                className={`-mt-2 pl-11 leading-6! ${css`
                  .w-rjv-wrap {
                    border-left: none !important;
                  }
                `}`}
                shortenTextAfterLength={0}
                indentWidth={36}
                displayDataTypes={false}
                enableClipboard={false}
                style={theme.isDark ? SELECTDB_THEME : SELECTDB_THEME_LIGHT}
              />
            </div>
          )}
        </TabContent>
      </div>
    );
  };

  function generateSurroundingResult(result: any, timeField: string) {
    const sortedResult = sortBy(result, timeField);
    const _sourceResult = sortedResult.map((item: any) => {
      let itemSource = "";
      for (const key in item) {
        let highlightValue = item[key];
        // Handle Variant type
        if (typeof highlightValue === "object") {
          highlightValue = JSON.stringify(highlightValue);
        }
        itemSource += `<span class="field-key">${key}:</span>${highlightValue} `;
      }
      return {
        _original: item,
        _source: itemSource,
      };
    });
    return _sourceResult;
  }

  const columns = useMemo<Array<ColumnDef<any>>>(() => {
    let dynamicColumns: Array<ColumnDef<any>> = [
      {
        accessorKey: "collapse",
        header: ``,
        cell: ({ row, getValue }) => {
          return (
            row.getCanExpand() && (
              <div className="flex items-center">
                {row.getIsExpanded() ? (
                  <IconButton
                    onClick={row.getToggleExpandedHandler()}
                    name="arrow-down"
                    tooltip="Collapse"
                  />
                ) : (
                  <IconButton
                    onClick={row.getToggleExpandedHandler()}
                    name="arrow-right"
                    tooltip="Expand"
                  />
                )}
                <div className="ml-1">{getValue<string>()}</div>
              </div>
            )
          );
        },
      },
      {
        header: "Time",
        accessorKey: "time",
        cell: ({ getValue }) => {
          const fieldValue = getValue<string>();
          const fieldName = currentTimeField;
          const fieldType = "DATE";
          const timeField = formatTimestampToDateTime(fieldValue);
          return (
            <div
              className={`${css`
                width: 230px;
              `} ${HoverStyle}`}
            >
              <div
                className={css`
                  display: flex;
                  align-items: center;
                `}
              >
                {timeField}
                <div
                  className={`filter-content ${css`
                    visibility: hidden;
                  `}`}
                >
                  <SurroundingContentItem
                    fieldName={fieldName}
                    fieldValue={fieldValue}
                    fieldType={fieldType}
                  />
                </div>
              </div>
            </div>
          );
        },
      },
    ];
    if (!hasSelectedFields) {
      dynamicColumns.push({
        accessorKey: "_source",
        header: "_source",
        cell: ({ getValue }) => {
          function createMarkup() {
            return { __html: getValue<string>() };
          }
          return (
            <div
              className={css`
                padding-top: 0.5rem;
                padding-bottom: 0.5rem;
                font-size: 0.875rem;
                line-height: 1.25rem;
              `}
            >
              <ColumnStyleWrapper
                className={css`
                  & .field-key {
                    background-color: hsl(var(--primary) / 0.12);
                  }
                `}
              >
                <div
                  dangerouslySetInnerHTML={createMarkup()}
                  className={css`
                    max-height: 12rem;
                    overflow: auto;
                    word-break: break-all;
                    white-space: pre-wrap;
                  `}
                />
              </ColumnStyleWrapper>
            </div>
          );
        },
      });
    } else {
      dynamicColumns = [
        ...dynamicColumns,
        ...selectedSurroundingFields.map((field: any) => {
          return {
            accessorKey: field.Field,
            header: () => (
              <div
                className={css`
                  display: flex;
                  align-items: center;
                `}
              >
                <div>{field.Field}</div>
                <IconButton
                  name="times"
                  tooltip="Remove"
                  style={{
                    marginLeft: "8px",
                    cursor: "pointer",
                    marginTop: "2px",
                  }}
                  onClick={(e) => {
                    handleRemove(field);
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                />
              </div>
            ),
            cell: ({ row }: any) => {
              // let fieldValue = row.original._original[field.Field];
              let fieldValue = get(row.original._original, field.Field);
              const fieldName = field.Field;
              const fieldType = field.Type;
              if (typeof fieldValue === "object") {
                fieldValue = JSON.stringify(fieldValue);
              }
              return (
                <div
                  className={`${HoverStyle} ${css`
                    display: flex;
                    align-items: center;
                    min-height: 48px;
                  `}`}
                >
                  <div className={`max-h-48 overflow-auto`}>
                    <div className="flex items-center py-4 break-all">
                      {field.value === "trace_id" ? (
                        <Button>{fieldValue}</Button>
                      ) : (
                        <span className="text-xs whitespace-pre-wrap">
                          {fieldValue}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className={`filter-content ${css`
                      visibility: hidden;
                    `}`}
                  >
                    <SurroundingContentItem
                      fieldName={fieldName}
                      fieldValue={fieldValue}
                      fieldType={fieldType}
                    />
                  </div>
                </div>
              );
            },
          };
        }),
      ];
    }
    return dynamicColumns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentTimeField,
    handleRemove,
    hasSelectedFields,
    selectedSurroundingFields,
  ]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="bg-background sticky top-0 z-40 border-b">
        <SurroundingDiscoverFilter dataFilter={surroundingDataFilter} />
      </div>
      <div className="border-b px-4 py-2" style={{ position: "relative" }}>
        <SurroundingLogsActions
          getSurroundingData={getBeforeSurroundingData}
          getSurroundingDataLoading={getBeforeSurroundingDataLoading}
          time={beforeTime}
          type="before"
          timeFieldPageSize={beforeTimeFieldPageSize}
          setTimeFieldPageSize={setBeforeTimeFieldPageSize}
          tips="Old records"
          count={beforeCount}
        />
        {renderBeforeLoadingBar()}
      </div>
      <div
        className="flex-1 overflow-auto p-4"
        style={{ position: "relative" }}
      >
        <div className="overflow-hidden rounded-md border">
          <SDCollapsibleTable
            data={fields}
            columns={columns}
            getRowCanExpand={() => true}
            renderSubComponent={renderSubComponent}
          />
        </div>
      </div>
      <div className="border-t px-4 py-2" style={{ position: "relative" }}>
        {renderAfterLoadingBar()}
        <SurroundingLogsActions
          getSurroundingData={getAfterSurroundingData}
          getSurroundingDataLoading={getAfterSurroundingDataLoading}
          time={afterTime}
          type="after"
          timeFieldPageSize={afterTimeFieldPageSize}
          setTimeFieldPageSize={setAfterTimeFieldPageSize}
          tips={`New records`}
          count={afterCount}
        />
      </div>
    </div>
  );
}
