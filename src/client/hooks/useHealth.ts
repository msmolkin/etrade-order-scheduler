/**
 * Slice 6.2 useHealth.
 *
 * Polls /health every 30s and exposes the scheduler-heartbeat freshness
 * (lastHeartbeatAt + lastHeartbeatAgeMs) along with the database status.
 * SystemStatusBar reads ageMs to color the heartbeat dot, and DayStrip
 * uses lastHeartbeatAt to mark missed-this-morning slots.
 *
 * Note: served at /api/health so Vite's dev proxy reaches the express
 * server on port 3001. The legacy /health route is still mounted at the
 * server root for any external probes that depend on it.
 */
import { useQuery } from "@tanstack/react-query";

export interface HealthResponse {
  status: "healthy" | "unhealthy";
  database: boolean;
  lastHeartbeatAt: string | null;
  lastHeartbeatAgeMs: number | null;
  timestamp: string;
}

export const healthQueryKey = () => ["health"] as const;

const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/health`);
  if (!res.ok) {
    throw new Error(`/health returned ${res.status}`);
  }
  return res.json() as Promise<HealthResponse>;
}

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: healthQueryKey(),
    queryFn: fetchHealth,
    staleTime: 15_000,
    refetchInterval: 30_000,
    // Refetch even when window is hidden so SystemStatusBar gets a fresh
    // ageMs the moment the user comes back to the tab.
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
