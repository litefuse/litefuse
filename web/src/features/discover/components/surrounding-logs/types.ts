// @ts-nocheck
import { DataFilterType } from "types/type";

export interface DiscoverFilterProps {
  dataFilter: DataFilterType[];
}

export interface FilterContentProps {
  onHide: () => void;
  dataFilterValue?: DataFilterType;
}

export interface SurroundingParams {
  catalog: string;
  database: string;
  table: string;
  cluster: string;
  timeField: string;
  time: string;
  data_filters: any;
  pageSize: string;
  operator: ">" | "<";
  theme: string | undefined;
}
