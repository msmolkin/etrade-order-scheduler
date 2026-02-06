/**
 * Client-side order history: recent order drafts for prefilling the order form.
 * Stored in localStorage only; no server or PII beyond what the user already entered.
 */

const STORAGE_KEY = 'etrade-order-history';
const MAX_ITEMS = 20;

export type OrderHistoryDraft = Partial<{
  accountId: string;
  symbol: string;
  securityType: 'EQUITY' | 'OPTION';
  optionType: 'CALL' | 'PUT';
  strikePrice: number;
  expirationDate: string;
  action: string;
  orderType: string;
  quantity: number;
  limitPrice: string;
  stopPrice: string;
  preferredDuration: string;
  actualDuration: string;
  sessionTime: string;
  scheduleEnabled: boolean;
  scheduledFor: string;
  notes: string;
}>;

export interface OrderHistoryItem {
  id: string;
  at: number;
  draft: OrderHistoryDraft;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeDraft(raw: unknown): OrderHistoryDraft | null {
  if (!isPlainObject(raw) || !raw.draft || !isPlainObject(raw.draft)) return null;
  const d = raw.draft as Record<string, unknown>;
  const draft: OrderHistoryDraft = {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  draft.accountId = str(d.accountId);
  draft.symbol = str(d.symbol);
  draft.securityType = d.securityType === 'EQUITY' || d.securityType === 'OPTION' ? d.securityType : undefined;
  draft.optionType = d.optionType === 'CALL' || d.optionType === 'PUT' ? d.optionType : undefined;
  draft.strikePrice = num(d.strikePrice);
  draft.expirationDate = str(d.expirationDate);
  draft.action = str(d.action);
  draft.orderType = str(d.orderType);
  draft.quantity = num(d.quantity);
  if (draft.quantity != null && (draft.quantity < 1 || !Number.isInteger(draft.quantity))) draft.quantity = undefined;
  draft.limitPrice = str(d.limitPrice);
  draft.stopPrice = str(d.stopPrice);
  draft.preferredDuration = str(d.preferredDuration);
  draft.actualDuration = str(d.actualDuration);
  draft.sessionTime = str(d.sessionTime);
  draft.scheduleEnabled = bool(d.scheduleEnabled);
  draft.scheduledFor = str(d.scheduledFor);
  draft.notes = str(d.notes);
  if (!draft.symbol && !draft.action && !draft.orderType) return null;
  return draft;
}

function sanitizeItem(raw: unknown): OrderHistoryItem | null {
  if (!isPlainObject(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : undefined;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : undefined;
  const draft = sanitizeDraft(raw);
  if (!id || at == null || !draft) return null;
  return { id, at, draft };
}

export function loadOrderHistory(): OrderHistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: OrderHistoryItem[] = [];
    for (const entry of parsed.slice(0, MAX_ITEMS * 2)) {
      const item = sanitizeItem(entry);
      if (item) items.push(item);
    }
    return items.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export function saveOrderHistory(items: OrderHistoryItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    const toSave = items.slice(0, MAX_ITEMS).map(({ id, at, draft }) => ({ id, at, draft }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // ignore
  }
}

export function addToOrderHistory(draft: OrderHistoryDraft): OrderHistoryItem[] {
  const items = loadOrderHistory();
  const newItem: OrderHistoryItem = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    at: Date.now(),
    draft: { ...draft },
  };
  const next = [newItem, ...items.filter((i) => i.id !== newItem.id)].slice(0, MAX_ITEMS);
  saveOrderHistory(next);
  return next;
}

export function removeFromOrderHistory(id: string): OrderHistoryItem[] {
  const items = loadOrderHistory().filter((i) => i.id !== id);
  saveOrderHistory(items);
  return items;
}

export function getHistoryItemLabel(item: OrderHistoryItem): string {
  const d = item.draft;
  const sym = d.symbol || '?';
  const action = d.action || '?';
  const qty = d.quantity ?? '?';
  const type = d.orderType || '?';
  const limit = d.limitPrice ? ` @ ${d.limitPrice}` : '';
  const stop = d.stopPrice ? ` stop ${d.stopPrice}` : '';
  if (d.securityType === 'OPTION') {
    const opt = d.optionType || '';
    const strike = d.strikePrice != null ? ` ${d.strikePrice}` : '';
    const exp = d.expirationDate || '';
    return `${action} ${qty} ${sym} ${opt}${strike} ${exp} ${type}${limit}${stop}`.trim();
  }
  return `${action} ${qty} ${sym} ${type}${limit}${stop}`.trim();
}
