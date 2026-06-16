// @ts-nocheck
/**
 * Discover traces service — fetches trace query results via tRPC.
 */
import { directApi } from "@/src/utils/api";
import { Observable } from "rxjs";
import {
  buildTraceAggSQLFromParams,
  getOperationListSQL,
  getQueryTableTraceSQL,
  getServiceListSQL,
} from "./traces.sql";

function wrapAsync<T>(
  fn: () => Promise<T>,
): Observable<{ data: T; ok: boolean }> {
  return new Observable((subscriber) => {
    fn()
      .then((data) => {
        subscriber.next({ data, ok: true });
        subscriber.complete();
      })
      .catch((err) => {
        subscriber.error(err);
      });
  });
}

export function getTableDataTraceService(projectId: string, payload: any) {
  const rawSql = getQueryTableTraceSQL(payload);
  return wrapAsync(() =>
    directApi.discover.query.mutate({
      projectId,
      rawSql,
      database: payload.database,
    }),
  );
}

export function getTracesService(projectId: string, payload: any) {
  const rawSql = buildTraceAggSQLFromParams(payload);
  return wrapAsync(() =>
    directApi.discover.query.mutate({
      projectId,
      rawSql,
      database: payload.database,
    }),
  );
}

export function getServiceListService(projectId: string, payload: any) {
  const rawSql = getServiceListSQL(payload);
  return wrapAsync(() =>
    directApi.discover.query.mutate({
      projectId,
      rawSql,
      database: payload.database,
    }),
  );
}

export function getOperationListService(projectId: string, payload: any) {
  const rawSql = getOperationListSQL(payload);
  return wrapAsync(() =>
    directApi.discover.query.mutate({
      projectId,
      rawSql,
      database: payload.database,
    }),
  );
}
