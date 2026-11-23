import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { qrMatrix } from "./qr";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";
const inputClass = "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 ${focusRing}`;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

function QrSvg({ uri }: { uri: string }) {
  const matrix = qrMatrix(uri);
  const side = matrix.length;
  const total = side + 8;

  const parts: string[] = [];
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      if (matrix[r][c]) {
        parts.push(`M${c + 4},${r + 4}h1v1h-1z`);
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label="QR code for authenticator app"
      viewBox={`0 0 ${total} ${total}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
      className="mx-auto block rounded-lg border border-slate-200 bg-white"
    >
      <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
      <path d={parts.join("")} fill="#000000" />
    </svg>
  );
}

type MfaStatus = {
  ready: boolean;
  enabled: boolean;
  recoveryCodesRemaining: number;
};

export function MfaSettingsPanel({
  email,
  onBack,
}: {
  email: string;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Setup state
  const [settingUp, setSettingUp] = useState(false);
  const [setupData, setSetupData] = useState<{ secret: string; uri: string } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Confirm state
  const [confirmCode, setConfirmCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable state
  const [disableCode, setDisableCode] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.mfaStatus();
      setStatus(res);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  const handleStartSetup = async () => {
    setSettingUp(true);
    setSetupError(null);
    try {
      const res = await api.mfaSetup(email);
      setSetupData(res);
      setCopied(false);
      setConfirmCode("");
      setConfirmError(null);
    } catch (e) {
      setSetupError(errorText(e));
    } finally {
      setSettingUp(false);
    }
  };

  const handleCopySecret = async () => {
    if (!setupData) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      setCopied(true);
    } catch {
      // Do not fall back to any mechanism that leaks or exposes the secret elsewhere
    }
  };

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = confirmCode.trim();
    if (!trimmed || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await api.mfaConfirm(trimmed);
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      setConfirmCode("");
    } catch (err) {
      setConfirmError(errorText(err));
    } finally {
      setConfirming(false);
    }
  };

  const handleSavedRecoveryCodes = async () => {
    setRecoveryCodes(null);
    await fetchStatus();
  };

  const handleDisable = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = disableCode.trim();
    if (!trimmed || disabling) return;
    setDisabling(true);
    setDisableError(null);
    try {
      await api.mfaDisable(trimmed);
      setDisableCode("");
      await fetchStatus();
    } catch (err) {
      setDisableError(errorText(err));
    } finally {
      setDisabling(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 ${focusRing}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-base font-semibold text-slate-900">
          Two-factor authentication
        </h1>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {loading ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : loadError ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {loadError}
          </p>
        ) : recoveryCodes ? (
          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
              Save these recovery codes now — they will not be shown again.
            </div>
            <ul className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-900">
              {recoveryCodes.map((code) => (
                <li key={code} className="select-all">
                  {code}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => void handleSavedRecoveryCodes()}
              className={primaryButton}
            >
              I have saved them
            </button>
          </div>
        ) : !status?.ready ? (
          <p className="text-sm text-slate-600">
            Two-factor authentication is not available on this server yet.
          </p>
        ) : status.enabled ? (
          <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900">
              <p className="font-medium">Two-factor authentication is on.</p>
              <p className="mt-1 text-teal-800">
                Recovery codes remaining: {status.recoveryCodesRemaining}
              </p>
            </div>

            <form onSubmit={(e) => void handleDisable(e)} className="space-y-3 border-t border-slate-200 pt-5">
              <label
                htmlFor="mfa-disable-code"
                className="block text-sm font-medium text-slate-800"
              >
                Authenticator code or recovery code
              </label>
              <input
                id="mfa-disable-code"
                type="text"
                autoComplete="one-time-code"
                placeholder="6-digit code or recovery code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                disabled={disabling}
                className={inputClass}
              />
              {disableError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {disableError}
                </p>
              )}
              <button
                type="submit"
                disabled={disabling || !disableCode.trim()}
                className={primaryButton}
              >
                {disabling ? "Disabling…" : "Disable"}
              </button>
            </form>
          </div>
        ) : setupData ? (
          <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <QrSvg uri={setupData.uri} />

            <p className="text-sm text-slate-600">
              Scan with your authenticator app, or enter this secret manually.
            </p>

            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <code className="break-all font-mono text-sm text-slate-900">
                {setupData.secret}
              </code>
              <button
                type="button"
                onClick={() => void handleCopySecret()}
                className={`${outlineButton} shrink-0`}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <form onSubmit={(e) => void handleConfirm(e)} className="space-y-3 border-t border-slate-200 pt-4">
              <label
                htmlFor="mfa-confirm-code"
                className="block text-sm font-medium text-slate-800"
              >
                Verification code
              </label>
              <input
                id="mfa-confirm-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                disabled={confirming}
                className={inputClass}
              />
              {confirmError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {confirmError}
                </p>
              )}
              <button
                type="submit"
                disabled={confirming || !confirmCode.trim()}
                className={primaryButton}
              >
                {confirming ? "Confirming…" : "Confirm"}
              </button>
            </form>
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-600">
              Add an extra layer of security to your account by requiring a
              verification code from your authenticator app when signing in.
            </p>
            {setupError && (
              <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {setupError}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleStartSetup()}
              disabled={settingUp}
              className={primaryButton}
            >
              {settingUp ? "Setting up…" : "Enable two-factor authentication"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MfaChallengeForm({
  email,
  onDone,
  onCancel,
}: {
  email: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.mfaChallenge(trimmed);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold text-slate-900">
          Two-factor authentication
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter the 6-digit code from your authenticator app, or a recovery
          code.
        </p>
        <p className="mt-1 text-sm font-medium text-slate-800">{email}</p>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="mfa-challenge-code"
              className="mb-1.5 block text-sm font-medium text-slate-800"
            >
              Authentication code
            </label>
            <input
              id="mfa-challenge-code"
              type="text"
              autoComplete="one-time-code"
              placeholder="6-digit code or recovery code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={submitting}
              className={inputClass}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="space-y-2.5 pt-1">
            <button
              type="submit"
              disabled={submitting || !code.trim()}
              className={primaryButton}
            >
              {submitting ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className={`${outlineButton} w-full`}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
