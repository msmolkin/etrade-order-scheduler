/**
 * Auth status combines the cheap GET /auth/status (cached as ['auth-status'])
 * with the real GET /auth/test (cached as ['auth-test']). The Slice 2 WS
 * `auth_status` event invalidates both keys via WSProvider so the UI flips
 * from "AUTH EXPIRED" to "authed" without a manual poll.
 */
import { useQuery } from "@tanstack/react-query";
import {
  fetchAuthStatus,
  fetchAuthTest,
  type AuthStatus,
  type AuthTestResult,
} from "../utils/api";
import { STALE } from "../utils/queryClient";

export const authStatusQueryKey = () => ["auth-status"] as const;
export const authTestQueryKey = () => ["auth-test"] as const;

export function useAuthStatusQuery() {
  return useQuery<AuthStatus>({
    queryKey: authStatusQueryKey(),
    queryFn: () => fetchAuthStatus(),
    staleTime: STALE.authStatus,
  });
}

export function useAuthTestQuery(enabled: boolean) {
  return useQuery<AuthTestResult>({
    queryKey: authTestQueryKey(),
    queryFn: () => fetchAuthTest(),
    staleTime: STALE.authStatus,
    enabled,
  });
}

/**
 * Convenience composite: returns the same shape SystemStatusBar (and friends)
 * historically computed via two ad-hoc useEffects.
 */
export function useAuthStatus() {
  const statusQ = useAuthStatusQuery();
  const testQ = useAuthTestQuery(statusQ.data?.authenticated === true);

  return {
    status: statusQ.data ?? null,
    testResult: testQ.data ?? null,
    isLoading: statusQ.isLoading,
    isError: statusQ.isError,
  };
}
