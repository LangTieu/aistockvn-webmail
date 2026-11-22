import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api, ApiError, type Alias, type Domain } from "./api";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";
const inputClass =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const dangerButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

function copyText(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error("Copy failed"));
    } catch (err) {
      document.body.removeChild(ta);
      reject(err);
    }
  });
}

export function AliasesPanel({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [allDomains, setAllDomains] = useState<Domain[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [dRes, aRes] = await Promise.all([api.domains(), api.listAliases()]);
      setAllDomains(dRes.domains);
      const enabledDomains = dRes.domains.filter((d) => d.enabled);
      setDomains(enabledDomains);
      setSelectedDomain((prev) =>
        enabledDomains.some((d) => d.domain === prev) ? prev : enabledDomains[0]?.domain || "",
      );
      setAliases(aRes.aliases);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load aliases.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      await api.createAlias(label.trim(), selectedDomain || undefined);
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create alias.");
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (alias: Alias) => {
    setError("");
    setBusyId(alias.id);
    try {
      await api.setAliasEnabled(alias.id, !alias.enabled);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update alias.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (alias: Alias) => {
    if (!window.confirm("Delete this alias? Mail sent to it will no longer reach your inbox.")) return;
    setError("");
    setBusyId(alias.id);
    try {
      await api.deleteAlias(alias.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete alias.");
    } finally {
      setBusyId(null);
    }
  };

  const handleAddDomain = async () => {
    const domain = newDomain.trim();
    if (!domain) return;
    setAddError("");
    setCreating(true);
    try {
      await api.addDomain(domain);
      setNewDomain("");
      setAddError(null);
      await load();
    } catch (e) {
      setAddError(e instanceof ApiError ? e.message : "Failed to add domain.");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleDomain = async (domain: Domain) => {
    setError("");
    setBusyId(domain.domain);
    try {
      await api.setDomainEnabled(domain.domain, !domain.enabled);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update domain.");
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (alias: Alias) => {
    try {
      await copyText(alias.address);
      setCopiedId(alias.id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === alias.id ? null : cur));
      }, 1500);
    } catch {
      setError("Failed to copy address.");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-white text-sm text-slate-600">
        Loading...
      </div>
    );
  }

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
        <p className="sr-only">Aliases</p>
        <h1 className="text-base font-semibold text-slate-900">Email aliases</h1>
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
          Mail to a disabled alias is rejected and never reaches your inbox. Mail to any other address at your domain still arrives as usual.
        </p>

        {error && (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium tracking-wide text-teal-700 uppercase">Domains</p>
          <p className="mt-1 text-sm text-slate-600">adding a domain here does not configure DNS or Email Routing — that is still done in Cloudflare</p>
          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-2.5 text-left text-xs font-medium tracking-wide text-slate-600 uppercase">Domain</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium tracking-wide text-slate-600 uppercase">Enabled</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium tracking-wide text-slate-600 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {allDomains.map((d) => (
                  <tr key={d.domain} className="hover:bg-slate-50">
                    <td className="px-4 py-3.5 text-left text-sm font-medium text-slate-900">{d.domain}</td>
                    <td className="px-4 py-3.5 text-center">
                      {d.enabled ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Enabled</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Disabled</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <button
                        onClick={() => handleToggleDomain(d)}
                        className={outlineButton}
                      >
                        {d.enabled ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}
                {allDomains.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-8 py-16 text-center text-sm text-slate-500">No domains added yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              placeholder="e.g. example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              className={inputClass}
            />
            <button
              onClick={handleAddDomain}
              disabled={!newDomain.trim() || creating}
              className={primaryButton}
            >
              {creating ? "Adding..." : "Add"}
            </button>
          </div>
          {addError && (
            <div role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {addError}
            </div>
          )}
        </section>

        <form
          onSubmit={handleCreate}
          className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-800">Service label</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Service name, e.g. Online shop"
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:w-52">
            <span className="text-sm font-medium text-slate-800">Domain</span>
            <select
              aria-label="Domain"
              value={selectedDomain}
              onChange={(e) => setSelectedDomain(e.target.value)}
              disabled={domains.length === 0}
              className={inputClass}
            >
              {domains.map((d) => (
                <option key={d.domain} value={d.domain}>
                  {d.domain}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={creating || domains.length === 0 || !label.trim()}
            className={primaryButton}
          >
            {creating ? "Creating..." : "Create alias"}
          </button>
        </form>

        {aliases.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-white px-8 py-16 text-center shadow-sm">
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
            <p className="text-sm text-slate-500">
              No aliases yet. Create one to hide your real address when signing up for a service.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {aliases.map((a) => {
              const disabled = !a.enabled;
              const isBusy = busyId === a.id;
              return (
                <li
                  key={a.id}
                  className={`flex flex-col gap-3 px-4 py-3.5 hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between ${
                    disabled ? "opacity-60" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium text-slate-900">{a.address}</span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          a.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {a.enabled ? "Active" : "Disabled"}
                      </span>
                    </div>
                    {a.label && <p className="mt-0.5 truncate text-sm text-slate-600">{a.label}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(a)}
                      className={outlineButton}
                    >
                      {copiedId === a.id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleToggle(a)}
                      className={outlineButton}
                    >
                      {a.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDelete(a)}
                      className={dangerButton}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
