import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthoringEvent, Snapshot } from "../contracts/workbench";
import { api, errorMessage } from "./api";
import { isSnapshot } from "./http";

export type Action = <T = unknown>(name: string, payload?: object) => Promise<T>;
let bootstrap: Promise<Snapshot> | undefined;

export function useWorkbench() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [fatal, setFatal] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(0);
  const latest = useRef<Snapshot | null>(null);
  const onAuthoring = useRef<((event: AuthoringEvent) => void) | null>(null);
  const accept = useCallback((snapshot: Snapshot) => {
    if (!latest.current || snapshot.version >= latest.current.version) {
      latest.current = snapshot;
      setState(snapshot);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    bootstrap ??= api.bootstrap();
    void bootstrap.then(snapshot => {
      if (abort.signal.aborted) return;
      accept(snapshot);
      void api.events(abort.signal, accept, value => { if (!abort.signal.aborted) setConnected(value); }, message => { if (!abort.signal.aborted) setError(message); }, event => onAuthoring.current?.(event));
    }).catch(reason => { if (!abort.signal.aborted) setFatal(errorMessage(reason)); });
    return () => abort.abort();
  }, [accept]);
  const action: Action = useCallback(async <T,>(name: string, payload: object = {}) => {
    setBusy(value => value + 1);
    setError("");
    try {
      const result = await api.action<T>(name, payload);
      if (isSnapshot(result)) accept(result);
      else {
        try { accept(await api.state()); }
        catch (reason) { setError(`The action completed, but its updated state could not be loaded. ${errorMessage(reason)}`); }
      }
      return result;
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    } finally { setBusy(value => value - 1); }
  }, [accept]);
  return { state, latest, fatal, error, setError, connected, busy, action, onAuthoring };
}
