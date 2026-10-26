import {
  createContext,
  useContext,
  useState,
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { FilterState, OrderByState } from "@langfuse/shared";

/**
 * ── LITEFUSE NOTE ───────────────────────────────────────────────────────────
 * Two upstream-parity additions, both required by the copied search-bar hook:
 *   * the two types are exported (the hook/consumers reference them), and
 *   * `setTableState` is a React dispatcher, so a caller can pass an updater
 *     function (`setTableState((state) => ...)`) instead of a whole state object.
 * Keeping our `sorting: OrderByState` / `null` initial value: upstream switched
 * to `| undefined`, but no consumer here depends on that, and changing it would
 * silently alter the initial state every peek reads.
 * ───────────────────────────────────────────────────────────────────────────
 */
export interface PeekTableState {
  filters: FilterState;
  sorting: OrderByState;
  pagination: { pageIndex: number; pageSize: number };
  search: { query: string | null; type: string[] };
}

export interface PeekTableStateContextValue {
  tableState: PeekTableState;
  setTableState: Dispatch<SetStateAction<PeekTableState>>;
}

const PeekTableStateContext = createContext<
  PeekTableStateContextValue | undefined
>(undefined);

export function PeekTableStateProvider({ children }: { children: ReactNode }) {
  const [tableState, setTableState] = useState<PeekTableState>({
    filters: [],
    sorting: null,
    pagination: { pageIndex: 0, pageSize: 50 },
    search: { query: null, type: ["id"] },
  });

  const value = useMemo(() => ({ tableState, setTableState }), [tableState]);

  return (
    <PeekTableStateContext.Provider value={value}>
      {children}
    </PeekTableStateContext.Provider>
  );
}

export function usePeekTableState() {
  return useContext(PeekTableStateContext);
}
