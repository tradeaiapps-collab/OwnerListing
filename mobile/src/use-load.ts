import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./lib/api-client";

/** Loads data for a screen, with loading, error and pull-to-refresh state. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const fetchNow = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [run]);

  useEffect(() => { void fetchNow("initial"); }, [fetchNow]);

  return { data, setData, error, loading, refreshing, reload: () => fetchNow("initial"), refresh: () => fetchNow("refresh") };
}

export function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "Can't reach OwnerListing. Check your connection and try again.";
}
