import { useEffect, useMemo, useState } from "react";
import type { LoadedRows } from "./Grid";
import type { GridSelection } from "./result-grid-model";
import { sumSelectedCells, type SelectionSum } from "./result-selection-sum";
import { errorMessage } from "./api";

export function useSelectionSum(data: LoadedRows, rows: number[], selection: GridSelection | null) {
  const key = useMemo(() => ({}), [data, rows, selection]);
  const [response, setResponse] = useState<{
    key: object; value?: SelectionSum; error?: string;
  }>();
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    void sumSelectedCells(data, rows, selection, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResponse({ key, value }); })
      .catch(reason => { if (!controller.signal.aborted) setResponse({ key, error: errorMessage(reason) }); });
    return () => controller.abort();
  }, [data, rows, selection, key]);
  const current = response?.key === key ? response : undefined;
  return { value: current?.value, error: current?.error, loading: Boolean(selection && !current) };
}
