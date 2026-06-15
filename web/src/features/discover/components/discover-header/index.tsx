// @ts-nocheck
import React, { useEffect } from "react";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RefreshCw } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { TimeRangePicker } from "@/src/components/date-picker";
import { cn } from "@/src/utils/tailwind";
import {
  TABLE_AGGREGATION_OPTIONS,
  toAbsoluteTimeRange,
  type TimeRange,
} from "@/src/utils/date-range-utils";
import {
  indexesAtom,
  searchTypeAtom,
  discoverCurrentAtom,
  locationAtom,
  tableFieldsAtom,
  timeFieldsAtom,
  currentDateAtom,
  currentTimeFieldAtom,
  currentIndexAtom,
  searchFocusAtom,
  activeShortcutAtom,
  timeRangeAtom,
  databasesAtom,
  tablesAtom,
  currentTableAtom,
  disabledOptionsAtom,
  searchValueAtom,
} from "store/discover";
import { getInitialDiscoverDatabase, isValidTimeFieldType } from "utils/data";
import { FORMAT_DATE } from "../../constants";
import {
  getDatabases,
  getFieldsService,
  getIndexesService,
  getTablesService,
} from "services/metaservice";

export default function DiscoverHeader(props: {
  onQuerying: () => void;
  loading: boolean;
}) {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const setIndexes = useSetAtom(indexesAtom);
  const [discoverCurrent, setDiscoverCurrent] = useAtom(discoverCurrentAtom);
  const [_loc, setLoc] = useAtom(locationAtom);
  const setTableFields = useSetAtom(tableFieldsAtom);
  const [timeFields, setTimeFields] = useAtom(timeFieldsAtom);
  const [_currentDate, setCurrentDate] = useAtom(currentDateAtom);
  const currentTimeField = useAtomValue(currentTimeFieldAtom);
  const [currentIndex, setCurrentIndex] = useAtom(currentIndexAtom);
  const searchFocus = useAtomValue(searchFocusAtom);
  const setActiveItem = useSetAtom(activeShortcutAtom);
  const [timeRange, setTimeRange] = useAtom(timeRangeAtom);
  const [currentTable, setCurrentTable] = useAtom(currentTableAtom);
  const [databases, setDatabases] = useAtom(databasesAtom);
  const [tables, setTables] = useAtom(tablesAtom);
  const setDisabledOptions = useSetAtom(disabledOptionsAtom);
  const [searchType, setSearchType] = useAtom(searchTypeAtom);
  const [searchValue, setSearchValue] = useAtom(searchValueAtom);
  const selectingDatabaseRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (currentIndex.length > 0) {
      setDisabledOptions([]);
    } else {
      setDisabledOptions(["Search"]);
    }
  }, [currentIndex, setDisabledOptions]);

  const getFields = React.useCallback(
    (database: string, selectedTable: string) => {
      getFieldsService({
        projectId,
        database,
        table: selectedTable,
      }).subscribe({
        next: ({ data, ok }: any) => {
          if (ok) {
            const rows = data?.rows ?? [];
            const values = rows.map((row: Record<string, unknown>) =>
              String(row.Field ?? row.COLUMN_NAME ?? row.column_name ?? ""),
            );
            const fieldTypes = rows.map((row: Record<string, unknown>) =>
              String(row.Type ?? row.DATA_TYPE ?? row.data_type ?? ""),
            );

            const tableFields = values.map((item: any, index: number) => ({
              label: item,
              Field: item,
              value: item,
              Type: fieldTypes[index],
            }));

            setTableFields(tableFields);

            if (values) {
              const options = values
                .filter((field: any, index: number) =>
                  isValidTimeFieldType(fieldTypes[index].toUpperCase()),
                )
                .map((item: any) => ({
                  label: item,
                  value: item,
                }));
              const initialTimeField =
                discoverCurrent.timeField &&
                options.some(
                  (option) => option.value === discoverCurrent.timeField,
                )
                  ? discoverCurrent.timeField
                  : options[0]?.value || "";
              setDiscoverCurrent((prev) => ({
                ...prev,
                timeField: initialTimeField,
              }));
              setTimeFields(options);
              setLoc((prev: any) => {
                const searchParams = prev.searchParams;
                searchParams?.set("timeField", initialTimeField);
                return {
                  ...prev,
                  searchParams,
                };
              });
            }
          }
        },
        error: (err: any) => {
          console.log("Query error", err);
        },
      });
    },
    [
      discoverCurrent.timeField,
      projectId,
      setDiscoverCurrent,
      setLoc,
      setTableFields,
      setTimeFields,
    ],
  );

  const getIndexes = React.useCallback(
    (database: string, selectedTable: string) => {
      getIndexesService({
        projectId,
        database,
        table: selectedTable,
      }).subscribe({
        next: ({ data, ok }: any) => {
          if (ok) {
            const rows = data?.rows ?? [];
            const values = rows.map((row: Record<string, unknown>) =>
              String(
                row.Key_name ??
                  row.Index_name ??
                  row.KEY_NAME ??
                  row.INDEX_NAME ??
                  "",
              ),
            );
            const columnNames = rows.map((row: Record<string, unknown>) =>
              String(
                row.Column_name ?? row.COLUMN_NAME ?? row.column_name ?? "",
              ),
            );
            const indexesTypes = rows.map((row: Record<string, unknown>) =>
              String(row.Index_type ?? row.INDEX_TYPE ?? row.index_type ?? ""),
            );

            if (!values || values.length === 0) {
              setIndexes([]);
              setCurrentIndex([]);
              return;
            }

            const tableIndexes = values?.map((item: any, index: number) => ({
              label: item,
              value: item,
              type: indexesTypes[index],
              columnName: columnNames[index],
            }));

            setIndexes(tableIndexes);
            setCurrentIndex(tableIndexes);
          }
        },
        error: (err: any) => {
          console.log("Query error", err);
        },
      });
    },
    [projectId, setCurrentIndex, setIndexes],
  );

  const selectTable = React.useCallback(
    (database: string, table: string) => {
      setDiscoverCurrent((prev) => ({
        ...prev,
        database,
        table,
        timeField: "",
      }));
      setCurrentTable(table);
      setLoc((prev: any) => {
        const searchParams = prev.searchParams;
        searchParams?.set("database", database);
        searchParams?.set("table", table);
        return {
          ...prev,
          searchParams,
        };
      });
      getFields(database, table);
      getIndexes(database, table);
    },
    [getFields, getIndexes, setCurrentTable, setDiscoverCurrent, setLoc],
  );

  const selectDatabase = React.useCallback(
    (database: string) => {
      if (selectingDatabaseRef.current === database) {
        return;
      }
      if (database === discoverCurrent.database && currentTable) {
        return;
      }

      selectingDatabaseRef.current = database;
      setDiscoverCurrent((prev) => ({
        ...prev,
        database,
        table: "",
        timeField: "",
      }));
      setCurrentTable("");
      setTables([]);
      setLoc((prev: any) => {
        const searchParams = prev.searchParams;
        searchParams?.set("database", database);
        searchParams?.delete("table");
        return {
          ...prev,
          searchParams,
        };
      });
      getTablesService({
        projectId,
        database,
      }).subscribe({
        next: (resp: any) => {
          const { data, ok } = resp;
          if (ok) {
            const rows = data?.rows ?? [];
            const options = rows
              .map((row: Record<string, unknown>) => firstStringValue(row))
              .filter((item): item is string => Boolean(item))
              .map((item) => ({
                label: item,
                value: item,
              }));
            setTables(options);

            const initialTable =
              options.find((o) => o.value === "traces")?.value ??
              options[0]?.value;

            if (initialTable) {
              selectTable(database, initialTable);
            }
          }
          selectingDatabaseRef.current = null;
        },
        error: (err: any) => {
          selectingDatabaseRef.current = null;
          console.log("Query error", err);
        },
      });
    },
    [
      currentTable,
      discoverCurrent.database,
      projectId,
      selectTable,
      setCurrentTable,
      setDiscoverCurrent,
      setLoc,
      setTables,
    ],
  );

  useEffect(() => {
    if (!projectId) return;
    const subscription = getDatabases(projectId).subscribe({
      next: ({ data, ok }: any) => {
        if (!ok) {
          return;
        }

        const rows = data?.rows ?? [];
        if (!rows.length) {
          setDatabases([]);
          return;
        }

        const options = rows
          .map((row: Record<string, unknown>) => firstStringValue(row))
          .filter((item: string | undefined): item is string => Boolean(item))
          .map((item: string) => ({
            label: item,
            value: item,
          }));
        setDatabases(options);

        const initialDatabase = getInitialDiscoverDatabase(
          discoverCurrent.database,
          options,
        );

        if (initialDatabase) {
          selectDatabase(initialDatabase);
        }
      },
      error: (err: any) => console.log("Query error", err),
    });

    return () => subscription.unsubscribe();
  }, [discoverCurrent.database, projectId, selectDatabase, setDatabases]);

  const updateTimeRange = (nextRange: TimeRange) => {
    const absoluteRange = toAbsoluteTimeRange(nextRange);
    if (!absoluteRange) {
      return;
    }

    const start = dayjs(absoluteRange.from);
    const end = dayjs(absoluteRange.to);

    setLoc((prev: any) => {
      const searchParams = prev.searchParams;
      searchParams?.set("startTime", start.utc().format(FORMAT_DATE));
      searchParams?.set("endTime", end.utc().format(FORMAT_DATE));
      return {
        ...prev,
        searchParams,
      };
    });
    setCurrentDate([start, end]);
    setActiveItem(undefined);
    setTimeRange(nextRange);
  };

  const runQuery = () => {
    const absoluteRange = toAbsoluteTimeRange(timeRange);
    if (absoluteRange) {
      const start = dayjs(absoluteRange.from);
      const end = dayjs(absoluteRange.to);

      setLoc((prev) => {
        const searchParams = prev.searchParams;
        searchParams?.set("startTime", start.utc().format(FORMAT_DATE));
        searchParams?.set("endTime", end.utc().format(FORMAT_DATE));
        return {
          ...prev,
          searchParams,
        };
      });
    }

    props.onQuerying();
  };

  return (
    <div className="w-full">
      <div className="grid w-full min-w-0 grid-cols-[minmax(8rem,1.05fr)_minmax(8rem,1.05fr)_minmax(6rem,0.65fr)_minmax(12rem,1.8fr)_minmax(8rem,0.9fr)_minmax(15rem,1.4fr)_auto] items-end gap-2.5">
        <SelectField
          className="min-w-0"
          label="Database"
          value={discoverCurrent.database}
          placeholder="Select database"
          options={databases}
          onChange={(database) => {
            selectDatabase(database);
          }}
        />

        <SelectField
          className="min-w-0"
          label="Table"
          value={currentTable}
          placeholder="Select table"
          options={tables}
          onChange={(table) => {
            selectTable(discoverCurrent.database, table);
          }}
        />

        <SelectField
          className="min-w-0"
          label="Mode"
          value={searchType}
          options={[
            { label: "Lucene", value: "Lucene" },
            { label: "SQL", value: "SQL" },
          ]}
          onChange={(value) => {
            setSearchType(value as "SQL" | "Search" | "Lucene");
            setSearchValue("");
          }}
        />

        <TextField
          className="min-w-0"
          label={searchType === "Lucene" ? "Lucene" : "SQL"}
        >
          <Input
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder={
              searchType === "Lucene"
                ? "usage: field:value AND field2:value2"
                : "SQL WHERE. e.g. event_type = 'ForkApplyEvent'"
            }
            className="h-8"
          />
        </TextField>

        {!searchFocus && (
          <>
            <SelectField
              className="min-w-0"
              label="Time Field"
              value={currentTimeField}
              placeholder="Time field"
              options={timeFields}
              onChange={(timeField) => {
                setDiscoverCurrent((prev) => ({
                  ...prev,
                  timeField,
                }));
                setLoc((prev: any) => {
                  const searchParams = prev.searchParams;
                  searchParams?.set("timeField", timeField);
                  return {
                    ...prev,
                    searchParams,
                  };
                });
              }}
            />

            <TextField className="min-w-0" label="Time Range">
              <TimeRangePicker
                timeRange={timeRange}
                onTimeRangeChange={(nextRange) => {
                  updateTimeRange(nextRange);
                }}
                timeRangePresets={TABLE_AGGREGATION_OPTIONS}
                className="my-0 max-w-full min-w-0 [&>button]:h-8 [&>button]:w-full [&>button]:justify-between [&>button]:px-2.5 [&>button]:text-sm [&>button>div]:min-w-0 [&>button>div>span:last-child]:truncate"
              />
            </TextField>
          </>
        )}

        <div className="shrink-0">
          <Button
            className="h-8 min-w-24 gap-2 px-3"
            onClick={runQuery}
            loading={props.loading}
          >
            <RefreshCw
              className={cn("h-4 w-4", props.loading && "animate-spin")}
            />
            Query
          </Button>
        </div>
      </div>
    </div>
  );
}

function firstStringValue(row: Record<string, unknown>) {
  const firstValue = Object.values(row)[0];
  return firstValue == null ? "" : String(firstValue);
}

function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
  className,
}: {
  label: string;
  value?: string;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <TextField className={className} label={label}>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </TextField>
  );
}

function TextField({
  label,
  className,
  children,
}: React.PropsWithChildren<{ label: string; className?: string }>) {
  return (
    <div className={cn("shrink-0 space-y-1", className)}>
      <Label className="text-foreground/75 text-[11px] font-semibold tracking-wide">
        {label}
      </Label>
      {children}
    </div>
  );
}
