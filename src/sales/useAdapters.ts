import { useCallback, useEffect, useState } from "react";
import { AdapterSummary, getAdapters } from "./api";

/** Loads the registered product adapters (service profiles) for selection. */
export function useAdapters(): {
  adapters: AdapterSummary[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  nameFor: (productId: string) => string;
} {
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAdapters();
      setAdapters(data.availableAdapters ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load service profiles.");
      setAdapters([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = useCallback(
    (productId: string) => adapters.find((a) => a.id === productId)?.name ?? productId,
    [adapters]
  );

  return { adapters, loading, error, reload: () => void load(), nameFor };
}
