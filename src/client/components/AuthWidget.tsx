import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchAuthStatus,
  fetchAuthTest,
  fetchAuthStart,
  postAuthVerify,
  postAuthReloadEnv,
  type AuthStatus,
  type AuthTestResult,
} from '../utils/api';

const AUTH_TEST_INTERVAL_MS = 60_000;

export default function AuthWidget() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [testResult, setTestResult] = useState<AuthTestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [oauthToken, setOauthToken] = useState<string | null>(null);
  const [verifier, setVerifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const modalOverlayRef = useRef<HTMLDivElement | null>(null);
  const modalRowRef = useRef<HTMLDivElement | null>(null);
  const modalPanelRef = useRef<HTMLDivElement | null>(null);
  const verifierInputRef = useRef<HTMLInputElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchAuthStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load auth status');
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const runTest = useCallback(async () => {
    try {
      const result = await fetchAuthTest();
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: 'Request failed' });
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.authenticated) return;
    runTest();
    const id = setInterval(runTest, AUTH_TEST_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status?.authenticated, runTest]);

  const handleAuthenticate = async () => {
    setVerifyError(null);
    setVerifyLoading(true);
    try {
      const start = await fetchAuthStart();
      if (!start.success || !start.authUrl || !start.oauth_token) {
        setVerifyError(start.error ?? 'Could not start OAuth');
        setVerifyLoading(false);
        return;
      }
      setOauthToken(start.oauth_token);
      setVerifier('');
      setModalOpen(true);
      window.open(start.authUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : 'Failed to start OAuth');
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleSubmitVerifier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthToken || !verifier.trim()) return;
    setVerifyError(null);
    setVerifyLoading(true);
    try {
      const result = await postAuthVerify(oauthToken, verifier.trim());
      if (!result.success) {
        setVerifyError(result.error ?? 'Verification failed');
        setVerifyLoading(false);
        return;
      }
      await postAuthReloadEnv();
      setModalOpen(false);
      setOauthToken(null);
      setVerifier('');
      await loadStatus();
      await runTest();
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : 'Failed to save tokens');
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleCloseModal = () => {
    if (!verifyLoading) {
      setModalOpen(false);
      setOauthToken(null);
      setVerifier('');
      setVerifyError(null);
    }
  };

  useEffect(() => {
    if (!modalOpen) return;
    const panel = modalPanelRef.current;
    const row = modalRowRef.current;
    const overlay = modalOverlayRef.current;
    const input = verifierInputRef.current;
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const overlayRect = overlay?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
    const rowStyle = row ? window.getComputedStyle(row) : null;
    const panelStyle = window.getComputedStyle(panel);
    let transformedAncestor: string | null = null;
    let overflowAncestor: string | null = null;
    let node: HTMLElement | null = panel.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (!transformedAncestor && style.transform && style.transform !== 'none') {
        transformedAncestor = node.className || node.tagName;
      }
      if (
        !overflowAncestor &&
        (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible')
      ) {
        overflowAncestor = `${node.className || node.tagName} (${style.overflow}/${style.overflowX}/${style.overflowY})`;
      }
      node = node.parentElement;
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/01890202-0bd1-47e9-9591-85d056065d1c', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'post-fix',
        hypothesisId: 'H1_H2_H4',
        location: 'AuthWidget.tsx:modalOpen-useEffect',
        message: 'Modal geometry and ancestor layout diagnostics',
        data: {
          modalOpen,
          viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
          visualViewport: visualViewport
            ? {
                width: visualViewport.width,
                height: visualViewport.height,
                offsetTop: visualViewport.offsetTop,
                offsetLeft: visualViewport.offsetLeft,
                pageTop: visualViewport.pageTop,
                pageLeft: visualViewport.pageLeft,
              }
            : null,
          windowScroll: { x: window.scrollX, y: window.scrollY },
          overlayScrollTop: overlay?.scrollTop ?? null,
          overlayScrollHeight: overlay?.scrollHeight ?? null,
          overlayClientHeight: overlay?.clientHeight ?? null,
          overlayRect: overlayRect
            ? {
                top: overlayRect.top,
                bottom: overlayRect.bottom,
                height: overlayRect.height,
                left: overlayRect.left,
                right: overlayRect.right,
                width: overlayRect.width,
              }
            : null,
          rowRect: rowRect
            ? {
                top: rowRect.top,
                bottom: rowRect.bottom,
                height: rowRect.height,
                left: rowRect.left,
                right: rowRect.right,
                width: rowRect.width,
              }
            : null,
          overlayComputed: overlayStyle
            ? {
                position: overlayStyle.position,
                top: overlayStyle.top,
                bottom: overlayStyle.bottom,
                left: overlayStyle.left,
                right: overlayStyle.right,
                height: overlayStyle.height,
                width: overlayStyle.width,
                display: overlayStyle.display,
                zIndex: overlayStyle.zIndex,
              }
            : null,
          rowComputed: rowStyle
            ? {
                display: rowStyle.display,
                alignItems: rowStyle.alignItems,
                justifyContent: rowStyle.justifyContent,
                paddingTop: rowStyle.paddingTop,
                minHeight: rowStyle.minHeight,
              }
            : null,
          panelComputed: {
            width: panelStyle.width,
            maxWidth: panelStyle.maxWidth,
            paddingTop: panelStyle.paddingTop,
            display: panelStyle.display,
          },
          docMetrics: {
            bodyClientHeight: document.body.clientHeight,
            bodyScrollHeight: document.body.scrollHeight,
            docElClientHeight: document.documentElement.clientHeight,
            docElScrollHeight: document.documentElement.scrollHeight,
          },
          panelRect: {
            top: panelRect.top,
            bottom: panelRect.bottom,
            height: panelRect.height,
          },
          inputRect: inputRect
            ? {
                top: inputRect.top,
                bottom: inputRect.bottom,
                height: inputRect.height,
              }
            : null,
          transformedAncestor,
          overflowAncestor,
          panelOutOfFrameTop: panelRect.top < 0,
          panelOutOfFrameBottom: panelRect.bottom > window.innerHeight,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    const onScroll = () => {
      const panel = modalPanelRef.current;
      const overlay = modalOverlayRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/01890202-0bd1-47e9-9591-85d056065d1c', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'post-fix',
          hypothesisId: 'H3',
          location: 'AuthWidget.tsx:window-scroll-listener',
          message: 'Window scroll while modal is open',
          data: {
            windowScrollY: window.scrollY,
            overlayScrollTop: overlay?.scrollTop ?? null,
            panelTop: rect.top,
            panelBottom: rect.bottom,
            activeElementTag: document.activeElement?.tagName ?? null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [modalOpen]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm">
        <span>Auth…</span>
      </div>
    );
  }

  const hasTokens = !!status?.authenticated;
  const etradeVerified = hasTokens && testResult?.ok === true;
  const verifyingEtrade = hasTokens && testResult == null;

  return (
    <>
      <div className="flex items-center gap-3">
        {error && (
          <span className="text-amber-400 text-sm" title={error}>
            {error}
          </span>
        )}
        {etradeVerified ? (
          <>
            <span
              className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                testResult == null
                  ? 'bg-slate-500'
                  : testResult.ok
                    ? 'bg-green-500'
                    : 'bg-red-500'
              }`}
              title={
                testResult == null
                  ? 'Not checked yet'
                  : testResult.ok
                    ? `OK — ${testResult.accountsCount ?? 0} account(s)`
                    : testResult.error ?? 'Connection failed'
              }
              aria-hidden
            />
            <span className="text-slate-300 text-sm">
              {status.sandbox ? 'Sandbox' : 'Prod'} · Authenticated
            </span>
            <button
              type="button"
              onClick={() => runTest()}
              className="px-3 py-1.5 rounded text-sm font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 border border-slate-600 transition-colors"
            >
              Verify E*TRADE auth
            </button>
          </>
        ) : (
          <div className="relative group inline-flex items-center gap-3">
            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${verifyingEtrade ? 'bg-amber-400' : 'bg-red-500'}`} aria-hidden />
            <span className="text-slate-300 text-sm">
              {verifyingEtrade ? 'Verifying E*TRADE session…' : 'Not authenticated with E*TRADE'}
            </span>
            {!etradeVerified && testResult?.error && (
              <span
                className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block w-72 p-2 text-xs text-amber-200 border border-slate-600 rounded-lg shadow-2xl shadow-black/70 whitespace-normal"
                style={{ backgroundColor: '#020617', opacity: 1 }}
                role="tooltip"
              >
                {testResult.error}
              </span>
            )}
            {!verifyingEtrade && (
              <button
                type="button"
                onClick={handleAuthenticate}
                disabled={verifyLoading}
                className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed border border-blue-500 transition-colors"
              >
                {verifyLoading ? 'Starting…' : 'Login / Authenticate'}
              </button>
            )}
          </div>
        )}
      </div>

      {modalOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 overflow-auto bg-black/70 backdrop-blur-sm"
            aria-modal="true"
            role="dialog"
            ref={modalOverlayRef}
            style={{ position: 'fixed', inset: 0 }}
          >
            <div
              className="flex min-h-full items-start justify-center pt-32 pb-8 px-6"
              ref={modalRowRef}
              style={{
                display: 'flex',
                minHeight: '100vh',
                alignItems: 'flex-start',
                justifyContent: 'center',
                paddingTop: '8rem',
                paddingBottom: '2rem',
                paddingLeft: '1.5rem',
                paddingRight: '1.5rem',
                boxSizing: 'border-box',
              }}
            >
              <div
                className="border border-slate-600 rounded-lg shadow-2xl shadow-black/70 max-w-md w-full p-5 shrink-0"
                style={{
                  backgroundColor: '#020617',
                  opacity: 1,
                  width: '100%',
                  maxWidth: '28rem',
                  padding: '1.25rem',
                  boxSizing: 'border-box',
                }}
                onClick={(e) => e.stopPropagation()}
                ref={modalPanelRef}
              >
                <h3 className="text-lg font-semibold text-white mb-2">Enter verification code</h3>
                <p className="text-slate-400 text-sm mb-4">
                  E*TRADE showed a code in the browser. Enter it below.
                </p>
                <form onSubmit={handleSubmitVerifier}>
                  <input
                    type="text"
                    value={verifier}
                    onChange={(e) => setVerifier(e.target.value)}
                    onFocus={() => {
                      const panel = modalPanelRef.current;
                      const overlay = modalOverlayRef.current;
                      const rect = panel?.getBoundingClientRect();
                      // #region agent log
                      fetch('http://127.0.0.1:7242/ingest/01890202-0bd1-47e9-9591-85d056065d1c', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          runId: 'post-fix',
                          hypothesisId: 'H3',
                          location: 'AuthWidget.tsx:verifier-input-onFocus',
                          message: 'Verifier input focused',
                          data: {
                            windowScrollY: window.scrollY,
                            overlayScrollTop: overlay?.scrollTop ?? null,
                            panelTop: rect?.top ?? null,
                            panelBottom: rect?.bottom ?? null,
                            viewportHeight: window.innerHeight,
                          },
                          timestamp: Date.now(),
                        }),
                      }).catch(() => {});
                      // #endregion
                    }}
                    placeholder="e.g. A1B2C"
                    className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    autoFocus
                    autoComplete="one-time-code"
                    ref={verifierInputRef}
                  />
                  {verifyError && (
                    <p className="mt-2 text-sm text-red-400">{verifyError}</p>
                  )}
                  <div className="flex gap-2 mt-4">
                    <button
                      type="submit"
                      disabled={verifyLoading || !verifier.trim()}
                      className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {verifyLoading ? 'Saving…' : 'Submit'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCloseModal}
                      disabled={verifyLoading}
                      className="px-4 py-2 rounded font-medium bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
