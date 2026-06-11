// @ts-nocheck
import { atom } from "jotai";
import { atomWithStorage, selectAtom } from "jotai/utils";
// import { focusAtom } from 'jotai-optics'
import { atomWithLocation } from "jotai-location";

import type { Dayjs } from "dayjs";
import {
  DataFilterType,
  DiscoverCurrent,
  IntervalEnum,
  ShortcutItem,
} from "types/type";
import {
  AggregatableEnum,
  DISCOVER_DEFAULT_STATUS,
  DISCOVER_SHORTCUTS,
  FieldTypeEnum,
  SearchableEnum,
} from "utils/data";

export const locationAtom = atomWithLocation();
export const dataFilterAtom = atom<DataFilterType[]>([]);
export const discoverCurrentAtom = atom<DiscoverCurrent>(
  DISCOVER_DEFAULT_STATUS,
);

// databases
export const databasesAtom = atom<any>([]);
export const tablesAtom = atom<any>([]);

export const currentCatalogAtom = atom("internal");
export const searchTypeAtom = atom<"SQL" | "Search" | "Lucene">("Lucene");
export const currentDatabaseAtom = selectAtom(
  discoverCurrentAtom,
  (current) => current.database,
);
export const currentTableAtom = atom<string>("");
export const currentClusterAtom = atom("");
export const currentTimeFieldAtom = selectAtom(
  discoverCurrentAtom,
  (current) => current.timeField,
);
export const currentDateAtom = atom<Dayjs[]>(DISCOVER_SHORTCUTS[2].range());
export const currentIndexAtom = atom<any>([]);
export const selectedIndexesAtom = atom<any>([]);
export const searchValueAtom = atom("");
export const searchFocusAtom = atom(false);
export const activeShortcutAtom = atom<ShortcutItem | undefined>(
  DISCOVER_SHORTCUTS[2],
);
export const dorisInfoAtom = atom<any>({});
export const disabledOptionsAtom = atom<string[]>([]);

export const selectedFieldsAtom = atom<any[]>([]);
export const tableFieldsAtom = atom<any[]>([]);

export const timeFieldsAtom = atom<any[]>([]);
export const tableDataAtom = atom<any[]>([]);
export const topDataAtom = atom<any[]>([]);
export const surroundingTableDataAtom = atom<any[]>([]);
export const tableDataChartsAtom = atom<any[]>([]);
export const intervalAtom = atom<IntervalEnum>(IntervalEnum.Auto);
export const tableTotalCountAtom = atom<number>(0);
export const tableEChartsDataAtom = atom<any[]>([]);
export const tableTracesDataAtom = atom<any>();
// TopData field query - set by TopData component when it needs to fetch for a specific field
export const topDataFieldNameAtom = atom<string | null>(null);

// Filter Content Atom
export const searchableAtom = atom<SearchableEnum>(SearchableEnum.ANY);
export const aggregatableAtom = atom<AggregatableEnum>(AggregatableEnum.ANY);
export const fieldTypeAtom = atom<FieldTypeEnum>(FieldTypeEnum.ANY);
export const indexesAtom = atom<any[]>([]);
export const selectedRowAtom = atom<any>({});
export const tableFieldValuesAtom = atom<
  Array<{ label: string; value: string }>
>([]);

export const pageAtom = atom<number>(1);
export const pageSizeAtom = atomWithStorage<number>(
  "discover-pagination-size",
  20,
);

// Surrounding Data Atoms
export const surroundingDataFilterAtom = atom<DataFilterType[]>([]);
export const beforeTimeFieldPageSizeAtom = atom<number>(5);
export const afterTimeFieldPageSizeAtom = atom<number>(5);
export const beforeTimeAtom = atom<string>("");
export const afterTimeAtom = atom<string>("");
export const beforeCountAtom = atom<number>(0);
export const afterCountAtom = atom<number>(0);
export const surroundingTableFieldsAtom = atom<any[]>([]);
export const surroundingSelectedFieldsAtom = atom<any[]>([]);

export const timeRangeAtom = atom<any>({
  from: DISCOVER_SHORTCUTS[2].range()[0].toDate(),
  to: DISCOVER_SHORTCUTS[2].range()[1].toDate(),
  raw: DISCOVER_SHORTCUTS[2].raw,
});

export const discoverLoadingAtom = atom({
  getTableData: false,
  getTopData: false,
  getSurroundingData: false,
  getTableDataCharts: false,
  getTableFieldValues: false,
  getIndexes: false,
  getTimeFields: false,
  getTableFields: false,
});
