import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type ExternalAccount } from "./api";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";
const inputClass =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const dangerButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

function formatDateTime(ts: number | null): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function statusClass(status: string): string {
  if (status === "active") return "bg-teal-50 text-teal-700";
  if (status === "error") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-600";
}

export function ExternalMailPanel({ onBack }: { onBack: () => void }) {
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectMessage, setConnectMessage] = useState<string | null>(null);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.listExternalAccounts();
      setAccounts(res.accounts ?? []);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConnect = async (e: FormEvent) => {
    e.preventDefault();
    if (connecting) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !appPassword) return;
    setConnecting(true);
    setConnectError(null);
    setConnectMessage(null);
    try {
      const res = await api.connectGmail({ email: trimmedEmail, appPassword });
      setAccounts((prev) => [...prev.filter((a) => a.id !== res.account.id), res.account]);
      setEmail("");
      setAppPassword("");
      setConnectMessage(`Connected ${res.account.email}.`);
    } catch (err) {
      setConnectError(errorText(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async (account: ExternalAccount) => {
    if (syncingId) return;
    setSyncingId(account.id);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const res = await api.syncGmailNow(account.id);
      if ("skipped" in res) {
        setSyncMessage("Sync was skipped because another sync is already running for this account.");
      } else {
        setSyncMessage(
          `Sync finished: ${res.fetched} fetched, ${res.inserted} new, ${res.duplicates} duplicates, ${res.errors} errors.`,
        );
      }
      await load();
    } catch (err) {
      setSyncError(errorText(err));
    } finally {
      setSyncingId(null);
    }
  };

  const handleDisconnect = async (account: ExternalAccount) => {
    if (disconnectingId) return;
    if (confirmDisconnectId !== account.id) {
      setConfirmDisconnectId(account.id);
      setDisconnectError(null);
      return;
    }
    setDisconnectingId(account.id);
    setDisconnectError(null);
    try {
      await api.disconnectGmail(account.id);
      setConfirmDisconnectId(null);
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
    } catch (err) {
      setDisconnectError(errorText(err));
    } finally {
      setDisconnectingId(null);
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
        <h1 className="text-base font-semibold text-slate-900">External mail</h1>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {loading ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : loadError ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {loadError}
          </p>
        ) : (
          <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <section aria-labelledby="external-accounts-heading" className="space-y-3">
              <h2 id="external-accounts-heading" className="text-base font-semibold text-slate-900">
                Connected accounts
              </h2>

              {accounts.length === 0 ? (
                <div className="flex flex-col items-center px-8 py-16 text-center">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="mb-3 h-10 w-10 text-slate-300"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="m3 7 9 6 9-6" />
                  </svg>
                  <p className="text-sm text-slate-500">No external accounts connected.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">
                  {accounts.map((account) => {
                    const isConfirming = confirmDisconnectId === account.id;
                    return (
                      <li key={account.id} className="space-y-2 px-4 py-3.5 hover:bg-slate-50">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{account.email}</p>
                            <p className="text-xs text-slate-500">Gmail</p>
                          </div>
                          <span
                            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(account.status)}`}
                          >
                            {account.status}
                          </span>
                        </div>

                        <dl className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <dt className="text-slate-500">Last sync</dt>
                            <dd className="font-medium text-slate-800">{formatDateTime(account.lastSyncedAt)}</dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">Last UID</dt>
                            <dd className="font-medium text-slate-800">{account.lastSeenUid}</dd>
                          </div>
                        </dl>

                        {account.lastError && (
                          <p className="text-xs text-red-600">Last error: {account.lastError}</p>
                        )}

                        <div className="flex flex-wrap gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => void handleSync(account)}
                            disabled={syncingId === account.id}
                            className={outlineButton}
                          >
                            {syncingId === account.id ? "Syncing…" : "Sync now"}
                          </button>
                          {isConfirming ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleDisconnect(account)}
                                disabled={disconnectingId === account.id}
                                className={dangerButton}
                              >
                                {disconnectingId === account.id
                                  ? "Disconnecting…"
                                  : "Confirm disconnect?"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDisconnectId(null)}
                                disabled={disconnectingId === account.id}
                                className={outlineButton}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleDisconnect(account)}
                              className={outlineButton}
                            >
                              Disconnect
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {syncError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {syncError}
                </p>
              )}
              {syncMessage && (
                <p role="status" className="text-sm text-teal-700">
                  {syncMessage}
                </p>
              )}
              {disconnectError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {disconnectError}
                </p>
              )}
            </section>

            <section
              aria-labelledby="external-connect-heading"
              className="space-y-3 border-t border-slate-200 pt-6"
            >
              <h2 id="external-connect-heading" className="text-base font-semibold text-slate-900">
                Connect a Gmail account
              </h2>
              <p className="text-xs text-slate-500">
                Use a Google App Password, not your regular Gmail password. Create an App Password in your Google
                account (requires 2-Step Verification). The App Password is stored encrypted and is never shown again
                after saving.
              </p>

              <form onSubmit={(e) => void handleConnect(e)} className="space-y-3">
                <div>
                  <label htmlFor="external-gmail-email" className="mb-1.5 block text-sm font-medium text-slate-800">
                    Gmail address
                  </label>
                  <input
                    id="external-gmail-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={connecting}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label
                    htmlFor="external-gmail-password"
                    className="mb-1.5 block text-sm font-medium text-slate-800"
                  >
                    App Password
                  </label>
                  <input
                    id="external-gmail-password"
                    type="password"
                    autoComplete="off"
                    placeholder="App Password"
                    value={appPassword}
                    onChange={(e) => setAppPassword(e.target.value)}
                    disabled={connecting}
                    className={inputClass}
                  />
                </div>

                {connectError && (
                  <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {connectError}
                  </p>
                )}
                {connectMessage && (
                  <p role="status" className="text-sm text-teal-700">
                    {connectMessage}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={connecting || !email.trim() || !appPassword}
                  className={`${primaryButton} sm:w-auto`}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
