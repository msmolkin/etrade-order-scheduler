/**
 * Slice 6.1 AuthFix hero panel.
 *
 * Replaces the DayStrip slot in OrderList when E*TRADE auth has expired
 * (`auth.status.authenticated === false`). Surfaces three things at once:
 *
 *   1. A live progress checklist of the auto-login flow (OAuth → 2FA →
 *      submit → save tokens). Each step transitions pending → in-progress →
 *      ok / failed driven by the responses from `postAuthAuto` and
 *      `postAuthAutoSubmitCode` plus the WS `auth_status` event.
 *   2. A manual 6-digit OTP input with a 3-min countdown — the fallback if
 *      the Gmail relay webhook is slow to hit `/auto/webhook`. Submitting
 *      calls `postAuthAutoSubmitCode(sessionId, code)`.
 *   3. A "Missed this morning · will auto-retry once auth restored" list
 *      filtered from the `orders` cache: REJECTED orders created today whose
 *      `lastError` matches the OAuth/token regex, and PAUSED orders queued
 *      for auth recovery (Slice 6.3 path).
 *
 * Mounted by OrderList: `auth.authenticated ? <DayStrip /> : <AuthFix />`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrders } from "../hooks/useOrders";
import { useAuthStatus } from "../hooks/useAuthStatus";
import {
  postAuthAuto,
  postAuthAutoSubmitCode,
  type AuthAutoResult,
  type Order,
} from "../utils/api";

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** YYYY-MM-DD in ET, used to filter "today only". */
function todayKeyET(): string {
  return dateKeyFormatter.format(new Date());
}

function dayKeyET(iso: string | undefined): string | null {
  if (!iso) return null;
  return dateKeyFormatter.format(new Date(iso));
}

type StepState = "pending" | "in-progress" | "ok" | "failed";

interface ChecklistStep {
  id: "oauth" | "wait-2fa" | "submit" | "save";
  label: string;
  state: StepState;
}

const INITIAL_STEPS: ChecklistStep[] = [
  { id: "oauth", label: "Triggering OAuth flow…", state: "pending" },
  {
    id: "wait-2fa",
    label: "Waiting for SMS / Gmail relay (this can take ~60 s)",
    state: "pending",
  },
  { id: "submit", label: "Submitting OTP to E*TRADE", state: "pending" },
  { id: "save", label: "Saving fresh tokens", state: "pending" },
];

const COUNTDOWN_TOTAL_MS = 3 * 60 * 1000;
const TOKEN_ERROR_RX = /oauth_problem|token_(rejected|expired)/i;

function stepIcon(state: StepState): string {
  switch (state) {
    case "pending":
      return "⏳";
    case "in-progress":
      return "🔄";
    case "ok":
      return "✓";
    case "failed":
      return "✕";
  }
}

function stepColor(state: StepState): string {
  switch (state) {
    case "pending":
      return "var(--text-dim)";
    case "in-progress":
      return "var(--accent)";
    case "ok":
      return "var(--ok)";
    case "failed":
      return "var(--bad)";
  }
}

function isAuthBlocked(o: Order): boolean {
  // Match the two paths Slice 6.3 produces:
  //   - REJECTED with token-error message AND created today
  //   - PAUSED with lastError === 'queued for auth recovery'
  if (o.status === "PAUSED" && o.lastError === "queued for auth recovery") {
    return true;
  }
  if (
    o.status === "REJECTED" &&
    o.lastError &&
    TOKEN_ERROR_RX.test(o.lastError)
  ) {
    return dayKeyET(o.createdAt) === todayKeyET();
  }
  return false;
}

export default function AuthFix() {
  const { status } = useAuthStatus();
  const { data: orders = [] } = useOrders();

  const [steps, setSteps] = useState<ChecklistStep[]>(INITIAL_STEPS);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submittingCode, setSubmittingCode] = useState(false);

  const wasAuthedRef = useRef<boolean>(status?.authenticated === true);

  const setStepState = useCallback(
    (id: ChecklistStep["id"], state: StepState) => {
      setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, state } : s)));
    },
    [],
  );

  const resetChecklist = useCallback(() => {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    setError(null);
  }, []);

  // Auto-restore success path: when the upstream useAuthStatus flips to
  // authenticated:true (driven by the WS auth_status event), mark steps 3+4
  // as ok so the user gets visual confirmation before the parent unmounts us.
  useEffect(() => {
    if (status?.authenticated === true && !wasAuthedRef.current) {
      setStepState("submit", "ok");
      setStepState("save", "ok");
      setSessionId(null);
      setStartedAt(null);
      setError(null);
    }
    wasAuthedRef.current = status?.authenticated === true;
  }, [status?.authenticated, setStepState]);

  // Countdown ticker.
  useEffect(() => {
    if (!startedAt) {
      setElapsedMs(0);
      return;
    }
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [startedAt]);

  const triggerAutoLogin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    resetChecklist();
    setStepState("oauth", "in-progress");
    setStartedAt(Date.now());

    let result: AuthAutoResult;
    try {
      result = await postAuthAuto({ clearCookies: true });
    } catch (e: any) {
      setStepState("oauth", "failed");
      setError(e?.message ?? "Auto-login request failed");
      setBusy(false);
      return;
    }

    if (result.success) {
      // Server completed without needing 2FA (rare but possible).
      setStepState("oauth", "ok");
      setStepState("wait-2fa", "ok");
      setStepState("submit", "ok");
      setStepState("save", "ok");
      setBusy(false);
      return;
    }

    if (result.requiresTwoFactorCode && result.sessionId) {
      setStepState("oauth", "ok");
      setStepState("wait-2fa", "in-progress");
      setSessionId(result.sessionId);
      setBusy(false);
      return;
    }

    // Hard failure — surface and stop.
    setStepState("oauth", "failed");
    setError(result.error ?? "Auto-login could not start.");
    setBusy(false);
  }, [busy, resetChecklist, setStepState]);

  const submitManualCode = useCallback(async () => {
    if (!sessionId || submittingCode) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Code must be exactly 6 digits.");
      return;
    }
    setSubmittingCode(true);
    setError(null);
    setStepState("submit", "in-progress");

    let result: AuthAutoResult;
    try {
      result = await postAuthAutoSubmitCode(sessionId, trimmed);
    } catch (e: any) {
      setStepState("submit", "failed");
      setError(e?.message ?? "OTP submit request failed");
      setSubmittingCode(false);
      return;
    }

    if (result.success) {
      setStepState("submit", "ok");
      setStepState("save", "in-progress");
      // The WS auth_status:authenticated:true event will flip the parent
      // back to <DayStrip /> shortly — no further action here.
    } else {
      setStepState("submit", "failed");
      setError(result.error ?? "OTP rejected by E*TRADE.");
    }
    setSubmittingCode(false);
  }, [sessionId, code, submittingCode, setStepState]);

  const missedToday = useMemo(() => orders.filter(isAuthBlocked), [orders]);

  const remainingMs = sessionId
    ? Math.max(0, COUNTDOWN_TOTAL_MS - elapsedMs)
    : 0;
  const remainingMin = Math.floor(remainingMs / 60_000);
  const remainingSec = Math.floor((remainingMs % 60_000) / 1000);
  const countdownLabel = sessionId
    ? `${remainingMin}:${String(remainingSec).padStart(2, "0")}`
    : "—:—";
  const countdownExpired = sessionId !== null && remainingMs === 0;

  return (
    <div
      className="mono"
      style={{
        width: "100%",
        marginBottom: 16,
        border: "1px solid var(--bad)",
        borderRadius: 8,
        background: "var(--bg-1)",
        boxShadow: "0 0 0 1px rgba(255, 80, 80, 0.15) inset",
        overflow: "hidden",
      }}
      data-testid="authfix-hero"
    >
      {/* Top: red indicator + heading + Try Auto-login. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          background: "var(--bad)",
          color: "var(--bg-0)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--bg-0)",
            opacity: 0.95,
            boxShadow: "0 0 0 3px rgba(0,0,0,0.18)",
            animation: "tp-pulse 1.4s ease-in-out infinite",
          }}
        />
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
          E*TRADE auth expired — your scheduled orders cannot fire.
        </div>
        <button
          type="button"
          onClick={triggerAutoLogin}
          disabled={busy}
          className="mono"
          style={{
            padding: "6px 12px",
            borderRadius: 4,
            border: "1px solid var(--bg-0)",
            background: "transparent",
            color: "var(--bg-0)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Starting…" : "Try Auto-login"}
        </button>
      </div>

      {/* Body: two-column panel. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          padding: 16,
          borderBottom: "1px solid var(--bg-2)",
        }}
      >
        {/* Left: checklist */}
        <div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-dim)",
              marginBottom: 8,
            }}
          >
            Auto-login progress
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {steps.map((s) => (
              <li
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: stepColor(s.state),
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    fontSize: 12,
                    animation:
                      s.state === "in-progress"
                        ? "tp-spin 1.2s linear infinite"
                        : "none",
                  }}
                  aria-hidden
                >
                  {stepIcon(s.state)}
                </span>
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
          {error !== null && (
            <div
              style={{
                marginTop: 10,
                padding: "6px 8px",
                borderRadius: 4,
                background: "rgba(255, 80, 80, 0.08)",
                color: "var(--bad)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Right: manual OTP fallback */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
              }}
            >
              Manual OTP fallback
            </div>
            <div
              style={{
                fontSize: 12,
                color: countdownExpired ? "var(--bad)" : "var(--text-dim)",
              }}
              aria-live="polite"
            >
              {sessionId
                ? `expires in ${countdownLabel}`
                : "session not started"}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="6-digit code"
              disabled={!sessionId || submittingCode || countdownExpired}
              className="mono"
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 4,
                border: "1px solid var(--bg-3)",
                background: "var(--bg-0)",
                color: "var(--text)",
                fontSize: 14,
                letterSpacing: "0.4em",
                textAlign: "center",
              }}
              data-testid="authfix-otp-input"
            />
            <button
              type="button"
              onClick={submitManualCode}
              disabled={
                !sessionId ||
                submittingCode ||
                countdownExpired ||
                code.length !== 6
              }
              className="mono"
              style={{
                padding: "8px 14px",
                borderRadius: 4,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--bg-0)",
                fontSize: 12,
                fontWeight: 600,
                cursor:
                  !sessionId ||
                  submittingCode ||
                  countdownExpired ||
                  code.length !== 6
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  !sessionId ||
                  submittingCode ||
                  countdownExpired ||
                  code.length !== 6
                    ? 0.5
                    : 1,
              }}
            >
              {submittingCode ? "Sending…" : "Submit code"}
            </button>
          </div>

          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: "var(--text-dim)",
              lineHeight: 1.5,
            }}
          >
            The Gmail relay normally completes the 2FA step within ~60 s. If it
            doesn&apos;t, paste the code from your phone here.
          </div>
        </div>
      </div>

      {/* Missed-this-morning section. */}
      <div style={{ padding: 12 }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>Missed this morning · will auto-retry once auth restored</span>
          <span
            style={{
              padding: "0 6px",
              borderRadius: 10,
              background: "var(--bg-2)",
              color: "var(--text-dim)",
              fontSize: 11,
            }}
          >
            {missedToday.length}
          </span>
        </div>
        {missedToday.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontStyle: "italic",
            }}
          >
            No orders waiting on auth recovery.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {missedToday.map((o) => (
              <li
                key={o.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 8,
                  alignItems: "center",
                  padding: "4px 6px",
                  background: "var(--bg-0)",
                  borderRadius: 4,
                  fontSize: 12,
                  border: "1px solid var(--bg-2)",
                }}
              >
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: 3,
                    background:
                      o.status === "PAUSED" ? "var(--paused)" : "var(--bad)",
                    color: "var(--bg-0)",
                    fontSize: 10,
                    letterSpacing: "0.04em",
                  }}
                >
                  {o.status}
                </span>
                <span>
                  {o.symbol} · {o.action} · qty {o.quantity}
                  {o.scheduledFor ? (
                    <span style={{ color: "var(--text-dim)" }}>
                      {" "}
                      · sched {timeFormatter.format(new Date(o.scheduledFor))}
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    color: "var(--text-dim)",
                    fontSize: 11,
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={o.lastError ?? ""}
                >
                  {o.lastError ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
