import { useEffect, useState } from "react";
import type { AuthStatus, AuthTestResult } from "../utils/api";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useHealth } from "../hooks/useHealth";

/**
 * Slice 1 SystemStatusBar.
 *
 * Full-width bar above the tab nav. Cells (left to right):
 *   brand · E*TRADE auth · Scheduler heartbeat · Account · ET clock · Pause all
 *
 * Auth state is the only fully-wired cell in Slice 1. Heartbeat and
 * Pause-all are stubs that show 0/unknown until Slice 6 wires reliability.
 *
 * When auth is broken the entire bar repaints red; the right-side
 * action becomes "Auto-login →". Clicking scrolls the page to the
 * <AuthFix /> hero panel that OrderList swaps in for the DayStrip when
 * auth is expired (Slice 6.1).
 *
 * Slice 3 swap: the inline poll/useEffect was replaced with the shared
 * useAuthStatus() hook (react-query) so cache hydration from localStorage
 * paints the bar without flicker on reload, and Slice 2's WS auth_status
 * event triggers a refetch instead of waiting up to 60s for the next poll.
 * Rendered output is intentionally byte-identical to the Slice 1 version.
 */

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function nowEt(): string {
  // ET clock - cached formatter for performance
  return etFormatter.format(new Date());
}

export default function SystemStatusBar() {
  const { status, testResult, isError } = useAuthStatus();
  const { data: health } = useHealth();
  const [etClock, setEtClock] = useState<string>(nowEt());
  const [btnState, setBtnState] = useState<"idle" | "sending" | "sent">("idle");

  // ET clock tick.
  useEffect(() => {
    const id = setInterval(() => setEtClock(nowEt()), 1000);
    return () => clearInterval(id);
  }, []);

  const errorDetail = authErrorDetail(status, testResult);

  useEffect(() => {
    if (errorDetail) console.error("[Trade Placer] Auth error:", errorDetail);
  }, [errorDetail]);

  const sandbox = status?.sandbox === true;
  const authBroken =
    isError ||
    (status !== null &&
      (!status.authenticated ||
        (testResult !== null && testResult.ok === false)));

  const onAutoLogin = async () => {
    if (btnState !== "idle") return;
    setBtnState("sending");

    // Scroll the AuthFix hero into view while the request flies.
    const hero = document.querySelector("[data-testid=authfix-hero]");
    if (hero) {
      (hero as HTMLElement).scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    try {
      await fetch("/api/auth/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headless: true, clearCookies: true }),
      });
    } catch {
      // Server error is fine — still mark sent so the user waits.
    }
    setBtnState("sent");
  };

  return (
    <>
      {sandbox && (
        <div
          className="mono"
          style={{
            width: "100%",
            textAlign: "center",
            padding: "4px 12px",
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--bg-0)",
            background: "var(--accent)",
            textTransform: "uppercase",
          }}
        >
          - SANDBOX MODE - orders will not execute on production -
        </div>
      )}
      <div
        className="mono"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "4px 16px",
          width: "100%",
          padding: "6px 16px",
          fontSize: 12,
          letterSpacing: "0.02em",
          color: "var(--text)",
          background: authBroken ? "var(--bad-bg)" : "var(--bg-1)",
          borderBottom: "1px solid var(--bg-2)",
        }}
      >
        {/* Brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 600,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 4,
              background: "var(--bg-3)",
              color: "var(--text)",
              fontSize: 11,
            }}
          >
            T
          </span>
          <span>Trade Placer</span>
        </div>

        {/* E*TRADE auth */}
        <Cell
          label="E*TRADE"
          value={authValue(status, testResult, isError)}
          dotClass={authBroken ? "bad" : ""}
        />

        {/* Scheduler heartbeat (Slice 6.2): green/amber/red based on /health age. */}
        <Cell
          label="Scheduler"
          value={heartbeatValue(health?.lastHeartbeatAgeMs ?? null)}
          dotClass={heartbeatDotClass(health?.lastHeartbeatAgeMs ?? null)}
        />

        {/* Account */}
        <Cell label="Acct" value={accountValue(status)} />

        <div style={{ flex: 1 }} />

        {/* ET clock */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--text-dim)" }}>ET</span>
          <span>{etClock}</span>
        </div>

        {/* Right actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {btnState === "sent" && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mono"
              style={{
                padding: "4px 10px",
                borderRadius: 4,
                border: "1px solid var(--text-dim)",
                background: "rgba(255, 255, 255, 0.05)",
                color: "var(--text)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Reload ↻
            </button>
          )}
          <button
            type="button"
            onClick={onAutoLogin}
            disabled={btnState === "sent"}
            className="mono"
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: `1px solid ${btnState === "sent" ? "var(--ok)" : "var(--text)"}`,
              background: "transparent",
              color: btnState === "sent" ? "var(--ok)" : "var(--text)",
              fontSize: 12,
              cursor:
                btnState === "sent"
                  ? "default"
                  : btnState === "sending"
                    ? "wait"
                    : "pointer",
              opacity: btnState === "sending" ? 0.7 : 1,
              transition: "opacity 0.2s, color 0.2s, border-color 0.2s",
            }}
          >
            {btnState === "sent"
              ? "✓ Sent"
              : btnState === "sending"
                ? "Sending…"
                : authBroken
                  ? "Auto-login →"
                  : "Force Rotate Keys"}
          </button>
        </div>
      </div>
      {errorDetail && (
        <div
          className="mono"
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "6px 16px",
            fontSize: 11,
            color: "var(--bad)",
            background: "var(--bg-0)",
            borderTop: "1px solid var(--bg-2)",
            zIndex: 9999,
          }}
        >
          {errorDetail}
        </div>
      )}
    </>
  );
}

function Cell({
  label,
  value,
  dotClass,
}: {
  label: string;
  value: string;
  dotClass?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {dotClass != null && (
        <span className={`tp-dot ${dotClass}`} aria-hidden />
      )}
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function authValue(
  status: AuthStatus | null,
  test: AuthTestResult | null,
  isError?: boolean,
): string {
  if (status === null) return isError ? "server unreachable" : "checking…";
  if (!status.authenticated) return "session expired";
  if (test === null) return "verifying…";
  if (!test.ok) return "auth failed";
  const env = status.sandbox ? "sandbox" : "prod";
  const accts = test.accountsCount ?? 0;
  return `authed · ${env} · ${accts} acct${accts === 1 ? "" : "s"}`;
}

function authErrorDetail(
  status: AuthStatus | null,
  test: AuthTestResult | null,
): string | null {
  if (status === null) return null;
  if (!status.authenticated)
    return "E*TRADE session expired or invalid. Re-authenticate via OAuth to resume order placement.";
  if (test !== null && !test.ok)
    return (
      test.error ??
      "Auth verification failed — connection error or token rejected."
    );
  return null;
}

function accountValue(status: AuthStatus | null): string {
  if (status === null) return "-";
  return status.sandbox ? "sandbox" : "margin";
}

/**
 * Slice 6.2 heartbeat freshness mapping:
 *   < 90s         -> green pulse  ("Ns ago")
 *   90s .. 5min   -> amber/warn   ("stale")
 *   > 5min        -> red          ("scheduler down")
 *   null          -> paused dot   ("heartbeat -")
 */
function heartbeatValue(ageMs: number | null): string {
  if (ageMs === null) return "heartbeat -";
  if (ageMs < 90_000) {
    const sec = Math.max(0, Math.floor(ageMs / 1000));
    return `${sec}s ago`;
  }
  if (ageMs < 5 * 60_000) return "stale";
  return "scheduler down";
}

function heartbeatDotClass(ageMs: number | null): string {
  if (ageMs === null) return "paused";
  if (ageMs < 90_000) return "";
  if (ageMs < 5 * 60_000) return "warn";
  return "bad";
}
