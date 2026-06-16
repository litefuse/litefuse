// @ts-nocheck
import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { useRouter } from "next/router";
import {
  currentDatabaseAtom,
  currentTableAtom,
  currentTimeFieldAtom,
  searchTypeAtom,
  searchValueAtom,
  tableFieldsAtom,
} from "store/discover";
import { getWhereSQLViaLucene } from "services/lucene";

export function useLuceneWhereClause() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const searchType = useAtomValue(searchTypeAtom);
  const searchValue = useAtomValue(searchValueAtom);
  const currentTable = useAtomValue(currentTableAtom);
  const currentDatabase = useAtomValue(currentDatabaseAtom);
  const tableFields = useAtomValue(tableFieldsAtom);
  const currentTimeField = useAtomValue(currentTimeFieldAtom);

  return useCallback(async (): Promise<string> => {
    if (searchType !== "Lucene") {
      return "";
    }

    const trimmedQuery = searchValue?.trim();
    if (!trimmedQuery || !currentTable || !currentDatabase || !projectId) {
      return "";
    }

    const candidateFieldNames = (tableFields || [])
      .map((field: any) => {
        const rawName = field?.Field ?? field?.value ?? field?.name;
        const type = String(field?.Type ?? "").toUpperCase();
        if (!rawName) {
          return null;
        }

        if (!type) {
          return rawName;
        }

        return /(CHAR|TEXT|STRING|JSON|VARIANT)/.test(type) ? rawName : null;
      })
      .filter(Boolean) as string[];

    const implicitExpressions = candidateFieldNames
      .slice(0, 10)
      .map((name) => `coalesce(\`${name}\`, '')`);

    let implicitColumnExpression: string | undefined;
    if (implicitExpressions.length > 0) {
      implicitColumnExpression = implicitExpressions.join(",\n");
    } else if (currentTimeField) {
      implicitColumnExpression = `coalesce(\`${currentTimeField}\`, '')`;
    }

    return await getWhereSQLViaLucene({
      query: trimmedQuery,
      projectId,
      databaseName: currentDatabase,
      tableName: currentTable,
      implicitColumnExpression,
    });
  }, [
    currentDatabase,
    currentTable,
    currentTimeField,
    projectId,
    searchType,
    searchValue,
    tableFields,
  ]);
}
