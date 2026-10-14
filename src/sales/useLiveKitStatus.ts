import { useCallback, useEffect, useState } from "react";
import { getLiveKitStatus, LiveKitStatus } from "./api";

/**
 * Reads the real LiveKit configuration status from the Worker.
 * Returns `null` while loading so the UI can show a neutral state.
 */
export function useLiveKitStatus(): {
  status: LiveKitStatus | null;
  error: string | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<LiveKitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getLiveKitStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to read LiveKit status.");
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, error, refresh: () => void load() };
}
