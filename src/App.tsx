import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type MouseEvent, type ReactNode } from "react";

import {
  api,
  ApiError,
  batchMessages,
  deleteDraftApi,
  fetchDraft,
  fetchDrafts,
  fetchStarred,
  fetchThread,
  fetchThreads,
  markMessageRead,
  saveDraft,
  searchMessages,
  setStarred,
  type Addr,
  type BatchAction,
  type Config,
  type DraftItem,
  type MessageDetail,
  type MessageItem,
} from "./api";
import { MfaChallengeForm, MfaSettingsPanel } from "./mfa";
// PHASE1-ALIASES-UI
import { AliasesPanel } from "./aliases";
// PHASE4-R4
import { NotificationsPanel } from "./notifications";
// PHASE4-R6
import { AdminPanel } from "./admin";
// PHASE4-R7
import { ExternalMailPanel } from "./external";
import { DraftsView } from "./drafts";
import {
  addrLine,
  Avatar,
  BatchBar,
  focusRing,
  formatDate,
  I,
  Icon,
  IconButton,
  MailBody,
  MessageRowContent,
  SelectableMailRow,
  StarIcon,
  useBatchSelection,
} from "./shared-mail-views";
// MFA-UI-WIRED

/* ---------- helpers ---------- */

type Folder = "inbox" | "sent" | "spam";
type NavSection = Folder | "starred" | "drafts";
type ThreadMode = "list" | "threads";
type ThreadItem = Awaited<ReturnType<typeof fetchThreads>>["threads"][number];

type Route =
  | { name: "list"; folder: Folder }
  | { name: "starred" }
  | { name: "drafts" }
  | { name: "message"; id: string }
  | { name: "compose"; replyTo?: string; forward?: string; draftId?: string }
  | { name: "reset"; token: string | null }
  | { name: "security" }
  // PHASE1-ALIASES-UI
  | { name: "aliases" }
  // PHASE4-R4
  | { name: "notifications" }
  // PHASE4-R6
  | { name: "admin" }
  // PHASE4-R7
  | { name: "external" };

function parseRoute(url: string): Route {
  const [path, query = ""] = url.split("?");
  const qs = new URLSearchParams(query);
  const m = path.match(/^\/m\/([0-9a-f-]{36}|[0-9A-Za-z]{8})$/);
  if (m) return { name: "message", id: m[1] };
  if (path === "/compose")
    return {
      name: "compose",
      replyTo: qs.get("reply") || undefined,
      forward: qs.get("forward") || undefined,
      draftId: qs.get("draft") || undefined,
    };
  if (path === "/sent") return { name: "list", folder: "sent" };
  if (path === "/spam") return { name: "list", folder: "spam" };
  if (path === "/starred") return { name: "starred" };
  if (path === "/drafts") return { name: "drafts" };
  if (path === "/security") return { name: "security" };
  // PHASE1-ALIASES-UI
  if (path === "/aliases") return { name: "aliases" };
  // PHASE4-R4
  if (path === "/notifications") return { name: "notifications" };
  // PHASE4-R6
  if (path === "/admin") return { name: "admin" };
  // PHASE4-R7
  if (path === "/external") return { name: "external" };
  if (path === "/reset" && qs.get("token")) return { name: "reset", token: qs.get("token") || null };
  return { name: "list", folder: "inbox" };
}

function useRoute(): Route {
  const [url, setUrl] = useState(() => {
    if (location.hash.startsWith("#/")) {
      const legacyUrl = `${location.hash.slice(1)}`;
      history.replaceState(null, "", legacyUrl);
    }
    return `${location.pathname}${location.search}`;
  });
  useEffect(() => {
    const on = () => setUrl(`${location.pathname}${location.search}`);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return useMemo(() => parseRoute(url), [url]);
}

const go = (url: string) => {
  history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
};

function spaLinkClick(url: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    go(url);
  };
}

function back(fallback: string) {
  if (history.length > 1) history.back();
  else go(fallback);
}

const sectionPath = (s: NavSection) =>
  s === "sent"
    ? "/sent"
    : s === "spam"
      ? "/spam"
      : s === "starred"
        ? "/starred"
        : s === "drafts"
          ? "/drafts"
          : "/inbox";

function formatHHMM(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const displayName = (a?: Addr | null) => (a ? a.name || a.address || "" : "");

/* ---------- shared UI ---------- */

const inputClass =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 ${focusRing}`;

function Spinner() {
  return <div role="status" aria-label="Loading" className="mx-auto my-10 h-7 w-7 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />;
}

function FullSpinner() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      {message}
      {onRetry && (
        <button onClick={onRetry} className="ml-2 font-semibold underline">
          Retry
        </button>
      )}
    </div>
  );
}

function Brand({ className = "", labelClassName = "", dark = false }: { className?: string; labelClassName?: string; dark?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white">
        <Icon d={I.mail} className="h-4 w-4" />
      </span>
      <span className={`truncate text-lg font-semibold tracking-tight ${dark ? "text-white" : "text-slate-900"} ${labelClassName}`}>AI Stock VN Mail</span>
    </div>
  );
}

function TopBar({ title, account, onOpenMenu, children }: { title: string; account: string; onOpenMenu: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 md:px-4 md:py-3">
      <IconButton icon={I.menu} label="Open menu" onClick={onOpenMenu} className="md:hidden" />
      <h2 className="min-w-0 flex-1 truncate px-2 text-lg font-semibold text-slate-900 md:px-0">{title}</h2>
      {children}
      <button
        type="button"
        aria-label="Account menu"
        title={account}
        onClick={onOpenMenu}
        className={`ml-1 shrink-0 rounded-full md:hidden ${focusRing}`}
      >
        <Avatar label={account} size="sm" />
      </button>
    </div>
  );
}

const threadUnreadCount = (thread: ThreadItem) => {
  const t = thread as ThreadItem & Record<string, any>;
  return typeof t.unreadCount === "number" ? t.unreadCount : t.unread ? 1 : 0;
};

const pillClass = (active: boolean) =>
  `inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium ${focusRing} ${
    active ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
  }`;

declare global {
  interface Window {
    google?: any;
  }
}

/* ---------- auth ---------- */

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <h1 className="mb-8 flex items-center gap-3 text-2xl font-semibold tracking-tight text-slate-900">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-white">
          <Icon d={I.mail} className="h-5 w-5" />
        </span>
        AI Stock VN Mail
      </h1>
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <input {...props} aria-label={label} className={inputClass} />
    </label>
  );
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

function Login({ config, onDone }: { config: Config; onDone: () => void }) {
  const btn = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp" | "forgot">("signIn");
  const [signInError, setSignInError] = useState("");
  const [signUpError, setSignUpError] = useState("");
  const [signUpDone, setSignUpDone] = useState(false);
  const [forgotError, setForgotError] = useState("");
  const [forgotSuccess, setForgotSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailSignIn, setEmailSignIn] = useState("");
  const [passwordSignIn, setPasswordSignIn] = useState("");
  const [emailSignUp, setEmailSignUp] = useState("");
  const [passwordSignUp, setPasswordSignUp] = useState("");
  const [passwordSignUpConfirm, setPasswordSignUpConfirm] = useState("");
  const [emailForgot, setEmailForgot] = useState("");
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaEmail, setMfaEmail] = useState("");

  useEffect(() => {
    if (!config.googleClientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        auto_select: false,
        callback: async (r: { credential: string }) => {
          try {
            const res = await api.loginGoogle(r.credential);
            if (res.mfaRequired) {
              setMfaEmail(res.email);
              setMfaPending(true);
            } else {
              onDone();
            }
          } catch (e) {
            setError((e as Error).message);
          }
        },
        ux_mode: "popup",
      });
      const width = Math.min(400, Math.max(200, btn.current?.clientWidth ?? 320));
      window.google.accounts.id.renderButton(btn.current, {
        theme: "outline",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        logo_alignment: "left",
        width,
        locale: "en",
      });
    };
    s.onerror = () => setError("Failed to load Google Sign-In");
    document.head.appendChild(s);
    return () => s.remove();
  }, [config.googleClientId, onDone]);

  const handleSignIn = async () => {
    setSignInError("");
    setSignUpDone(false);
    setIsSubmitting(true);
    try {
      const res = await api.loginPassword(emailSignIn, passwordSignIn);
      setIsSubmitting(false);
      if (res.mfaRequired) {
        setMfaEmail(res.email);
        setMfaPending(true);
      } else {
        onDone();
      }
    } catch (e) {
      setSignInError(errorText(e));
      setIsSubmitting(false);
    }
  };

  const handleSignUp = async () => {
    setSignUpError("");
    setIsSubmitting(true);
    try {
      await api.signup(emailSignUp, passwordSignUp);
      setIsSubmitting(false);
      setSignUpDone(true);
      setMode("signIn");
    } catch (e) {
      setSignUpError(errorText(e));
      setIsSubmitting(false);
    }
  };

  const handleForgot = async () => {
    setForgotError("");
    setIsSubmitting(true);
    try {
      await api.forgotPassword(emailForgot);
      setForgotSuccess(true);
      setIsSubmitting(false);
      setTimeout(() => {
        setForgotSuccess(false);
        setEmailForgot("");
        setMode("signIn");
      }, 3000);
    } catch (e) {
      setForgotError(errorText(e));
      setIsSubmitting(false);
    }
  };

  const submit = (fn: () => void) => (e: FormEvent) => {
    e.preventDefault();
    fn();
  };

  const tabClass = (active: boolean) =>
    `h-9 rounded-md text-sm font-medium ${focusRing} ${active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"}`;

  return (
    <AuthShell>
      <div className="flex flex-col gap-4">
        {mfaPending ? (
          <MfaChallengeForm
            email={mfaEmail}
            onDone={onDone}
            onCancel={() => {
              setMfaPending(false);
              setMfaEmail("");
            }}
          />
        ) : (
          <>
        {config.googleClientId ? (
          <div ref={btn} className="flex min-h-10 w-full justify-center" />
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Google Client ID is not configured, so Google sign-in is unavailable.</p>
        )}
        {config.devLogin && (
          <button
            type="button"
            onClick={() => api.loginDev().then(onDone, (e) => setError(e.message))}
            className={`h-11 w-full rounded-lg border border-dashed border-slate-400 text-sm text-slate-600 hover:bg-slate-50 ${focusRing}`}
          >
            Sign in to the demo (local/preview only)
          </button>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 text-xs font-medium tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          OR
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        {mode !== "forgot" && (
          <div role="tablist" aria-label="Authentication" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button type="button" role="tab" aria-selected={mode === "signIn"} onClick={() => setMode("signIn")} className={tabClass(mode === "signIn")}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === "signUp"} onClick={() => setMode("signUp")} className={tabClass(mode === "signUp")}>
              Sign up
            </button>
          </div>
        )}

        {mode === "signIn" && (
          <form onSubmit={submit(handleSignIn)} className="flex flex-col gap-3">
            <Field label="Email address" type="email" autoComplete="username" value={emailSignIn} onChange={(e) => setEmailSignIn(e.target.value)} placeholder="Email address" required />
            <Field label="Password" type="password" autoComplete="current-password" value={passwordSignIn} onChange={(e) => setPasswordSignIn(e.target.value)} placeholder="Password" required />
            {signUpDone && (
              <p role="status" className="text-sm text-emerald-700">
                Account created. Please sign in.
              </p>
            )}
            {signInError && (
              <p role="alert" className="text-sm text-rose-600">
                {signInError}
              </p>
            )}
            <button type="submit" disabled={isSubmitting} className={primaryButton}>
              {isSubmitting ? "Signing in..." : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => setMode("forgot")}
              className={`self-center rounded text-sm font-medium text-teal-700 hover:underline ${focusRing}`}
            >
              Forgot password?
            </button>
          </form>
        )}

        {mode === "signUp" && (
          <form onSubmit={submit(handleSignUp)} className="flex flex-col gap-3">
            <Field label="Email address" type="email" autoComplete="email" value={emailSignUp} onChange={(e) => setEmailSignUp(e.target.value)} placeholder="Email address" required />
            <Field label="Password" type="password" autoComplete="new-password" value={passwordSignUp} onChange={(e) => setPasswordSignUp(e.target.value)} placeholder="Password" required />
            <Field
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={passwordSignUpConfirm}
              onChange={(e) => setPasswordSignUpConfirm(e.target.value)}
              placeholder="Confirm password"
              required
            />
            {signUpError && (
              <p role="alert" className="text-sm text-rose-600">
                {signUpError}
              </p>
            )}
            <button type="submit" disabled={isSubmitting} className={primaryButton}>
              {isSubmitting ? "Signing up..." : "Sign up"}
            </button>
          </form>
        )}

        {mode === "forgot" && (
          <form onSubmit={submit(handleForgot)} className="flex flex-col gap-3">
            <h2 className="text-center text-base font-semibold text-slate-900">Reset password</h2>
            <Field label="Email address" type="email" autoComplete="email" value={emailForgot} onChange={(e) => setEmailForgot(e.target.value)} placeholder="Email address" required />
            {forgotError && (
              <p role="alert" className="text-sm text-rose-600">
                {forgotError}
              </p>
            )}
            {forgotSuccess && (
              <p role="status" className="text-sm text-emerald-700">
                Please check your email for the password reset link.
              </p>
            )}
            <button type="submit" disabled={isSubmitting} className={primaryButton}>
              {isSubmitting ? "Sending..." : "Send reset link"}
            </button>
            <button type="button" onClick={() => setMode("signIn")} className={`self-center rounded text-sm font-medium text-teal-700 hover:underline ${focusRing}`}>
              Back to sign in
            </button>
          </form>
        )}
          </>
        )}
      </div>
    </AuthShell>
  );
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("Password and confirmation do not match");
      return;
    }
    api.resetPassword(token, password).then(onDone, (err: unknown) => setError(err instanceof ApiError ? err.message : "Password reset failed"));
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 className="text-center text-base font-semibold text-slate-900">Reset password</h2>
        <Field label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" required />
        <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" required />
        {error && (
          <p role="alert" className="text-sm text-rose-600">
            {error}
          </p>
        )}
        <button type="submit" className={primaryButton}>
          Reset password
        </button>
      </form>
    </AuthShell>
  );
}

/* ---------- message list ---------- */

function MailList({
  folder,
  selectedId,
  selectedThreadKey,
  readState,
  starState,
  refreshCounts,
  onReadChange,
  onStarChange,
  onOpenThread,
  unreadOnly,
  account,
  onOpenMenu,
}: {
  folder: Folder;
  selectedId?: string;
  selectedThreadKey?: string | null;
  readState: Record<string, boolean>;
  starState: Record<string, boolean>;
  refreshCounts: () => void;
  onReadChange: (id: string, read: boolean) => void;
  onStarChange: (id: string, starred: boolean) => void;
  onOpenThread: (threadKey: string) => void;
  unreadOnly: boolean;
  account: string;
  onOpenMenu: () => void;
}) {
  const [items, setItems] = useState<MessageItem[] | null>(null);
  const [threads, setThreads] = useState<ThreadItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"focused" | "other">("focused");
  const [threadMode, setThreadMode] = useState<ThreadMode>("list");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const isThreads = folder === "inbox" && threadMode === "threads";

  const load = useCallback(async () => {
    const req = ++latest.current;
    setError("");
    setRefreshing(true);
    try {
      if (isThreads) {
        const res = await fetchThreads(folder);
        if (req !== latest.current) return;
        setThreads(res.threads);
        setNext(null);
        refreshCounts();
      } else {
        const r = query.trim()
          ? await searchMessages(query.trim(), folder)
          : await api.list(folder, undefined, undefined, folder === "inbox" ? tab : undefined);
        if (req !== latest.current) return;
        setItems(r.items);
        setNext("nextBefore" in r ? r.nextBefore : null);
        refreshCounts();
      }
    } catch (e) {
      if (req !== latest.current) return;
      setError((e as Error).message);
      if (isThreads) setThreads([]);
      else setItems([]);
    } finally {
      if (req === latest.current) setRefreshing(false);
    }
  }, [folder, query, tab, isThreads, refreshCounts]);

  const visibleItems = useMemo(
    () => (items && unreadOnly ? items.filter((m) => !(readState[m.id] ?? m.isRead)) : items),
    [items, unreadOnly, readState],
  );
  const visibleThreads = useMemo(
    () => (threads && unreadOnly ? threads.filter((t) => threadUnreadCount(t) > 0) : threads),
    [threads, unreadOnly],
  );

  const pageIds: string[] = useMemo(
    () =>
      isThreads
        ? (visibleThreads ?? []).flatMap((t) => t.ids ?? (t.latestId ? [t.latestId] : []))
        : (visibleItems ?? []).map((m) => m.id),
    [isThreads, visibleThreads, visibleItems],
  );

  const handleBatch = useCallback(
    async (ids: string[], action: BatchAction) => {
      const res = await batchMessages(ids, action);
      if (action === "read" || action === "unread") {
        for (const id of ids) onReadChange(id, action === "read");
      }
      if (action === "star" || action === "unstar") {
        for (const id of ids) onStarChange(id, action === "star");
      }
      return res;
    },
    [onReadChange, onStarChange],
  );

  const {
    selected,
    batchBusy,
    allSelected,
    clearSelection,
    toggleSelect,
    toggleSelectMany,
    toggleSelectAll,
    runBatch,
  } = useBatchSelection({
    pageIds,
    onNotice: setNotice,
    onBatch: handleBatch,
    onAfterBatch: load,
  });

  useEffect(() => {
    clearSelection();
    if (isThreads) setThreads(null);
    else setItems(null);
    load();
  }, [load, isThreads, clearSelection]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const more = async () => {
    if (!next || isThreads) return;
    setLoadingMore(true);
    try {
      const r = await api.list(folder, query, next, folder === "inbox" ? tab : undefined);
      setItems((cur) => [...(cur || []), ...r.items]);
      setNext(r.nextBefore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleStar = async (msg: MessageItem) => {
    const current = starState[msg.id] ?? Boolean((msg as MessageItem & { isStarred?: boolean }).isStarred);
    try {
      const res = await setStarred(msg.id, !current);
      const nextVal = res.is_starred;
      onStarChange(msg.id, nextVal);
      setItems((prev) => (prev ? prev.map((m) => (m.id === msg.id ? { ...m, isStarred: nextVal } : m)) : prev));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Failed to update star");
    }
  };

  const toggleThreadStar = async (thread: ThreadItem) => {
    const ids = thread.ids ?? (thread.latestId ? [thread.latestId] : []);
    if (ids.length === 0) return;
    const target = !thread.starred;
    try {
      let updated = 0;
      for (const id of ids) {
        await setStarred(id, target);
        onStarChange(id, target);
        updated += 1;
      }
      setThreads((prev) =>
        prev ? prev.map((t) => (t.threadKey === thread.threadKey ? { ...t, starred: target } : t)) : prev,
      );
      setNotice(`${updated} message${updated === 1 ? "" : "s"} updated.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Failed to update star");
    }
  };

  const title = folder === "inbox" ? "Inbox" : folder === "sent" ? "Sent" : "Spam";

  return (
    <>
      <header className="shrink-0 border-b border-slate-200">
        <TopBar title={title} account={account} onOpenMenu={onOpenMenu}>
          <IconButton icon={I.search} label="Search" onClick={() => setSearchOpen((v) => !v)} className="md:hidden" />
          <IconButton icon={I.refresh} label="Refresh" onClick={load} spinning={refreshing} />
        </TopBar>
        <label
          className={`${searchOpen || input ? "flex" : "hidden md:flex"} mx-4 mb-3 h-10 items-center gap-2 rounded-full bg-slate-100 px-4 focus-within:ring-2 focus-within:ring-teal-600`}
        >
          <Icon d={I.search} className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            ref={searchRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Search in ${title.toLowerCase()}`}
            aria-label={`Search in ${title.toLowerCase()}`}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-500"
          />
          {input && (
            <button type="button" aria-label="Clear search" onClick={() => setInput("")} className="rounded text-slate-500 hover:text-slate-900">
              <Icon d={I.close} className="h-4 w-4" />
            </button>
          )}
        </label>
      </header>

      {folder === "inbox" && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-slate-200 px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div role="tablist" aria-label="Inbox view" className="flex shrink-0 gap-2">
            <button type="button" role="tab" aria-selected={tab === "focused"} onClick={() => setTab("focused")} className={pillClass(tab === "focused")}>
              <Icon d={I.inbox} className="h-4 w-4" />
              Focused
            </button>
            <button type="button" role="tab" aria-selected={tab === "other"} onClick={() => setTab("other")} className={pillClass(tab === "other")}>
              <Icon d={I.mail} className="h-4 w-4" />
              Other
            </button>
          </div>
          <span aria-hidden className="h-5 w-px shrink-0 bg-slate-200" />
          <div role="group" aria-label="Display mode" className="flex shrink-0 gap-2">
            <button type="button" aria-pressed={threadMode === "list"} onClick={() => setThreadMode("list")} className={pillClass(threadMode === "list")}>
              <Icon d={I.list} className="h-4 w-4" />
              List
            </button>
            <button type="button" aria-pressed={threadMode === "threads"} onClick={() => setThreadMode("threads")} className={pillClass(threadMode === "threads")}>
              <Icon d={I.threads} className="h-4 w-4" />
              Threads
            </button>
          </div>
        </div>
      )}

      {pageIds.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-1.5 text-xs text-slate-600">
          <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-slate-700">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              aria-label="Select all on this page"
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
            />
            <span>Select all on this page</span>
          </label>
          {selected.size > 0 && <span className="font-medium text-teal-700">{selected.size} selected</span>}
        </div>
      )}

      <BatchBar
        selectedCount={selected.size}
        disabled={batchBusy}
        onAction={(action: BatchAction) => void runBatch(action)}
        onClear={clearSelection}
      />

      {notice && (
        <div role="status" className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice" className="font-semibold text-amber-800 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
        {error && <ErrorBox message={error} onRetry={load} />}
        {isThreads ? (
          visibleThreads === null ? (
            <Spinner />
          ) : visibleThreads.length === 0 && !error ? (
            <div className="flex flex-col items-center gap-2 px-8 py-16 text-center text-slate-500">
              <Icon d={I.inbox} className="h-10 w-10 text-slate-300" />
              <p className="font-medium text-slate-700">{unreadOnly ? "No unread threads" : "No threads"}</p>
              <p className="text-sm">Grouped conversations in your inbox will appear here.</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {visibleThreads.map((thread) => {
                const t = thread as ThreadItem & Record<string, any>;
                const ids = thread.ids ?? (thread.latestId ? [thread.latestId] : []);
                const allInThread = ids.length > 0 && ids.every((id) => selected.has(id));
                const isActive = selectedThreadKey === thread.threadKey;
                const count = typeof t.count === "number" ? t.count : typeof t.messageCount === "number" ? t.messageCount : ids.length;
                const unreadCount = threadUnreadCount(thread);
                const bold = unreadCount > 0;
                const fromLabel =
                  typeof t.from === "string"
                    ? t.from
                    : t.from?.name || t.from?.address || (Array.isArray(t.participants) ? t.participants.map((p: any) => (typeof p === "string" ? p : displayName(p))).join(", ") : "Thread");
                const ts = typeof t.latestDate === "number" ? t.latestDate : typeof t.date === "number" ? t.date : Date.now();
                return (
                  <SelectableMailRow
                    key={thread.threadKey}
                    highlighted={isActive || allInThread}
                    checked={allInThread}
                    onToggleSelect={() => toggleSelectMany(ids)}
                    selectAriaLabel={`Select thread ${t.subject || "(No subject)"}`}
                    starred={!!thread.starred}
                    starLabel={thread.starred ? "Unstar thread" : "Star thread"}
                    onToggleStar={() => void toggleThreadStar(thread)}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenThread(thread.threadKey)}
                      className={`flex min-w-0 flex-1 gap-3 rounded text-left ${focusRing}`}
                    >
                      <Avatar label={fromLabel} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm ${bold ? "font-bold text-slate-900" : "text-slate-600"}`}>{fromLabel}</span>
                          {count > 1 && (
                            <span className="shrink-0 rounded border border-slate-300 px-1 text-xs font-semibold text-slate-600">{count}</span>
                          )}
                          <span className={`shrink-0 text-xs ${bold ? "font-bold text-teal-700" : "text-slate-500"}`}>{formatDate(ts)}</span>
                        </div>
                        <div className={`truncate text-sm ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}>{t.subject || "(No subject)"}</div>
                        <div className="truncate text-sm text-slate-500">{t.snippet || ""}</div>
                      </div>
                    </button>
                  </SelectableMailRow>
                );
              })}
            </ul>
          )
        ) : visibleItems === null ? (
          <Spinner />
        ) : visibleItems.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-2 px-8 py-16 text-center text-slate-500">
            <Icon d={folder === "inbox" ? I.inbox : folder === "sent" ? I.send : I.shield} className="h-10 w-10 text-slate-300" />
            <p className="font-medium text-slate-700">
              {unreadOnly
                ? "No unread mail"
                : query
                  ? "No matching email"
                  : folder === "inbox"
                    ? tab === "focused"
                      ? "No focused mail"
                      : "No other mail"
                    : folder === "sent"
                      ? "No sent mail"
                      : "No spam mail"}
            </p>
            <p className="text-sm">
              {unreadOnly
                ? "Turn off the Unread filter to see all loaded mail."
                : query
                  ? "Try a different search."
                  : folder === "inbox"
                    ? tab === "focused"
                      ? "Mail from people you know or replies to your mail will appear here."
                      : "Other mail will appear here."
                    : folder === "sent"
                      ? "Messages you send will appear here."
                      : "Mail flagged as spam will appear here."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleItems.map((m) => {
              const who = folder === "sent" ? `To: ${m.to.map(displayName).join(", ")}` : displayName(m.from);
              const isRead = readState[m.id] ?? m.isRead;
              const isStarred = starState[m.id] ?? Boolean((m as MessageItem & { isStarred?: boolean }).isStarred);
              const bold = folder === "inbox" && !isRead;
              const isOpen = m.id === selectedId;
              const isChecked = selected.has(m.id);
              return (
                <SelectableMailRow
                  key={m.id}
                  highlighted={isOpen || isChecked}
                  checked={isChecked}
                  onToggleSelect={() => toggleSelect(m.id)}
                  selectAriaLabel={`Select message from ${who}`}
                  starred={isStarred}
                  starLabel={isStarred ? "Unstar message" : "Star message"}
                  onToggleStar={() => void toggleStar(m)}
                >
                  <MessageRowContent
                    id={m.shortCode || m.id}
                    isOpen={isOpen}
                    avatarLabel={folder === "sent" ? displayName(m.to[0]) : displayName(m.from)}
                    who={who}
                    date={m.date}
                    subject={m.subject}
                    snippet={m.snippet}
                    hasAttachments={m.hasAttachments}
                    bold={bold}
                    onOpen={(id) => go(`/m/${id}`)}
                  />
                </SelectableMailRow>
              );
            })}
          </ul>
        )}
        {!isThreads && next && (
          <button
            onClick={more}
            disabled={loadingMore}
            className={`mx-auto my-4 block rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:text-slate-400 ${focusRing}`}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </>
  );
}

/* ---------- starred & drafts views ---------- */

function StarredView({
  selectedId,
  readState,
  starState,
  onStarChange,
  account,
  onOpenMenu,
}: {
  account: string;
  onOpenMenu: () => void;
  selectedId?: string;
  readState: Record<string, boolean>;
  starState: Record<string, boolean>;
  onStarChange: (id: string, starred: boolean) => void;
}) {
  const [items, setItems] = useState<MessageItem[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setRefreshing(true);
    try {
      const res: any = await fetchStarred();
      const list: MessageItem[] = Array.isArray(res) ? res : (res?.items ?? []);
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load starred messages");
      setItems([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStar = async (msg: MessageItem) => {
    try {
      const res = await setStarred(msg.id, false);
      onStarChange(msg.id, res.is_starred);
      if (!res.is_starred) {
        setItems((prev) => (prev ? prev.filter((m) => m.id !== msg.id) : prev));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update star");
    }
  };

  const visibleItems = items ? items.filter((m) => starState[m.id] ?? true) : null;

  return (
    <>
      <header className="shrink-0 border-b border-slate-200">
        <TopBar title="Starred" account={account} onOpenMenu={onOpenMenu}>
          <IconButton icon={I.refresh} label="Refresh" onClick={() => void load()} spinning={refreshing} />
        </TopBar>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
        {error && <ErrorBox message={error} onRetry={() => void load()} />}
        {visibleItems === null ? (
          <Spinner />
        ) : visibleItems.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-2 px-8 py-16 text-center text-slate-500">
            <Icon d={I.star} className="h-10 w-10 text-slate-300" />
            <p className="font-medium text-slate-700">No starred messages</p>
            <p className="text-sm">Star important messages to find them quickly here.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleItems.map((m) => {
              const isSent = (m as MessageItem & { folder?: Folder }).folder === "sent";
              const who = isSent ? `To: ${m.to.map(displayName).join(", ")}` : displayName(m.from);
              const isRead = readState[m.id] ?? m.isRead;
              const bold = !isSent && !isRead;
              const isOpen = m.id === selectedId;
              return (
                <li key={m.id} className={`flex items-start gap-3 px-4 py-3 ${isOpen ? "bg-teal-50" : "hover:bg-slate-50"}`}>
                  <MessageRowContent
                    id={m.shortCode || m.id}
                    avatarLabel={isSent ? displayName(m.to[0]) : displayName(m.from)}
                    who={who}
                    date={m.date}
                    subject={m.subject}
                    snippet={m.snippet}
                    hasAttachments={m.hasAttachments}
                    bold={bold}
                    isOpen={isOpen}
                    onOpen={(id) => go(`/m/${id}`)}
                  />
                  <button
                    type="button"
                    aria-label="Unstar message"
                    title="Unstar message"
                    onClick={() => void toggleStar(m)}
                    className={`mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-200/60 ${focusRing}`}
                  >
                    <StarIcon filled={true} className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function DraftsPane() {
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res: any = await fetchDrafts();
      const list: DraftItem[] = Array.isArray(res) ? res : (res?.drafts ?? res?.items ?? []);
      setDrafts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (id: string) => {
    await deleteDraftApi(id);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  };

  return (
    <DraftsView
      drafts={drafts}
      loading={loading}
      error={error}
      onOpenDraft={(draft) => go(`/compose?draft=${draft.id}`)}
      onDeleteDraft={handleDelete}
      onRefresh={() => void load()}
    />
  );
}

/* ---------- reading pane ---------- */

function ReadingPane({
  id,
  refreshCounts,
  onClose,
  onReadChange,
  onStarChange,
  onFolder,
}: {
  id: string;
  refreshCounts: () => void;
  onClose: () => void;
  onReadChange: (id: string, read: boolean) => void;
  onStarChange: (id: string, starred: boolean) => void;
  onFolder: (folder: Folder) => void;
}) {
  const [m, setM] = useState<MessageDetail | null>(null);
  const [starred, setStarredState] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const load = useCallback(() => {
    setError("");
    setSummary(null);
    setSummaryLoading(false);
    api.get(id).then(
      (d) => {
        setM(d);
        setStarredState(Boolean((d as MessageDetail & { isStarred?: boolean }).isStarred));
        onFolder(d.folder);
        if (d.folder !== "inbox") {
          refreshCounts();
          return;
        }
        const done = () => {
          onReadChange(id, true);
          refreshCounts();
        };
        if (d.isRead) done();
        else api.markRead(id, true).then(done, () => refreshCounts());
      },
      (e) => setError(e.message),
    );
  }, [id, refreshCounts, onReadChange, onFolder]);
  useEffect(load, [load]);

  const markUnread = () => {
    setActionError("");
    api.markRead(id, false).then(
      () => {
        onReadChange(id, false);
        refreshCounts();
        onClose();
      },
      (e) => setActionError(e.message),
    );
  };

  const toggleStar = () => {
    if (!m) return;
    setActionError("");
    const next = !starred;
    setStarred(m.id, next).then(
      (res) => {
        setStarredState(res.is_starred);
        onStarChange(m.id, res.is_starred);
      },
      (e) => setActionError(e instanceof ApiError ? e.message : "Failed to update star"),
    );
  };

  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        <IconButton icon={I.back} label="Back to list" onClick={onClose} className="md:hidden" />
        <div className="flex-1" />
        {m && (
          <>
            <button
              type="button"
              aria-label={starred ? "Unstar message" : "Star message"}
              title={starred ? "Unstar message" : "Star message"}
              onClick={toggleStar}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 ${focusRing}`}
            >
              <StarIcon filled={starred} className="h-5 w-5" />
            </button>
            {m.folder === "inbox" && (
              <>
                <a href={`/compose?reply=${m.id}`} onClick={spaLinkClick(`/compose?reply=${m.id}`)} className={outlineButton}>
                  <Icon d={I.reply} className="h-4 w-4" /> Reply
                </a>
                <a href="#" className={summaryLoading ? "border-slate-300 bg-white text-slate-800" : outlineButton} onClick={e => {
                  e.preventDefault();
                  setSummaryLoading(true);
                  api.summary(m.id).then(
                    (d) => { setSummary(d.summary); setSummaryLoading(false); },
                    (e) => { setActionError(e instanceof ApiError ? e.message : "Something went wrong"); setSummaryLoading(false); }
                  );
                }}>
                  {summaryLoading ? "Summarizing…" : "Summarize"}
                </a>
                <a href="#" className={summaryLoading ? "border-slate-300 bg-white text-slate-800" : outlineButton} onClick={e => {
                  e.preventDefault();
                  setSummaryLoading(true);
                  api.draftReply(m.id).then(
                    (d) => { sessionStorage.setItem(`ai-draft:${m.id}`, d.draft); go(`/compose?reply=${m.id}`); setSummaryLoading(false); },
                    (e) => { setActionError(e instanceof ApiError ? e.message : "Something went wrong"); setSummaryLoading(false); }
                  );
                }}>
                  {summaryLoading ? "Drafting…" : "Draft reply"}
                </a>
              </>
            )}
            <a href={`/compose?forward=${m.id}`} onClick={spaLinkClick(`/compose?forward=${m.id}`)} className={outlineButton} >
              <Icon d={I.forward} className="h-4 w-4" /> Forward
            </a>
            {m.folder === "inbox" && <IconButton icon={I.unread} label="Mark as unread" onClick={markUnread} />}
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <ErrorBox message={error} onRetry={load} />}
        {actionError && <ErrorBox message={actionError} />}
        {!m && !error && <Spinner />}
        {m && (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
            <h2 className="text-xl leading-snug font-semibold text-balance text-slate-900 lg:text-2xl">{m.subject || "(No subject)"}</h2>
            <div className="flex gap-3">
              <Avatar label={displayName(m.from)} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 truncate font-semibold text-slate-900">{displayName(m.from)}</span>
                  <span className="shrink-0 text-xs text-slate-500">{formatDate(m.date, true)}</span>
                </div>
                {m.from.name && <div className="truncate text-slate-500">{m.from.address}</div>}
                <div className="truncate text-slate-500">to {addrLine(m.to) || "(unknown)"}</div>
                {m.cc.length > 0 && <div className="truncate text-slate-500">cc {addrLine(m.cc)}</div>}
              </div>
            </div>
            {summary && (
              <div className="rounded-lg border border-slate-300 bg-slate-100 p-4 mb-4">
                <h3 className="font-semibold text-slate-900 text-sm mb-2">Summary</h3>
                <p className="text-slate-700 break-words whitespace-pre-wrap">{summary}</p>
                <button
                  onClick={() => setSummary(null)}
                  className="mt-2 text-sm text-teal-600 hover:underline"
                >
                  Hide
                </button>
              </div>
            )}
            <MailBody html={m.html} text={m.text} />
            {m.attachments.length > 0 && (
              <section className="flex flex-col gap-2 border-t border-slate-200 pt-4" aria-label="Attachments">
                <p className="text-sm font-semibold text-slate-600">
                  {m.attachments.length} {m.attachments.length === 1 ? "attachment" : "attachments"}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {m.attachments.map((a) => (
                    <a
                      key={a.index}
                      href={`/api/messages/${m.id}/attachments/${a.index}`}
                      className={`flex items-center gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50 ${focusRing}`}
                    >
                      <Icon d={I.clip} className="h-5 w-5 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{a.filename}</span>
                        <span className="text-xs text-slate-500">{formatSize(a.size)}</span>
                      </span>
                      <Icon d={I.download} className="h-5 w-5 shrink-0 text-teal-700" />
                    </a>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function ThreadReadingPane({
  threadKey,
  onClose,
  refreshCounts,
  onReadChange,
  onStarChange,
}: {
  threadKey: string;
  onClose: () => void;
  refreshCounts: () => void;
  onReadChange: (id: string, read: boolean) => void;
  onStarChange: (id: string, starred: boolean) => void;
}) {
  const [messages, setMessages] = useState<(MessageItem & Record<string, any>)[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    fetchThread(threadKey).then(
      (res) => {
        const list = (res.messages ?? []) as (MessageItem & Record<string, any>)[];
        setMessages(list);
        for (const msg of list) {
          if (!msg.isRead) {
            void markMessageRead(msg.id, true)
              .then(() => {
                onReadChange(msg.id, true);
                refreshCounts();
              })
              .catch(() => {});
          }
        }
      },
      (e) => setError(e instanceof Error ? e.message : "Failed to load thread"),
    );
  }, [threadKey, onReadChange, refreshCounts]);

  useEffect(load, [load]);

  const toggleStar = async (msg: MessageItem & Record<string, any>) => {
    const next = !msg.isStarred;
    try {
      const res = await setStarred(msg.id, next);
      onStarChange(msg.id, res.is_starred);
      setMessages((prev) => (prev ? prev.map((x) => (x.id === msg.id ? { ...x, isStarred: res.is_starred } : x)) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update star");
    }
  };

  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        <IconButton icon={I.back} label="Back to list" onClick={onClose} className="md:hidden" />
        <h2 className="flex-1 truncate text-base font-semibold text-slate-900">
          {messages?.[0]?.subject || "Conversation"}
          {messages && messages.length > 1 ? ` (${messages.length})` : ""}
        </h2>
        <IconButton icon={I.close} label="Close thread" onClick={onClose} className="hidden md:inline-flex" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <ErrorBox message={error} onRetry={load} />}
        {!messages && !error && <Spinner />}
        {messages && (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-8">
            {messages.map((m) => (
              <div key={m.id} className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
                <div className="flex items-start gap-3">
                  <Avatar label={displayName(m.from)} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 truncate font-semibold text-slate-900">{displayName(m.from)}</span>
                      <span className="shrink-0 text-xs text-slate-500">{formatDate(m.date, true)}</span>
                    </div>
                    <div className="truncate text-slate-500">to {addrLine(m.to ?? []) || "(unknown)"}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={m.isStarred ? "Unstar message" : "Star message"}
                    onClick={() => void toggleStar(m)}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 ${focusRing}`}
                  >
                    <StarIcon filled={!!m.isStarred} className="h-4 w-4" />
                  </button>
                  <a href={`/compose?reply=${m.id}`} onClick={spaLinkClick(`/compose?reply=${m.id}`)} className={outlineButton}>
                    <Icon d={I.reply} className="h-4 w-4" /> Reply
                  </a>
                </div>
                <MailBody html={m.html ?? null} text={m.text ?? m.snippet ?? ""} />
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/* ---------- compose ---------- */

function quote(m: MessageDetail) {
  const fromAddr = m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address;
  const head = `On ${formatDate(m.date, true)}, ${fromAddr} wrote:`;
  return `\n\n${head}\n${m.text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

function Compose({ replyTo, forward, draftId, config }: { replyTo?: string; forward?: string; draftId?: string; config: Config }) {
  const [attachments, setAttachments] = useState<{ key: string; filename: string; size: number; mimeType: string }[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachmentTotal = attachments.reduce((n, file) => n + file.size, 0);
  const attachmentLimit = 25 * 1024 * 1024;
  // PHASE1-ALIASES-UI
  const [fromAddr, setFromAddr] = useState(config.mailbox);
  const [fromOptions, setFromOptions] = useState<string[]>([config.mailbox]);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sending" | "sent">(replyTo || forward || draftId ? "loading" : "idle");
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const draftIdRef = useRef<string | undefined>(draftId);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientId = useMemo(() => crypto.randomUUID(), []);

  // PHASE1-ALIASES-UI
  useEffect(() => {
    setFromAddr(config.mailbox);
    api.listAliases().then(
      (r) => {
        const enabled = r.aliases.filter((a) => a.enabled).map((a) => a.address);
        setFromOptions([config.mailbox, ...enabled]);
      },
      () => setFromOptions([config.mailbox]),
    );
  }, [config.mailbox]);

  useEffect(() => {
    if (!draftId) return;
    let active = true;
    fetchDraft(draftId).then(
      (res: any) => {
        if (!active) return;
        const d: DraftItem & Record<string, any> = res?.draft ?? res;
        draftIdRef.current = d.id || draftId;
        setTo(d.to || "");
        if (d.cc) {
          setCc(d.cc);
          setShowCc(true);
        }
        setSubject(d.subject || "");
        setText(d.text || "");
        if (d.updatedAt) {
          setSavedAt(d.updatedAt);
          setSaveState("saved");
        }
        setStatus("idle");
      },
      (e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Failed to load draft");
        setStatus("idle");
      },
    );
    return () => {
      active = false;
    };
  }, [draftId]);

  useEffect(() => {
    const src = replyTo || forward;
    if (!src || draftId) return;
    api.get(src).then(
      (m) => {
        if (replyTo) {
          setTo((m.replyTo[0] || m.from).address);
          setSubject(/^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`);
          setText(sessionStorage.getItem(`ai-draft:${replyTo}`) || quote(m)); sessionStorage.removeItem(`ai-draft:${replyTo}`);
        } else {
          setSubject(/^(fwd?|tt):/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`);
          setText(`\n\nForwarded message\nFrom: ${addrLine([m.from])}\nDate: ${formatDate(m.date, true)}\nSubject: ${m.subject}\nTo: ${addrLine(m.to)}\n\n${m.text}`);
        }
        setStatus("idle");
      },
      (e) => {
        setError(e.message);
        setStatus("idle");
      },
    );
  }, [replyTo, forward, draftId]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    if (status !== "idle" || discarding) return;
    if (!to.trim() && !cc.trim() && !subject.trim() && !text.trim()) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        const payload = {
          ...(draftIdRef.current ? { id: draftIdRef.current } : {}),
          to,
          cc,
          subject,
          text,
        } as Parameters<typeof saveDraft>[0];
        const res: any = await saveDraft(payload);
        const saved = res?.draft ?? res;
        if (saved?.id) draftIdRef.current = saved.id;
        setSavedAt(saved?.updatedAt ?? Date.now());
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 2000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [to, cc, subject, text, status, discarding]);

  const markDirty = () => {
    dirtyRef.current = true;
  };

  const discard = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    dirtyRef.current = false;
    setDiscarding(true);
    try {
      if (draftIdRef.current) {
        await deleteDraftApi(draftIdRef.current);
        draftIdRef.current = undefined;
      }
      back("/inbox");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to discard draft");
      setDiscarding(false);
    }
  };

  const send = async () => {
    setError("");
    if (!to.trim()) return setError("Enter a recipient");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    dirtyRef.current = false;
    setStatus("sending");
    try {
      // PHASE1-ALIASES-UI
      await api.send({
        to,
        cc,
        subject,
        text,
        replyToId: replyTo,
        clientId,
        draftId: draftIdRef.current,
        from: fromAddr && fromAddr !== config.mailbox ? fromAddr : undefined,
        ...(attachments.length ? { attachments } : {}),
      });
      setStatus("sent");
      setTimeout(() => go("/sent"), 800);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to send, please check your network and try again");
      setStatus("idle");
    }
  };

  const busy = status === "sending" || status === "loading" || status === "sent" || discarding;
  const field = "h-12 w-full bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400";
  const row = "flex items-center gap-3 px-4 sm:px-6";

  return (
    <div className="flex min-h-full flex-col bg-slate-50 md:p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col bg-white md:flex-none md:rounded-2xl md:border md:border-slate-200 md:shadow-sm">
        <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-3 sm:px-4">
          <IconButton icon={I.close} label="Cancel" onClick={() => back("/inbox")} />
          <h1 className="flex-1 truncate text-lg font-semibold text-slate-900">{replyTo ? "Reply" : forward ? "Forward" : "Compose"}</h1>
          {saveState === "saving" && <span className="text-xs text-slate-500">Saving…</span>}
          {saveState === "saved" && savedAt && <span className="text-xs text-slate-500">Saved {formatHHMM(savedAt)}</span>}
          {saveState === "error" && <span className="text-xs text-rose-600">Save failed</span>}
          <button
            type="button"
            onClick={() => void discard()}
            disabled={busy}
            className={`inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
          >
            {discarding ? "Discarding…" : "Discard"}
          </button>
          <button
            onClick={send}
            disabled={busy || !config.sendingEnabled}
            className={`inline-flex h-10 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300 ${focusRing}`}
          >
            <Icon d={I.send} className="h-4 w-4" />
            {status === "sending" ? "Sending..." : status === "sent" ? "Sent" : "Send"}
          </button>
        </header>
        {!config.sendingEnabled && <ErrorBox message="The server is not configured with a sending key (Resend), so sending is unavailable." />}
        {error && <ErrorBox message={error} />}
        {attachmentError && <ErrorBox message={attachmentError} />}
        {status === "sent" && (
          <p role="status" className="m-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            Message sent.
          </p>
        )}
        <div className="flex flex-1 flex-col divide-y divide-slate-200">
          <label className={`${row} text-slate-500`}>
            <span className="w-10 shrink-0 text-sm">From</span>
            <select aria-label="From" value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} className={field}>
              {fromOptions.map((addr) => (
                <option key={addr} value={addr}>
                  {addr === config.mailbox ? `${config.mailbox} (Main address)` : addr}
                </option>
              ))}
            </select>
          </label>
          <label className={`${row} text-slate-500`}>
            <span className="w-10 shrink-0 text-sm">To</span>
            <input
              type="email"
              multiple
              inputMode="email"
              autoCapitalize="off"
              value={to}
              onChange={(e) => {
                markDirty();
                setTo(e.target.value);
              }}
              className={field}
            />
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)} className={`rounded text-sm font-medium text-teal-700 ${focusRing}`}>
                Cc
              </button>
            )}
          </label>
          {showCc && (
            <label className={`${row} text-slate-500`}>
              <span className="w-10 shrink-0 text-sm">Cc</span>
              <input
                type="email"
                multiple
                inputMode="email"
                autoCapitalize="off"
                value={cc}
                onChange={(e) => {
                  markDirty();
                  setCc(e.target.value);
                }}
                className={field}
              />
            </label>
          )}
          <div className={row}>
            <input
              aria-label="Subject"
              placeholder="Subject"
              value={subject}
              onChange={(e) => {
                markDirty();
                setSubject(e.target.value);
              }}
              className={field}
            />
          </div>
          <div className="flex flex-1 px-4 py-3 sm:px-6">
            <textarea
              aria-label="Message"
              placeholder="Compose"
              value={text}
              onChange={(e) => {
                markDirty();
                setText(e.target.value);
              }}
              className="min-h-96 w-full flex-1 resize-none bg-transparent text-base leading-relaxed text-slate-900 outline-none placeholder:text-slate-400"
              autoFocus={!!(replyTo || forward)}
              onFocus={(e) => replyTo && e.currentTarget.setSelectionRange(0, 0)}
            />
          </div>
          <div className="space-y-2 px-4 py-3 sm:px-6">
            <input ref={attachmentInput} type="file" multiple className="hidden" aria-label="Choose attachments" onChange={async (event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = "";
              setAttachmentError("");
              if (attachmentTotal + files.reduce((n, file) => n + file.size, 0) > attachmentLimit) {
                setAttachmentError("Attachments exceed the 25 MB per email limit.");
                return;
              }
              try {
                const result = await api.uploadAttachments(files);
                setAttachments((current) => [...current, ...result.attachments]);
              } catch (e) {
                setAttachmentError(errorText(e));
              }
            }} />
            <button type="button" onClick={() => attachmentInput.current?.click()} disabled={busy} className={`inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 ${focusRing}`} aria-label="Attach files">
              <span aria-hidden="true">📎</span> Attach files
            </button>
            {attachments.map((file) => <div key={file.key} className="flex items-center gap-3 text-sm text-slate-700">
              <span className="min-w-0 flex-1 truncate">{file.filename}</span><span>{formatSize(file.size)}</span>
              <button type="button" aria-label={`Remove ${file.filename}`} onClick={() => setAttachments((current) => current.filter((item) => item.key !== file.key))} className={`rounded px-2 py-1 text-rose-700 hover:bg-rose-50 ${focusRing}`}>Remove</button>
            </div>)}
            <p className="text-xs text-slate-500">{formatSize(attachmentTotal)} / 25 MB</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 3-pane mail shell ---------- */

const darkFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400";

type NavVariant = "rail" | "drawer";

function NavItem({
  href,
  label,
  icon,
  active = false,
  badge,
  variant,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: string;
  active?: boolean;
  badge?: number;
  variant: NavVariant;
  onNavigate?: () => void;
}) {
  const rail = variant === "rail";
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={`flex items-center rounded-lg py-2.5 text-sm ${
        rail ? "flex-col gap-1 px-2 lg:flex-row lg:gap-3 lg:px-3" : "flex-row gap-3 px-3"
      } ${darkFocus} ${active ? "bg-white/10 font-semibold text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}
    >
      <Icon d={icon} className={`h-5 w-5 shrink-0 ${active ? "text-teal-300" : ""}`} />
      <span className={`flex-1 truncate ${rail ? "hidden lg:inline" : ""}`}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-teal-500 px-1.5 text-xs font-bold text-slate-950">{badge > 99 ? "99+" : badge}</span>
      )}
    </a>
  );
}

function SidebarBody({
  section,
  unread,
  account,
  mailbox,
  role,
  onLogout,
  variant,
  onNavigate,
  onClose,
}: {
  section: NavSection;
  unread: number;
  account: string;
  mailbox: string;
  role?: string;
  onLogout: () => void;
  variant: NavVariant;
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  const rail = variant === "rail";
  const isAdmin = role === "admin" || role === "super_admin";
  const folders = [
    { key: "inbox" as const, href: "/inbox", label: "Inbox", icon: I.inbox },
    { key: "drafts" as const, href: "/drafts", label: "Drafts", icon: I.draft },
    { key: "sent" as const, href: "/sent", label: "Sent", icon: I.send },
    { key: "starred" as const, href: "/starred", label: "Starred", icon: I.star },
    { key: "spam" as const, href: "/spam", label: "Spam", icon: I.shield },
  ];
  const tools = [
    // PHASE1-ALIASES-UI
    { href: "/aliases", label: "Aliases", icon: I.at },
    // PHASE4-R4
    { href: "/notifications", label: "Notifications", icon: I.bell },
    { href: "/security", label: "Security", icon: I.shield },
    // PHASE4-R6
    ...(isAdmin ? [{ href: "/admin", label: "Admin", icon: I.tool }] : []),
    // PHASE4-R7
    { href: "/external", label: "External mail", icon: I.mail },
  ];
  const navPadding = rail ? "px-2 lg:px-3" : "px-3";

  return (
    <>
      <div className={`flex items-center gap-2 ${rail ? "justify-center px-3 py-5 lg:justify-start lg:px-4" : "px-4 py-4"}`}>
        <Brand dark className={rail ? "" : "min-w-0 flex-1"} labelClassName={rail ? "hidden lg:inline" : ""} />
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            title="Close menu"
            onClick={onClose}
            autoFocus
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white ${darkFocus}`}
          >
            <Icon d={I.close} className="h-5 w-5" />
          </button>
        )}
      </div>
      {rail && (
        <div className="flex flex-col px-2 pb-3 lg:px-3">
          <a
            href="/compose"
            onClick={spaLinkClick("/compose")}
            title="Compose"
            aria-label="Compose"
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-teal-600 text-sm font-semibold text-white hover:bg-teal-500 ${darkFocus}`}
          >
            <Icon d={I.pen} className="h-4 w-4" />
            <span className="hidden lg:inline">Compose</span>
          </a>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <nav aria-label="Folders" className={`flex flex-col gap-1 ${navPadding}`}>
          {folders.map((f) => (
            <NavItem
              key={f.key}
              href={f.href}
              label={f.label}
              icon={f.icon}
              active={section === f.key}
              badge={f.key === "inbox" ? unread : undefined}
              variant={variant}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
        <div className="mx-3 h-px shrink-0 bg-white/10" />
        <nav aria-label="Account tools" className={`flex flex-col gap-1 ${navPadding}`}>
          {tools.map((t) => (
            <NavItem key={t.href} href={t.href} label={t.label} icon={t.icon} variant={variant} onNavigate={onNavigate} />
          ))}
        </nav>
      </div>
      <div className={`flex flex-col gap-2 border-t border-white/10 p-3 ${rail ? "items-center lg:items-stretch" : ""}`}>
        <div className="flex items-center gap-3 lg:px-1">
          <Avatar label={account || mailbox} size="sm" />
          <div className={`min-w-0 flex-1 ${rail ? "hidden lg:block" : ""}`}>
            <div className="truncate text-sm font-medium text-white">{account}</div>
            <div className="truncate text-xs text-slate-400">{mailbox}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out"
          className={`inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white ${
            rail ? "justify-center lg:justify-start" : "justify-start"
          } ${darkFocus}`}
        >
          <Icon d={I.logout} className="h-5 w-5" />
          <span className={rail ? "hidden lg:inline" : ""}>Sign out</span>
        </button>
      </div>
    </>
  );
}

function Sidebar({
  section,
  unread,
  account,
  mailbox,
  role,
  onLogout,
  open,
  onClose,
}: {
  section: NavSection;
  unread: number;
  account: string;
  mailbox: string;
  role?: string;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const shared = { section, unread, account, mailbox, role, onLogout };
  return (
    <>
      <aside className="hidden w-16 shrink-0 flex-col border-r border-slate-800 bg-slate-900 md:flex lg:w-60 xl:w-64">
        <SidebarBody {...shared} variant="rail" />
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <aside className="flex w-72 max-w-[85%] flex-col bg-slate-900 shadow-xl">
            <SidebarBody
              {...shared}
              variant="drawer"
              onNavigate={onClose}
              onClose={onClose}
              onLogout={() => {
                onClose();
                onLogout();
              }}
            />
          </aside>
          <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="flex-1 bg-slate-950/50" />
        </div>
      )}
    </>
  );
}

function MailShell({
  section,
  selectedId,
  unread,
  account,
  mailbox,
  role,
  onLogout,
  refreshCounts,
  onFolder,
}: {
  section: NavSection;
  selectedId?: string;
  unread: number;
  account: string;
  mailbox: string;
  role?: string;
  onLogout: () => void;
  refreshCounts: () => void;
  onFolder: (folder: Folder) => void;
}) {
  const [readState, setReadState] = useState<Record<string, boolean>>({});
  const [starState, setStarState] = useState<Record<string, boolean>>({});
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);

  useEffect(() => {
    setUnreadOnly(false);
  }, [section]);

  const onReadChange = useCallback((id: string, read: boolean) => setReadState((cur) => ({ ...cur, [id]: read })), []);
  const onStarChange = useCallback((id: string, starred: boolean) => setStarState((cur) => ({ ...cur, [id]: starred })), []);
  const onClose = useCallback(() => go(sectionPath(section)), [section]);

  useEffect(() => {
    if (selectedId) setSelectedThreadKey(null);
  }, [selectedId]);

  useEffect(() => {
    setSelectedThreadKey(null);
  }, [section]);

  const handleOpenThread = useCallback(
    (threadKey: string) => {
      if (selectedId) go(sectionPath(section));
      setSelectedThreadKey(threadKey);
    },
    [selectedId, section],
  );

  const readingOpen = Boolean(selectedId || selectedThreadKey);
  const hideOnMobileWhenReading = readingOpen ? "hidden" : "flex";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white md:flex-row">
      <Sidebar section={section} unread={unread} account={account} mailbox={mailbox} role={role} onLogout={onLogout} open={menuOpen} onClose={closeMenu} />

      <section
        aria-label="Messages"
        className={`${readingOpen ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col border-slate-200 md:w-72 md:flex-none md:border-r lg:w-80 xl:w-96 2xl:w-112`}
      >
        {section === "drafts" ? (
          <>
            <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-2 md:hidden">
              <IconButton icon={I.menu} label="Open menu" onClick={openMenu} />
              <Brand className="min-w-0 flex-1 px-2" />
              <Avatar label={account} />
            </div>
            <DraftsPane />
          </>
        ) : section === "starred" ? (
          <StarredView
            selectedId={selectedId}
            readState={readState}
            starState={starState}
            onStarChange={onStarChange}
            account={account}
            onOpenMenu={openMenu}
          />
        ) : (
          <MailList
            key={section}
            folder={section}
            unreadOnly={unreadOnly}
            account={account}
            onOpenMenu={openMenu}
            selectedId={selectedId}
            selectedThreadKey={selectedThreadKey}
            readState={readState}
            starState={starState}
            refreshCounts={refreshCounts}
            onReadChange={onReadChange}
            onStarChange={onStarChange}
            onOpenThread={handleOpenThread}
          />
        )}
      </section>

      <section aria-label="Reading pane" className={`${readingOpen ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col bg-white`}>
        {selectedId ? (
          <ReadingPane
            key={selectedId}
            id={selectedId}
            refreshCounts={refreshCounts}
            onClose={onClose}
            onReadChange={onReadChange}
            onStarChange={onStarChange}
            onFolder={onFolder}
          />
        ) : selectedThreadKey ? (
          <ThreadReadingPane
            key={selectedThreadKey}
            threadKey={selectedThreadKey}
            onClose={() => setSelectedThreadKey(null)}
            refreshCounts={refreshCounts}
            onReadChange={onReadChange}
            onStarChange={onStarChange}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
            <Icon d={I.mail} className="h-12 w-12 text-slate-300" />
            <p className="text-sm">Select a message to read</p>
          </div>
        )}
      </section>

      <div className={`${hideOnMobileWhenReading} pointer-events-none fixed inset-x-0 bottom-0 z-30 items-end justify-between gap-3 p-4 md:hidden`}>
        <span aria-hidden className="w-14 shrink-0" />
        {section !== "drafts" && section !== "starred" ? (
          <button
            type="button"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
            className={`pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-semibold shadow-lg ${focusRing} ${
              unreadOnly ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-900"
            }`}
          >
            Unread
            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold ${unreadOnly ? "bg-white text-teal-700" : "bg-teal-600 text-white"}`}>
              {unread > 99 ? "99+" : unread}
            </span>
          </button>
        ) : (
          <span aria-hidden />
        )}
        <a
          href="/compose"
          onClick={spaLinkClick("/compose")}
          aria-label="Compose"
          title="Compose"
          className={`pointer-events-auto inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white shadow-lg hover:bg-teal-700 ${focusRing}`}
        >
          <Icon d={I.pen} className="h-6 w-6" />
        </a>
      </div>
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const route = useRoute();
  const [config, setConfig] = useState<Config | null>(null);
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [role, setRole] = useState<string>("user");
  const [unread, setUnread] = useState(0);
  const [fatal, setFatal] = useState("");
  const [currentSection, setCurrentSection] = useState<NavSection>("inbox");

  const checkSession = useCallback(() => {
    api.session().then(
      (s) => {
        setUser(s.email);
        setRole(s.role || "user");
      },
      (e) => {
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setRole("user");
        } else {
          setFatal(e.message);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (route.name === "list") setCurrentSection(route.folder);
    else if (route.name === "starred") setCurrentSection("starred");
    else if (route.name === "drafts") setCurrentSection("drafts");
  }, [route]);

  useEffect(() => {
    api.config().then(setConfig, (e) => setFatal(e.message));
    checkSession();
  }, [checkSession]);

  const refreshCounts = useCallback(() => {
    api.counts().then((c) => setUnread(c.unread), () => {});
  }, []);

  if (fatal) return <ErrorBox message={`Cannot connect to server: ${fatal}`} onRetry={() => location.reload()} />;
  if (!config || user === undefined) return <FullSpinner />;
  if (!user) return <Login config={config} onDone={checkSession} />;

  if (route.name === "reset" && route.token) {
    return (
      <ResetPassword
        token={route.token}
        onDone={() => {
          setUser(undefined);
          go("/inbox");
        }}
      />
    );
  }

  const logout = () =>
    api.logout().finally(() => {
      setUser(null);
      setRole("user");
    });

  if (route.name === "list" || route.name === "starred" || route.name === "drafts" || route.name === "message") {
    const activeSection: NavSection =
      route.name === "list"
        ? route.folder
        : route.name === "starred"
          ? "starred"
          : route.name === "drafts"
            ? "drafts"
            : currentSection;
    return (
      <MailShell
        section={activeSection}
        selectedId={route.name === "message" ? route.id : undefined}
        unread={unread}
        account={user}
        mailbox={config.mailbox}
        role={role}
        onLogout={logout}
        refreshCounts={refreshCounts}
        onFolder={(f) => {
          if (currentSection !== "starred") setCurrentSection(f);
        }}
      />
    );
  }

  if (route.name === "security") {
    return <MfaSettingsPanel email={user} onBack={() => go("/inbox")} />;
  }

  // PHASE1-ALIASES-UI
  if (route.name === "aliases") {
    return <AliasesPanel onBack={() => go("/inbox")} />;
  }

  // PHASE4-R4
  if (route.name === "notifications") {
    return <NotificationsPanel onBack={() => go("/inbox")} />;
  }

  // PHASE4-R6
  if (route.name === "admin") {
    return <AdminPanel onBack={() => go("/inbox")} />;
  }

  // PHASE4-R7
  if (route.name === "external") {
    return <ExternalMailPanel onBack={() => go("/inbox")} />;
  }

  if (route.name === "compose") {
    return (
      <Compose
        key={`${route.replyTo}-${route.forward}-${route.draftId}`}
        replyTo={route.replyTo}
        forward={route.forward}
        draftId={route.draftId}
        config={config}
      />
    );
  }

  return null;
}
