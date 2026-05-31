import { useQuery } from "@tanstack/react-query";
import { fetchAccounts, type TradingAccount } from "../utils/api";
import { STALE } from "../utils/queryClient";

export interface AccountsResult {
  accounts: TradingAccount[];
  defaultAccountIdKey: string | null;
}

export const accountsQueryKey = () => ["accounts"] as const;

export function useAccounts() {
  return useQuery<AccountsResult>({
    queryKey: accountsQueryKey(),
    queryFn: () => fetchAccounts(),
    staleTime: STALE.accounts,
  });
}
