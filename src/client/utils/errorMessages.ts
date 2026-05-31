/**
 * Slice 4.2 error humanization.
 *
 * The `lastError` field on a rejected order is whatever the executor
 * caught - sometimes E*TRADE prose, sometimes an oauth-1.0a error, sometimes
 * an axios stack. Surfacing that verbatim under a row is hostile. This
 * util maps the most common shapes to the SHORTEST accurate phrasing the
 * UI can show, and falls back to a truncated raw message otherwise.
 *
 * Used by OrderRow's inline error sub-row (Slice 4.2) and reused later by
 * AuthFix (Slice 6) and any retry banner that needs to say "auth expired"
 * in plain English.
 */

const MAX_FALLBACK_CHARS = 80;

interface Mapping {
  match: (raw: string) => boolean;
  message: string;
}

/**
 * Order is significant - first match wins. Most-specific patterns first
 * (e.g. token-revoked before generic "oauth_problem"), so a more useful
 * message is picked when both could apply.
 */
const MAPPINGS: Mapping[] = [
  {
    match: (s) => /token[_ ]?revoked/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /token[_ ]?expired/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /token[_ ]?rejected/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /oauth[_ ]?problem/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /signature[_ ]?invalid/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /401|unauthor/i.test(s),
    message: "auth expired",
  },
  {
    match: (s) => /insufficient[_ ]?(funds|buying[_ ]?power)/i.test(s),
    message: "not enough buying power",
  },
  {
    match: (s) => /insufficient[_ ]?shares/i.test(s),
    message: "not enough shares to sell",
  },
  {
    match: (s) => /market[_ ]?closed/i.test(s),
    message: "market closed for this session",
  },
  {
    match: (s) => /halt(ed)?/i.test(s),
    message: "trading halted on this symbol",
  },
  {
    match: (s) => /symbol[_ ]?not[_ ]?found|unknown[_ ]?symbol|invalid[_ ]?symbol/i.test(s),
    message: "symbol not found",
  },
  {
    match: (s) => /quote[_ ]?(unavailable|not[_ ]?found)/i.test(s),
    message: "no quote available",
  },
  {
    match: (s) => /option[_ ]?expired/i.test(s),
    message: "option expired",
  },
  {
    match: (s) => /etradeerror/i.test(s) && /preview/i.test(s),
    message: "E*TRADE preview rejected the order",
  },
  {
    match: (s) => /econnrefused|connection[_ ]?refused/i.test(s),
    message: "could not reach E*TRADE",
  },
  {
    match: (s) => /etimedout|timeout/i.test(s),
    message: "E*TRADE timed out",
  },
];

/**
 * Map a raw `lastError` to a single concrete sentence the UI can render
 * inline. Returns the trimmed/truncated raw error if no rule matches.
 */
export function mapErrorToConcrete(raw: string | null | undefined): string {
  if (!raw) return "unknown error";
  const trimmed = raw.trim();
  if (!trimmed) return "unknown error";
  for (const rule of MAPPINGS) {
    if (rule.match(trimmed)) return rule.message;
  }
  if (trimmed.length <= MAX_FALLBACK_CHARS) return trimmed;
  return trimmed.slice(0, MAX_FALLBACK_CHARS) + "...";
}
