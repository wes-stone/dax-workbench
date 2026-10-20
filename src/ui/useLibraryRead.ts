import { useEffect, useState } from "react";
import { errorMessage } from "./api";
import type { LibrarySession } from "./library-cache";

export function useLibraryRead<T>(session: LibrarySession, key: string, group: "catalog" | "detail",
  load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [response, setResponse] = useState<{ key: string; data?: T; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const cached = enabled ? session.cache.peek<T>(key) : undefined;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setResponse(previous => previous?.key === key && previous.data ? previous : undefined);
    // The key contains every read input; retain this committed render's loader.
    const read = session.cache.read<T>(key, group, load);
    void read.promise.then(data => { if (current) setResponse({ key, data }); })
      .catch(reason => { if (current) setResponse({ key, error: errorMessage(reason) }); });
    return () => { current = false; read.release(); };
  }, [session, key, group, enabled, attempt]);
  const result = enabled && response?.key === key ? response : undefined;
  return { data: cached ?? result?.data, error: result?.error, loading: enabled && !cached && !result,
    accept: (data: T) => setResponse({ key, data }),
    retry: () => { session.cache.remove(key); setResponse(undefined); setAttempt(value => value + 1); } };
}
