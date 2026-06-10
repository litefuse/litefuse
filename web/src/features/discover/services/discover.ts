// @ts-nocheck
/**
 * Discover data service — fetches query results via tRPC.
 *
 * All functions are async and return row-major data directly.
 * The old Observable / Grafana-frame pipeline has been removed.
 */
import { directApi } from "@/src/utils/api";
import {
  getQueryTableChartsSQL,
  getQueryTableResultCountSQL,
  getQueryTableResultSQL,
  getTopDataFieldSQL,
  getSurroundingSQL,
} from "./sql";

export async function getTableDataService(projectId: string, payload: any) {
  const rawSql = getQueryTableResultSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}

export async function getTableDataChartsService(
  projectId: string,
  payload: any,
) {
  const rawSql = getQueryTableChartsSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}

export async function getTopDataService(projectId: string, payload: any) {
  const rawSql = getQueryTableResultSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}

export async function getTopDataFieldService(projectId: string, payload: any) {
  const rawSql = getTopDataFieldSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}

export async function getTableDataCountService(
  projectId: string,
  payload: any,
) {
  const rawSql = getQueryTableResultCountSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}

export async function getSurroundingDataService(
  projectId: string,
  payload: any,
) {
  const rawSql = getSurroundingSQL(payload);
  return directApi.discover.query.mutate({
    projectId,
    rawSql,
    database: payload.database,
  });
}
