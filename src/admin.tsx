import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";
const inputClass =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const dangerButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red-300 bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

type SessionInfo = Awaited<ReturnType<typeof api.session>>;
type UserRole = SessionInfo["role"];
type UserStatus = Parameters<typeof api.setUserStatus>[1];
type AdminStats = Awaited<ReturnType<typeof api.getAdminStats>>;
type AdminUser = Awaited<ReturnType<typeof api.listAdminUsers>>[number];
type AdminDomain = Awaited<ReturnType<typeof api.listAdminDomains>>[number];
type AdminAlias = Awaited<ReturnType<typeof api.listAdminAliases>>[number];
type CleanupOptions = Parameters<typeof api.previewMailCleanup>[0];
type CleanupPreview = Awaited<ReturnType<typeof api.previewMailCleanup>>;
type CleanupResult = Awaited<ReturnType<typeof api.runMailCleanup>>;
type ListAuditLogsOptions = NonNullable<Parameters<typeof api.listAuditLogs>[0]>;
type AuditLogEntry = Awaited<ReturnType<typeof api.listAuditLogs>>[number];
type AdminSettings = Awaited<ReturnType<typeof api.getAdminSettings>>;
type UpdateAdminSettingsPayload = Parameters<typeof api.updateAdminSettings>[0];
type BackupRun = Awaited<ReturnType<typeof api.listBackupRuns>>[number];
type BackupObject = Awaited<ReturnType<typeof api.listBackupObjects>>["objects"][number];
type ClientErrorEntry = Awaited<ReturnType<typeof api.listClientErrors>>[number];

type AdminTab = "overview" | "users" | "domains" | "cleanup" | "audit" | "backup" | "logs" | "settings";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "domains", label: "Domains" },
  { id: "cleanup", label: "Cleanup" },
  { id: "audit", label: "Audit" },
  { id: "backup", label: "Backup" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

const ROLES: UserRole[] = ["user", "admin", "super_admin"];
const CLEANUP_FOLDERS = ["trash", "spam", "inbox", "sent"] as const;
const AUDIT_PAGE_SIZE = 50;

const STAT_LABELS: Record<string, string> = {
  users: "Users",
  totalUsers: "Total users",
  total_users: "Total users",
  activeUsers: "Active users",
  active_users: "Active users",
  bannedUsers: "Banned users",
  banned_users: "Banned users",
  total: "Total",
  active: "Active",
  banned: "Banned",
  messages: "Messages",
  totalMessages: "Total messages",
  total_messages: "Total messages",
  messagesByFolder: "Messages by folder",
  messages_by_folder: "Messages by folder",
  byFolder: "Messages by folder",
  by_folder: "Messages by folder",
  folders: "Messages by folder",
  unread: "Unread",
  unreadCount: "Unread",
  unread_count: "Unread",
  inbox: "Inbox",
  sent: "Sent",
  trash: "Trash",
  spam: "Spam",
  drafts: "Drafts",
  domains: "Domains",
  enabledDomains: "Enabled domains",
  enabled_domains: "Enabled domains",
  aliases: "Aliases",
  enabledAliases: "Enabled aliases",
  enabled_aliases: "Enabled aliases",
  enabled: "Enabled",
  disabled: "Disabled",
  notifications: "Notifications",
  push: "Push enabled",
  pushEnabled: "Push enabled",
  push_enabled: "Push enabled",
  pushSubscriptions: "Push subscriptions",
  push_subscriptions: "Push subscriptions",
  telegram: "Telegram enabled",
  telegramEnabled: "Telegram enabled",
  telegram_enabled: "Telegram enabled",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined) {
      return obj[key];
    }
  }
  return undefined;
}

function readString(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  const val = readField(obj, keys);
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return fallback;
}

function readNumber(obj: Record<string, unknown>, keys: string[], fallback = 0): number {
  const val = readField(obj, keys);
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBoolean(obj: Record<string, unknown>, keys: string[], fallback = false): boolean {
  const val = readField(obj, keys);
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const lower = val.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "enabled") return true;
    if (lower === "false" || lower === "0" || lower === "disabled") return false;
  }
  return fallback;
}

function formatDateTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  let date: Date;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    date = new Date(ms);
  } else if (typeof value === "string") {
    const asNum = Number(value);
    if (value.trim() !== "" && Number.isFinite(asNum)) {
      const ms = asNum < 1e12 ? asNum * 1000 : asNum;
      date = new Date(ms);
    } else {
      date = new Date(value);
    }
  } else {
    return "—";
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStatLabel(key: string): string {
  if (STAT_LABELS[key]) return STAT_LABELS[key];
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function formatBytes(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB']; let value=n, i=0;
  while(value>=1024 && i<units.length-1){value/=1024;i++;}
  return `${value.toFixed(1)} ${units[i]}`;
}

interface StatGroup {
  title: string;
  items: { key: string; label: string; value: number }[];
}

function extractStatGroups(stats: AdminStats): StatGroup[] {
  const root = asRecord(stats);
  const topScalars: { key: string; label: string; value: number }[] = [];
  const groups: StatGroup[] = [];

  const collectNested = (title: string, obj: Record<string, unknown>) => {
    const items: { key: string; label: string; value: number }[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        items.push({ key: `${title}.${k}`, label: formatStatLabel(k), value: v });
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        collectNested(formatStatLabel(k), v as Record<string, unknown>);
      }
    }
    if (items.length > 0) {
      groups.push({ title, items });
    }
  };

  for (const [key, value] of Object.entries(root)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      topScalars.push({ key, label: formatStatLabel(key), value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collectNested(formatStatLabel(key), value as Record<string, unknown>);
    }
  }

  const result: StatGroup[] = [];
  if (topScalars.length > 0) {
    result.push({ title: "Overview", items: topScalars });
  }
  result.push(...groups);
  return result;
}

function formatDetail(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseAllowlist(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function AdminPanel({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [session, setSession] = useState<SessionInfo | null>(null);

  // Overview state
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersMessage, setUsersMessage] = useState<string | null>(null);
  const [userBusyEmail, setUserBusyEmail] = useState<string | null>(null);
  const [confirmBanEmail, setConfirmBanEmail] = useState<string | null>(null);

  // Domains & Aliases state
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [aliases, setAliases] = useState<AdminAlias[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainsLoaded, setDomainsLoaded] = useState(false);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [domainsMessage, setDomainsMessage] = useState<string | null>(null);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  const [busyAliasId, setBusyAliasId] = useState<string | null>(null);

  // Cleanup state
  const [cleanupFolder, setCleanupFolder] = useState<string>("trash");
  const [cleanupDays, setCleanupDays] = useState<string>("30");
  const [cleanupMailbox, setCleanupMailbox] = useState<string>("");
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleanupPreviewing, setCleanupPreviewing] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupConfirmDelete, setCleanupConfirmDelete] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  // Audit state
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditFilterInput, setAuditFilterInput] = useState<string>("");
  const [auditActiveFilter, setAuditActiveFilter] = useState<string>("");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Settings state
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [sendDailyCapInput, setSendDailyCapInput] = useState<string>("");
  const [storageQuotaInput, setStorageQuotaInput] = useState<string>("0");
  const [settingsSaving, setSettingsSaving] = useState(false);
  // Backup state
  const [backupRuns, setBackupRuns] = useState<BackupRun[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupLoaded, setBackupLoaded] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupObjects, setBackupObjects] = useState<BackupObject[]>([]);
  const [backupObjectsRunId, setBackupObjectsRunId] = useState<string | null>(null);
  const [backupObjectsLoading, setBackupObjectsLoading] = useState(false);
  const [backupObjectsError, setBackupObjectsError] = useState<string | null>(null);
  const [backupDownloadingKey, setBackupDownloadingKey] = useState<string | null>(null);

  // Backup settings form state (synced from settings in loadSettings)
  const [backupEnabledInput, setBackupEnabledInput] = useState<boolean>(false);
  const [backupRetentionInput, setBackupRetentionInput] = useState<string>("30");
  const [backupSettingsSaving, setBackupSettingsSaving] = useState(false);

  // Logs state
  const [clientErrors, setClientErrors] = useState<ClientErrorEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const isSuperAdmin = session?.role === "super_admin";
  const myEmail = (session?.email ?? "").toLowerCase();

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await api.getAdminStats();
      setStats(res);
    } catch (e) {
      setStatsError(errorText(e));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const unwrapList = <T,>(val: unknown, key: string): T[] => {
    if (Array.isArray(val)) return val as T[];
    if (val && typeof val === 'object') {
      const inner = (val as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as T[];
    }
    return [];
  };

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    setConfirmBanEmail(null);
    try {
      const res = await api.listAdminUsers();
      setUsers(unwrapList<AdminUser>(res, 'users'));
      setUsersLoaded(true);
    } catch (e) {
      setUsersError(errorText(e));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadDomainsAndAliases = useCallback(async () => {
    setDomainsLoading(true);
    setDomainsError(null);
    try {
      const [domainList, aliasList] = await Promise.all([
        api.listAdminDomains(),
        api.listAdminAliases(),
      ]);
      setDomains(unwrapList<AdminDomain>(domainList, 'domains'));
      setAliases(unwrapList<AdminAlias>(aliasList, 'aliases'));
      setDomainsLoaded(true);
    } catch (e) {
      setDomainsError(errorText(e));
    } finally {
      setDomainsLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async (actionFilter: string, append: boolean, offset: number) => {
    if (append) {
      setAuditLoadingMore(true);
    } else {
      setAuditLoading(true);
    }
    setAuditError(null);
    try {
      const trimmed = actionFilter.trim();
      const opts = {
        ...(trimmed ? { action: trimmed } : {}),
        limit: AUDIT_PAGE_SIZE,
        offset,
      } as unknown as ListAuditLogsOptions;
      const rows = await api.listAuditLogs(opts);
      const list = Array.isArray(rows) ? rows : [];
      setAuditLogs((prev) => (append ? [...prev, ...list] : list));
      setAuditHasMore(list.length >= AUDIT_PAGE_SIZE);
      setAuditLoaded(true);
    } catch (e) {
      setAuditError(errorText(e));
    } finally {
      setAuditLoading(false);
      setAuditLoadingMore(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const res = await api.getAdminSettings();
      setSettings(res);
      const rec = asRecord(res);
      const cap = readNumber(rec, ["sendDailyCap", "send_daily_cap"], 0);
      setSendDailyCapInput(String(cap));
      setStorageQuotaInput(String(readNumber(rec, ["storageQuotaMb", "storage_quota_mb"], 0)));
      setBackupEnabledInput(readBoolean(rec, ["backupEnabled", "backup_enabled"], false));
      setBackupRetentionInput(String(readNumber(rec, ["backupRetentionDays", "backup_retention_days"], 30)));
      setSettingsLoaded(true);
    } catch (e) {
      setSettingsError(errorText(e));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const loadBackupRuns = useCallback(async () => {
    setBackupLoading(true);
    setBackupError(null);
    try {
      const rows = await api.listBackupRuns(50);
      setBackupRuns(Array.isArray(rows) ? rows : []);
      setBackupLoaded(true);
    } catch (e) {
      setBackupError(errorText(e));
    } finally {
      setBackupLoading(false);
    }
  }, []);

  const loadClientErrors = useCallback(async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const rows = await api.listClientErrors(50);
      setClientErrors(Array.isArray(rows) ? rows : []);
      setLogsLoaded(true);
    } catch (e) {
      setLogsError(errorText(e));
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const handleRunBackup = useCallback(async () => {
    if (!isSuperAdmin || backupRunning) return;
    setBackupRunning(true);
    setBackupError(null);
    setBackupMessage(null);
    try {
      const run = await api.runBackupNow();
      setBackupRuns((prev) => [run, ...prev]);
      setBackupMessage(`Backup ${run.id} started.`);
      void loadBackupRuns();
    } catch (e) {
      setBackupError(errorText(e));
    } finally {
      setBackupRunning(false);
    }
  }, [isSuperAdmin, backupRunning, loadBackupRuns]);

  const handleLoadBackupObjects = useCallback(async (runId: string) => {
    setBackupObjectsRunId(runId);
    setBackupObjectsLoading(true);
    setBackupObjectsError(null);
    try {
      const res = await api.listBackupObjects(runId);
      setBackupObjects(res.objects ?? []);
    } catch (e) {
      setBackupObjectsError(errorText(e));
    } finally {
      setBackupObjectsLoading(false);
    }
  }, []);

  const handleDownloadBackupObject = useCallback(async (runId: string, key: string) => {
    if (backupDownloadingKey) return;
    setBackupDownloadingKey(key);
    try {
      const blob = await api.downloadBackupObject(runId, key);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = key.split("/").pop() || "backup";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setBackupObjectsError(errorText(e));
    } finally {
      setBackupDownloadingKey(null);
    }
  }, [backupDownloadingKey]);

  const handleSaveBackupSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || backupSettingsSaving) return;
    const retention = Number(backupRetentionInput);
    if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
      setSettingsError("Retention must be between 1 and 365 days.");
      return;
    }
    setBackupSettingsSaving(true);
    setSettingsError(null);
    setSettingsMessage(null);
    try {
      const cap = Number(sendDailyCapInput);
      const updated = await api.updateAdminSettings({
        sendDailyCap: Number.isFinite(cap) ? Math.floor(cap) : 0,
        backupEnabled: backupEnabledInput,
        backupRetentionDays: retention,
      });
      setSettings(updated);
      setSettingsMessage("Backup settings saved.");
    } catch (err) {
      setSettingsError(errorText(err));
    } finally {
      setBackupSettingsSaving(false);
    }
  };

  // Fetch session and overview stats on mount
  useEffect(() => {
    let active = true;
    const init = async () => {
      setStatsLoading(true);
      setStatsError(null);
      const [sessionResult, statsResult] = await Promise.allSettled([
        api.session(),
        api.getAdminStats(),
      ]);
      if (!active) return;

      if (sessionResult.status === "fulfilled") {
        setSession(sessionResult.value);
      }
      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value);
      } else {
        setStatsError(errorText(statsResult.reason));
      }
      setStatsLoading(false);
    };
    void init();
    return () => {
      active = false;
    };
  }, []);

  // Lazy-load tab data when switching tabs
  useEffect(() => {
    if (activeTab === "users" && !usersLoaded && !usersLoading) {
      void loadUsers();
    } else if (activeTab === "domains" && !domainsLoaded && !domainsLoading) {
      void loadDomainsAndAliases();
    } else if (activeTab === "audit" && !auditLoaded && !auditLoading) {
      void loadAudit(auditActiveFilter, false, 0);
    } else if (activeTab === "backup" && !backupLoaded && !backupLoading) {
      void loadBackupRuns();
    } else if (activeTab === "logs" && !logsLoaded && !logsLoading) {
      void loadClientErrors();
      if (!backupLoaded && !backupLoading) void loadBackupRuns();
      if (!auditLoaded && !auditLoading) void loadAudit(auditActiveFilter, false, 0);
    } else if (activeTab === "settings" && !settingsLoaded && !settingsLoading) {
      void loadSettings();
    }
  }, [
    activeTab,
    usersLoaded,
    usersLoading,
    loadUsers,
    domainsLoaded,
    domainsLoading,
    loadDomainsAndAliases,
    auditLoaded,
    auditLoading,
    auditActiveFilter,
    loadAudit,
    backupLoaded,
    backupLoading,
    loadBackupRuns,
    logsLoaded,
    logsLoading,
    loadClientErrors,
    backupLoaded,
    backupLoading,
    loadBackupRuns,
    auditLoaded,
    auditLoading,
    auditActiveFilter,
    loadAudit,
    settingsLoaded,
    settingsLoading,
    loadSettings,
  ]);

  const handleRoleChange = async (email: string, nextRole: UserRole) => {
    if (!isSuperAdmin || userBusyEmail || email.toLowerCase() === myEmail) return;
    setUserBusyEmail(email);
    setUsersError(null);
    setUsersMessage(null);
    try {
      const updated = await api.setUserRole(email, nextRole);
      setUsers((prev) =>
        prev.map((row) => {
          const rec = asRecord(row);
          if (readString(rec, ["email"]).toLowerCase() === email.toLowerCase()) {
            return { ...rec, role: updated.role } as unknown as AdminUser;
          }
          return row;
        }),
      );
      setUsersMessage(`Changed role of ${email} to ${updated.role}.`);
    } catch (e) {
      setUsersError(errorText(e));
    } finally {
      setUserBusyEmail(null);
    }
  };

  const handleBanToggle = async (email: string, currentlyBanned: boolean) => {
    if (userBusyEmail || email.toLowerCase() === myEmail) return;
    if (confirmBanEmail !== email) {
      setConfirmBanEmail(email);
      setUsersError(null);
      setUsersMessage(null);
      return;
    }

    const nextStatus = (currentlyBanned ? "active" : "banned") as UserStatus;
    setUserBusyEmail(email);
    setUsersError(null);
    setUsersMessage(null);
    try {
      const updated = await api.setUserStatus(email, nextStatus);
      setUsers((prev) =>
        prev.map((row) => {
          const rec = asRecord(row);
          if (readString(rec, ["email"]).toLowerCase() === email.toLowerCase()) {
            return { ...rec, status: updated.status } as unknown as AdminUser;
          }
          return row;
        }),
      );
      setConfirmBanEmail(null);
      setUsersMessage(
        currentlyBanned ? `Unbanned user ${email}.` : `Banned user ${email}.`,
      );
    } catch (e) {
      setUsersError(errorText(e));
    } finally {
      setUserBusyEmail(null);
    }
  };

  const handleToggleDomain = async (domainName: string, currentEnabled: boolean) => {
    if (busyDomain) return;
    setBusyDomain(domainName);
    setDomainsError(null);
    setDomainsMessage(null);
    try {
      const updated = await api.toggleDomain(domainName, !currentEnabled);
      setDomains((prev) =>
        prev.map((row) => {
          const rec = asRecord(row);
          if (readString(rec, ["domain"]) === domainName) {
            return { ...rec, enabled: updated.enabled } as unknown as AdminDomain;
          }
          return row;
        }),
      );
      setDomainsMessage(
        `Domain ${domainName} has been ${updated.enabled ? "enabled" : "disabled"}.`,
      );
    } catch (e) {
      setDomainsError(errorText(e));
    } finally {
      setBusyDomain(null);
    }
  };

  const handleToggleAlias = async (aliasId: string, address: string, currentEnabled: boolean) => {
    if (busyAliasId) return;
    setBusyAliasId(aliasId);
    setDomainsError(null);
    setDomainsMessage(null);
    try {
      const updated = await api.toggleAlias(aliasId, !currentEnabled);
      setAliases((prev) =>
        prev.map((row) => {
          const rec = asRecord(row);
          if (readString(rec, ["id"]) === aliasId) {
            return { ...rec, enabled: updated.enabled } as unknown as AdminAlias;
          }
          return row;
        }),
      );
      setDomainsMessage(
        `Alias ${address || aliasId} has been ${updated.enabled ? "enabled" : "disabled"}.`,
      );
    } catch (e) {
      setDomainsError(errorText(e));
    } finally {
      setBusyAliasId(null);
    }
  };

  const buildCleanupOptions = (): CleanupOptions | null => {
    const parsedDays = Number(cleanupDays);
    if (!Number.isFinite(parsedDays) || parsedDays < 0) {
      setCleanupError("Days must be a valid non-negative number.");
      return null;
    }
    const trimmedMailbox = cleanupMailbox.trim();
    const payload: Record<string, unknown> = {
      folder: cleanupFolder,
      olderThanDays: Math.floor(parsedDays),
      days: Math.floor(parsedDays),
    };
    if (trimmedMailbox) {
      payload.mailbox = trimmedMailbox;
    }
    return payload as unknown as CleanupOptions;
  };

  const handlePreviewCleanup = async (e: FormEvent) => {
    e.preventDefault();
    if (cleanupPreviewing || cleanupRunning) return;
    setCleanupError(null);
    setCleanupResult(null);
    setCleanupConfirmDelete(false);
    const opts = buildCleanupOptions();
    if (!opts) return;

    setCleanupPreviewing(true);
    try {
      const res = await api.previewMailCleanup(opts);
      setCleanupPreview(res);
    } catch (err) {
      setCleanupPreview(null);
      setCleanupError(errorText(err));
    } finally {
      setCleanupPreviewing(false);
    }
  };

  const handleRunCleanup = async () => {
    if (cleanupRunning || cleanupPreviewing) return;
    if (!cleanupConfirmDelete) {
      setCleanupConfirmDelete(true);
      return;
    }
    setCleanupError(null);
    const opts = buildCleanupOptions();
    if (!opts) return;

    setCleanupRunning(true);
    try {
      const res = await api.runMailCleanup(opts);
      setCleanupResult(res);
      setCleanupPreview(null);
      setCleanupConfirmDelete(false);
    } catch (err) {
      setCleanupError(errorText(err));
    } finally {
      setCleanupRunning(false);
    }
  };

  const handleAuditFilterSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nextFilter = auditFilterInput.trim();
    setAuditActiveFilter(nextFilter);
    void loadAudit(nextFilter, false, 0);
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || settingsSaving) return;
    const parsed = Number(sendDailyCapInput), quota = Number(storageQuotaInput);
    if (!Number.isInteger(parsed) || parsed < 0 || !Number.isInteger(quota) || quota < 0 || quota > 102400) {
      setSettingsError("Settings must be valid non-negative integers; storage quota must not exceed 102400 MB.");
      return;
    }

    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsMessage(null);
    try {
      const payload = {
        sendDailyCap: parsed, storageQuotaMb: quota,
      } as unknown as UpdateAdminSettingsPayload;
      const updated = await api.updateAdminSettings(payload);
      setSettings(updated);
      const rec = asRecord(updated);
      const cap = readNumber(rec, ["sendDailyCap", "send_daily_cap"], Math.floor(parsed));
      setSendDailyCapInput(String(cap));
      setSettingsMessage("Saved sendDailyCap setting.");
      void loadStats();
    } catch (err) {
      setSettingsError(errorText(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  const statGroups = stats ? extractStatGroups(Object.fromEntries(Object.entries(stats).filter(([key]) => key !== "storage")) as unknown as AdminStats) : [];
  const previewCount = cleanupPreview
    ? readNumber(asRecord(cleanupPreview), ["count", "wouldDelete", "total"], 0)
    : null;
  const resultRec = cleanupResult ? asRecord(cleanupResult) : null;
  const deletedCount = resultRec ? readNumber(resultRec, ["deleted"], 0) : null;
  const r2ErrorsCount = resultRec ? readNumber(resultRec, ["r2Errors", "r2_errors"], 0) : null;

  const settingsRec = settings ? asRecord(settings) : null;
  const allowlistItems = settingsRec
    ? parseAllowlist(readField(settingsRec, ["allowlist", "allowedEmails", "allowed_emails"]))
    : [];
  const settingsMailbox = settingsRec
    ? readString(settingsRec, ["mailbox", "mailboxAddress", "mailbox_address"], "—")
    : "—";
  const vapidConfigured = settingsRec
    ? readBoolean(
        settingsRec,
        ["vapidConfigured", "vapid_configured", "vapid", "pushConfigured"],
        false,
      )
    : false;
  const telegramConfigured = settingsRec
    ? readBoolean(
        settingsRec,
        ["telegramConfigured", "telegram_configured", "telegram", "telegramBotConfigured"],
        false,
      )
    : false;
  const currentDailyCap = settingsRec
    ? readNumber(settingsRec, ["sendDailyCap", "send_daily_cap"], 0)
    : 0;
  const backupEnabled = settingsRec
    ? readBoolean(settingsRec, ["backupEnabled", "backup_enabled"], false)
    : false;
  const backupRetentionDays = settingsRec
    ? readNumber(settingsRec, ["backupRetentionDays", "backup_retention_days"], 30)
    : 30;
  const backupBucketConfigured = settingsRec
    ? readBoolean(settingsRec, ["backupBucketConfigured", "backup_bucket_configured"], false)
    : false;
  const lastBackupAt = settingsRec
    ? readNumber(settingsRec, ["lastBackupAt", "last_backup_at"], 0)
    : 0;
  const lastBackupStatus = settingsRec
    ? readString(settingsRec, ["lastBackupStatus", "last_backup_status"], "")
    : "";

  return (
    <div className="min-h-full bg-slate-50 px-4 py-8 sm:py-10">
      <div className="mx-auto w-full max-w-5xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Admin</h1>
            {session && (
              <p className="mt-0.5 text-xs text-slate-500">
                {session.email} ({session.role})
              </p>
            )}
          </div>
          <button type="button" onClick={onBack} className={outlineButton}>
            Back
          </button>
        </div>

        {/* Internal tabs */}
        <div
          role="tablist"
          aria-label="Admin sections"
          className="mb-6 flex flex-wrap gap-1.5 border-b border-slate-200 pb-3"
        >
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${focusRing} ${
                  active
                    ? "bg-teal-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Overview Tab */}
        {activeTab === "overview" && (
          <section aria-label="Overview" className="space-y-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">System statistics</h2>
              <button
                type="button"
                onClick={() => void loadStats()}
                disabled={statsLoading}
                className={outlineButton}
              >
                {statsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {statsLoading && !stats ? (
              <p className="text-sm text-slate-600">Loading…</p>
            ) : statsError ? (
              <p role="alert" className="text-sm text-red-600">
                {statsError}
              </p>
            ) : statGroups.length === 0 ? (
              <p className="text-sm text-slate-600">No statistics data yet.</p>
            ) : (
              <div className="space-y-6">
                {stats?.storage && <section className="space-y-3"><h3 className="text-sm font-semibold text-slate-700">Storage</h3><p className="text-sm">{formatBytes(stats.storage.totalBytes)} used · {stats.storage.totalMessages} messages · {stats.storage.quotaMb === 0 ? 'Unlimited' : `${stats.storage.quotaMb} MB per user`}</p>{stats.storage.byMailbox.length===0 ? <p className="text-sm text-slate-600">No messages yet.</p> : <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr><th>Mailbox</th><th>Messages</th><th>Used</th><th>Quota</th><th>%</th><th>Status</th></tr></thead><tbody>{stats.storage.byMailbox.map(row=><tr key={row.mailbox} className={row.overQuota?'bg-red-50 text-red-700':''}><td>{row.mailbox}</td><td>{row.messages}</td><td>{formatBytes(row.bytes)}</td><td>{stats.storage.quotaMb ? `${stats.storage.quotaMb} MB` : 'Unlimited'}</td><td>{row.percentOfQuota===null?'—':<><div className="h-2 w-24 rounded bg-slate-200"><div className="h-2 rounded bg-teal-600" style={{width:`${Math.min(row.percentOfQuota,100)}%`}}/></div>{row.percentOfQuota}%</>}</td><td>{row.overQuota?'Over quota':'OK'}</td></tr>)}</tbody></table></div>}<h4 className="pt-3 text-sm font-semibold">Last 30 days</h4><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead><tr><th>Date</th><th>Received</th><th>Sent</th></tr></thead><tbody>{[...stats.storage.daily].reverse().map(day=><tr key={day.date}><td>{day.date}</td><td>{day.received}</td><td>{day.sent}</td></tr>)}</tbody></table></div></section>}
                {statGroups.map((group) => (
                  <div key={group.title} className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-700">{group.title}</h3>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {group.items.map((item) => (
                        <div
                          key={item.key}
                          className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"
                        >
                          <div className="text-xs font-medium text-slate-500">{item.label}</div>
                          <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                            {item.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Users Tab */}
        {activeTab === "users" && (
          <section aria-label="Users" className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">User management</h2>
              <button
                type="button"
                onClick={() => void loadUsers()}
                disabled={usersLoading}
                className={outlineButton}
              >
                {usersLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {usersError && (
              <p role="alert" className="text-sm text-red-600">
                {usersError}
              </p>
            )}
            {usersMessage && (
              <p role="status" className="text-sm text-teal-700">
                {usersMessage}
              </p>
            )}

            {usersLoading && !usersLoaded ? (
              <p className="text-sm text-slate-600">Loading…</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-slate-600">No users yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                    <tr>
                      <th className="px-3 py-2.5">Email</th>
                      <th className="px-3 py-2.5">Display Name</th>
                      <th className="px-3 py-2.5">Role</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="px-3 py-2.5">Verified</th>
                      <th className="px-3 py-2.5">Created At</th>
                      <th className="px-3 py-2.5">Mailbox</th>
                      <th className="px-3 py-2.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {users.map((row, idx) => {
                      const rec = asRecord(row);
                      const email = readString(rec, ["email"]);
                      const displayName = readString(
                        rec,
                        ["display_name", "displayName"],
                        "—",
                      );
                      const role = readString(rec, ["role"], "user") as UserRole;
                      const status = readString(rec, ["status"], "active");
                      const verified = readBoolean(
                        rec,
                        ["verified", "email_verified", "emailVerified"],
                        false,
                      );
                      const createdAt = readField(rec, ["created_at", "createdAt"]);
                      const mailbox = readString(rec, ["mailbox"], "—");
                      const isSelf = Boolean(email) && email.toLowerCase() === myEmail;
                      const isBanned = status.toLowerCase() === "banned";
                      const isBusy = userBusyEmail === email;
                      const isConfirming = confirmBanEmail === email;

                      return (
                        <tr key={email || idx} className="hover:bg-slate-50/70">
                          <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-900">
                            {email || "—"}
                            {isSelf && (
                              <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                                You
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                            {displayName || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            {isSuperAdmin ? (
                              <select
                                aria-label={`Role of ${email}`}
                                value={role}
                                disabled={isSelf || isBusy}
                                onChange={(e) =>
                                  void handleRoleChange(email, e.target.value as UserRole)
                                }
                                className={`rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                              >
                                {ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                                {role}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                isBanned
                                  ? "bg-red-100 text-red-700"
                                  : "bg-teal-50 text-teal-700"
                              }`}
                            >
                              {status}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                            {verified ? "Yes" : "No"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                            {formatDateTime(createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                            {mailbox || "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={isSelf || isBusy}
                                onClick={() => void handleBanToggle(email, isBanned)}
                                className={
                                  isConfirming
                                    ? isBanned
                                      ? `${outlineButton} border-teal-600 text-teal-700`
                                      : dangerButton
                                    : outlineButton
                                }
                              >
                                {isBusy
                                  ? "Processing…"
                                  : isConfirming
                                    ? isBanned
                                      ? "Confirm unban this user?"
                                      : "Confirm ban this user?"
                                    : isBanned
                                      ? "Unban"
                                      : "Ban"}
                              </button>
                              {isConfirming && !isBusy && (
                                <button
                                  type="button"
                                  onClick={() => setConfirmBanEmail(null)}
                                  className={outlineButton}
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Domains & Aliases Tab */}
        {activeTab === "domains" && (
          <section aria-label="Domains and Aliases" className="space-y-8">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Domains &amp; Aliases</h2>
              <button
                type="button"
                onClick={() => void loadDomainsAndAliases()}
                disabled={domainsLoading}
                className={outlineButton}
              >
                {domainsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {domainsError && (
              <p role="alert" className="text-sm text-red-600">
                {domainsError}
              </p>
            )}
            {domainsMessage && (
              <p role="status" className="text-sm text-teal-700">
                {domainsMessage}
              </p>
            )}

            {domainsLoading && !domainsLoaded ? (
              <p className="text-sm text-slate-600">Loading…</p>
            ) : (
              <>
                {/* Domains Table */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-slate-800">Domains</h3>
                  {domains.length === 0 ? (
                    <p className="text-sm text-slate-600">No domains yet.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                        <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                          <tr>
                            <th className="px-3 py-2.5">Domain</th>
                            <th className="px-3 py-2.5">Enabled</th>
                            <th className="px-3 py-2.5">Alias Count</th>
                            <th className="px-3 py-2.5">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 bg-white">
                          {domains.map((row, idx) => {
                            const rec = asRecord(row);
                            const domainName = readString(rec, ["domain"]);
                            const enabled = readBoolean(rec, ["enabled"], false);
                            const aliasCount = readNumber(
                              rec,
                              ["aliasCount", "alias_count"],
                              0,
                            );
                            const isBusy = busyDomain === domainName;

                            return (
                              <tr key={domainName || idx} className="hover:bg-slate-50/70">
                                <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-900">
                                  {domainName || "—"}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5">
                                  <span
                                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                      enabled
                                        ? "bg-teal-50 text-teal-700"
                                        : "bg-slate-100 text-slate-600"
                                    }`}
                                  >
                                    {enabled ? "Enabled" : "Disabled"}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                                  {aliasCount}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5">
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void handleToggleDomain(domainName, enabled)}
                                    className={outlineButton}
                                  >
                                    {isBusy ? "Saving…" : enabled ? "Disable" : "Enable"}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Aliases Table */}
                <div className="space-y-3 border-t border-slate-200 pt-6">
                  <h3 className="text-sm font-semibold text-slate-800">Aliases</h3>
                  {aliases.length === 0 ? (
                    <p className="text-sm text-slate-600">No aliases yet.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                        <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                          <tr>
                            <th className="px-3 py-2.5">Address</th>
                            <th className="px-3 py-2.5">Label</th>
                            <th className="px-3 py-2.5">Enabled</th>
                            <th className="px-3 py-2.5">Created By</th>
                            <th className="px-3 py-2.5">Created At</th>
                            <th className="px-3 py-2.5">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 bg-white">
                          {aliases.map((row, idx) => {
                            const rec = asRecord(row);
                            const id = readString(rec, ["id"]);
                            const address = readString(rec, ["address"], "—");
                            const label = readString(rec, ["label"], "—");
                            const enabled = readBoolean(rec, ["enabled"], false);
                            const createdBy = readString(
                              rec,
                              ["created_by", "createdBy"],
                              "—",
                            );
                            const createdAt = readField(rec, ["created_at", "createdAt"]);
                            const isBusy = busyAliasId === id;

                            return (
                              <tr key={id || address || idx} className="hover:bg-slate-50/70">
                                <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-900">
                                  {address}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                                  {label || "—"}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5">
                                  <span
                                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                      enabled
                                        ? "bg-teal-50 text-teal-700"
                                        : "bg-slate-100 text-slate-600"
                                    }`}
                                  >
                                    {enabled ? "Enabled" : "Disabled"}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                                  {createdBy || "—"}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                                  {formatDateTime(createdAt)}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5">
                                  <button
                                    type="button"
                                    disabled={!id || isBusy}
                                    onClick={() => void handleToggleAlias(id, address, enabled)}
                                    className={outlineButton}
                                  >
                                    {isBusy ? "Saving…" : enabled ? "Disable" : "Enable"}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* Cleanup Tab */}
        {activeTab === "cleanup" && (
          <section aria-label="Mail Cleanup" className="max-w-xl space-y-5">
            <h2 className="text-base font-semibold text-slate-900">Clean up old mail</h2>

            <form onSubmit={(e) => void handlePreviewCleanup(e)} className="space-y-4">
              <div>
                <label
                  htmlFor="cleanup-folder"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Folder
                </label>
                <select
                  id="cleanup-folder"
                  value={cleanupFolder}
                  onChange={(e) => {
                    setCleanupFolder(e.target.value);
                    setCleanupPreview(null);
                    setCleanupConfirmDelete(false);
                  }}
                  disabled={cleanupPreviewing || cleanupRunning}
                  className={inputClass}
                >
                  {CLEANUP_FOLDERS.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="cleanup-days"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Older than (days)
                </label>
                <input
                  id="cleanup-days"
                  type="number"
                  min={0}
                  step={1}
                  value={cleanupDays}
                  onChange={(e) => {
                    setCleanupDays(e.target.value);
                    setCleanupPreview(null);
                    setCleanupConfirmDelete(false);
                  }}
                  disabled={cleanupPreviewing || cleanupRunning}
                  className={inputClass}
                />
              </div>

              <div>
                <label
                  htmlFor="cleanup-mailbox"
                  className="mb-1.5 block text-sm font-medium text-slate-800"
                >
                  Mailbox (optional)
                </label>
                <input
                  id="cleanup-mailbox"
                  type="text"
                  placeholder="Leave empty to apply to all mailboxes"
                  value={cleanupMailbox}
                  onChange={(e) => {
                    setCleanupMailbox(e.target.value);
                    setCleanupPreview(null);
                    setCleanupConfirmDelete(false);
                  }}
                  disabled={cleanupPreviewing || cleanupRunning}
                  className={inputClass}
                />
              </div>

              {cleanupError && (
                <p role="alert" className="text-sm text-red-600">
                  {cleanupError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={cleanupPreviewing || cleanupRunning}
                  className={`${primaryButton} sm:w-auto`}
                >
                  {cleanupPreviewing ? "Previewing…" : "Preview"}
                </button>
              </div>
            </form>

            {previewCount !== null && (
              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Will delete <span className="font-semibold">{previewCount}</span> messages
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={cleanupRunning || previewCount === 0}
                    onClick={() => void handleRunCleanup()}
                    className={cleanupConfirmDelete ? dangerButton : outlineButton}
                  >
                    {cleanupRunning
                      ? "Deleting…"
                      : cleanupConfirmDelete
                        ? `Confirm delete ${previewCount} messages?`
                        : "Delete"}
                  </button>
                  {cleanupConfirmDelete && !cleanupRunning && (
                    <button
                      type="button"
                      onClick={() => setCleanupConfirmDelete(false)}
                      className={outlineButton}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}

            {deletedCount !== null && r2ErrorsCount !== null && (
              <div
                role="status"
                className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900"
              >
                Deleted <span className="font-semibold">{deletedCount}</span> messages. R2 errors:{" "}
                <span className="font-semibold">{r2ErrorsCount}</span>.
              </div>
            )}
          </section>
        )}

        {/* Audit Tab */}
        {activeTab === "audit" && (
          <section aria-label="Audit Logs" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-900">System log (Audit)</h2>
              <form
                onSubmit={handleAuditFilterSubmit}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  type="text"
                  aria-label="Filter by action"
                  placeholder="Filter by action (e.g. send_failed)"
                  value={auditFilterInput}
                  onChange={(e) => setAuditFilterInput(e.target.value)}
                  className="h-9 w-60 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                />
                <button type="submit" disabled={auditLoading} className={outlineButton}>
                  Filter
                </button>
                {auditActiveFilter && (
                  <button
                    type="button"
                    disabled={auditLoading}
                    onClick={() => {
                      setAuditFilterInput("");
                      setAuditActiveFilter("");
                      void loadAudit("", false, 0);
                    }}
                    className={outlineButton}
                  >
                    Clear filter
                  </button>
                )}
              </form>
            </div>

            {auditError && (
              <p role="alert" className="text-sm text-red-600">
                {auditError}
              </p>
            )}

            {auditLoading && !auditLoaded ? (
              <p className="text-sm text-slate-600">Loading…</p>
            ) : auditLogs.length === 0 ? (
              <p className="text-sm text-slate-600">No audit records yet.</p>
            ) : (
              <div className="space-y-3">
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                    <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                      <tr>
                        <th className="px-3 py-2.5">Time</th>
                        <th className="px-3 py-2.5">Actor</th>
                        <th className="px-3 py-2.5">Action</th>
                        <th className="px-3 py-2.5">Target</th>
                        <th className="px-3 py-2.5">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {auditLogs.map((row, idx) => {
                        const rec = asRecord(row);
                        const id = readString(rec, ["id"], String(idx));
                        const time = readField(rec, [
                          "created_at",
                          "createdAt",
                          "timestamp",
                          "time",
                        ]);
                        const actor = readString(
                          rec,
                          ["actor", "actor_email", "actorEmail"],
                          "—",
                        );
                        const action = readString(rec, ["action"], "—");
                        const target = readString(rec, ["target", "target_id"], "—");
                        const detail = readField(rec, ["detail", "details", "detail_json"]);

                        return (
                          <tr key={`${id}-${idx}`} className="hover:bg-slate-50/70">
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                              {formatDateTime(time)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-800">
                              {actor}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-900">
                              {action}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                              {target}
                            </td>
                            <td className="max-w-md break-words px-3 py-2.5 font-mono text-xs text-slate-600">
                              {formatDetail(detail)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {auditHasMore && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      disabled={auditLoadingMore}
                      onClick={() =>
                        void loadAudit(auditActiveFilter, true, auditLogs.length)
                      }
                      className={outlineButton}
                    >
                      {auditLoadingMore ? "Loading more…" : "Load more"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

{activeTab === "backup" && (
  <section aria-label="Backup" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-slate-900">Backup</h2>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={outlineButton}
          onClick={() => void loadBackupRuns()}
          disabled={backupLoading}
        >
          Refresh
        </button>
        {isSuperAdmin && (
          <button
            type="button"
            className={`${primaryButton} sm:w-auto`}
            onClick={() => void handleRunBackup()}
            disabled={backupRunning || backupLoading}
          >
            {backupRunning ? "Running backup…" : "Run backup now"}
          </button>
        )}
      </div>
    </div>

    <p className="text-sm text-slate-600">
      Daily automatic backup at 03:00 Vietnam time, kept for{" "}
      {settings?.backupRetentionDays ?? 30} days.
      {settings?.backupBucketConfigured === false &&
        " Backup storage is not configured yet — enable backup in Settings once the backup bucket is ready."}
    </p>

    {backupError && (
      <p role="alert" className="text-sm text-red-600">
        {backupError}
      </p>
    )}
    {backupMessage && (
      <p role="status" className="text-sm text-teal-700">
        {backupMessage}
      </p>
    )}

    {backupLoading && !backupLoaded ? (
      <p className="text-sm text-slate-600">Loading…</p>
    ) : backupRuns.length === 0 ? (
      <p className="text-sm text-slate-600">No backup runs yet.</p>
    ) : (
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2.5">Time</th>
              <th className="px-3 py-2.5">Trigger</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">D1 size</th>
              <th className="px-3 py-2.5">R2 copied</th>
              <th className="px-3 py-2.5">R2 errors</th>
              <th className="px-3 py-2.5">Error</th>
              <th className="px-3 py-2.5">Objects</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {backupRuns.map((run) => (
              <tr key={run.id} className="hover:bg-slate-50/70">
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                  {formatDateTime(run.startedAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                  {run.trigger}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      run.status === "succeeded"
                        ? "bg-emerald-50 text-emerald-700"
                        : run.status === "failed"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {run.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                  {typeof run.d1Size === "number"
                    ? `${run.d1Size.toLocaleString()} B`
                    : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                  {typeof run.r2Copied === "number" ? run.r2Copied : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                  {typeof run.r2Errors === "number" ? run.r2Errors : "—"}
                </td>
                <td className="max-w-xs break-words px-3 py-2.5 text-slate-700">
                  {run.error || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={outlineButton}
                      onClick={() => void handleLoadBackupObjects(run.id)}
                    >
                      Objects
                    </button>
                    <button
                      type="button"
                      className={outlineButton}
                      onClick={() => void handleDownloadBackupObject(run.id, run.d1ObjectKey)}
                      disabled={!run.d1ObjectKey || backupDownloadingKey === run.d1ObjectKey}
                    >
                      {backupDownloadingKey === run.d1ObjectKey
                        ? "Downloading…"
                        : "Download D1"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {backupObjectsRunId && (
      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
        <h3 className="text-sm font-semibold text-slate-900">
          Objects for run {backupObjectsRunId}
        </h3>

        {backupObjectsError && (
          <p role="alert" className="text-sm text-red-600">
            {backupObjectsError}
          </p>
        )}

        {backupObjectsLoading ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : backupObjects.length === 0 ? (
          <p className="text-sm text-slate-600">No objects for this run.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2.5">Key</th>
                  <th className="px-3 py-2.5">Size</th>
                  <th className="px-3 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {backupObjects.map((obj) => (
                  <tr key={obj.key} className="hover:bg-slate-50/70">
                    <td className="break-all px-3 py-2.5 font-mono text-xs text-slate-800">
                      {obj.key}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                      {typeof obj.size === "number"
                        ? `${obj.size.toLocaleString()} B`
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <button
                        type="button"
                        className={outlineButton}
                        onClick={() =>
                          void handleDownloadBackupObject(
                            backupObjectsRunId,
                            obj.key,
                          )
                        }
                        disabled={backupDownloadingKey === obj.key}
                      >
                        {backupDownloadingKey === obj.key
                          ? "Downloading…"
                          : "Download"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )}
  </section>
)}

{activeTab === "logs" && (
  <section aria-label="Logs" className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-slate-900">Logs</h2>
      <button
        type="button"
        className={outlineButton}
        onClick={() => {
          void loadClientErrors();
          void loadBackupRuns();
          void loadAudit("", false, 0);
        }}
        disabled={logsLoading || backupLoading || auditLoading}
      >
        Refresh
      </button>
    </div>

    <p className="text-sm text-slate-600">
      Full system logs are viewed with `wrangler tail` — see docs/OBSERVABILITY.md.
      Browser errors reported by the mail client store only a mailbox hash — no
      message content.
    </p>

    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Client errors</h3>
      {logsError && (
        <p role="alert" className="text-sm text-red-600">
          {logsError}
        </p>
      )}
      {logsLoading && !logsLoaded ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : clientErrors.length === 0 ? (
        <p className="text-sm text-slate-600">No client errors recorded.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2.5">Time</th>
                <th className="px-3 py-2.5">Crash ID</th>
                <th className="px-3 py-2.5">Message</th>
                <th className="px-3 py-2.5">URL</th>
                <th className="px-3 py-2.5">User agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {clientErrors.slice(0, 50).map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50/70">
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-800">
                    {entry.crashId || "—"}
                  </td>
                  <td className="max-w-md break-words px-3 py-2.5 text-slate-800">
                    {entry.message}
                  </td>
                  <td className="max-w-xs break-all px-3 py-2.5 font-mono text-xs text-slate-700">
                    {entry.url || "—"}
                  </td>
                  <td className="max-w-xs break-words px-3 py-2.5 text-slate-700">
                    {entry.userAgent || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>

    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Backup runs</h3>
      {backupLoading && !backupLoaded ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : backupRuns.length === 0 ? (
        <p className="text-sm text-slate-600">No backup runs yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2.5">Time</th>
                <th className="px-3 py-2.5">Trigger</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">D1 size</th>
                <th className="px-3 py-2.5">R2 copied</th>
                <th className="px-3 py-2.5">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {backupRuns.slice(0, 50).map((run) => (
                <tr key={run.id} className="hover:bg-slate-50/70">
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{run.trigger}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        run.status === "succeeded"
                          ? "bg-emerald-50 text-emerald-700"
                          : run.status === "failed"
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                    {typeof run.d1Size === "number" ? `${run.d1Size.toLocaleString()} B` : "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                    {typeof run.r2Copied === "number" ? run.r2Copied : "—"}
                  </td>
                  <td className="max-w-xs break-words px-3 py-2.5 text-slate-700">
                    {run.error || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>

    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Audit logs</h3>
      {auditError && (
        <p role="alert" className="text-sm text-red-600">
          {auditError}
        </p>
      )}
      {auditLoading && !auditLoaded ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : auditLogs.length === 0 ? (
        <p className="text-sm text-slate-600">No audit logs.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2.5">Time</th>
                <th className="px-3 py-2.5">Actor</th>
                <th className="px-3 py-2.5">Action</th>
                <th className="px-3 py-2.5">Target</th>
                <th className="px-3 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {auditLogs.slice(0, 50).map((row, idx) => {
                const rec = asRecord(row);
                const id = readString(rec, ["id"], String(idx));
                const time = readField(rec, ["created_at", "createdAt", "timestamp", "time"]);
                const actor = readString(rec, ["actor", "actor_email", "actorEmail"], "—");
                const action = readString(rec, ["action"], "—");
                const target = readString(rec, ["target", "target_id"], "—");
                const detail = readField(rec, ["detail", "details", "detail_json"]);
                return (
                  <tr key={`${id}-${idx}`} className="hover:bg-slate-50/70">
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                      {formatDateTime(time)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-800">{actor}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-900">
                      {action}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{target}</td>
                    <td className="max-w-md break-words px-3 py-2.5 font-mono text-xs text-slate-600">
                      {formatDetail(detail)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </section>
)}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <section aria-label="Admin Settings" className="max-w-2xl space-y-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">System settings</h2>
              <button
                type="button"
                onClick={() => void loadSettings()}
                disabled={settingsLoading}
                className={outlineButton}
              >
                {settingsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {settingsLoading && !settingsLoaded ? (
              <p className="text-sm text-slate-600">Loading…</p>
            ) : settingsError && !settings ? (
              <p role="alert" className="text-sm text-red-600">
                {settingsError}
              </p>
            ) : (
              <div className="space-y-6">
                {/* Read-only server config */}
                <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-800">
                      Environment config (read-only)
                    </h3>
                    <span className="text-xs text-slate-500">
                      Change via server config, requires deploy
                    </span>
                  </div>

                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="font-medium text-slate-700">Mailbox</dt>
                      <dd className="mt-0.5 font-mono text-slate-900">{settingsMailbox}</dd>
                    </div>

                    <div>
                      <dt className="font-medium text-slate-700">Allowlist</dt>
                      <dd className="mt-1">
                        {allowlistItems.length === 0 ? (
                          <span className="text-slate-500">—</span>
                        ) : (
                          <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs text-slate-800">
                            {allowlistItems.map((email) => (
                              <li key={email}>{email}</li>
                            ))}
                          </ul>
                        )}
                      </dd>
                    </div>

                    <div className="flex flex-wrap gap-6">
                      <div>
                        <dt className="font-medium text-slate-700">VAPID (Browser Push)</dt>
                        <dd className="mt-1">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              vapidConfigured
                                ? "bg-teal-50 text-teal-700"
                                : "bg-slate-200 text-slate-700"
                            }`}
                          >
                            {vapidConfigured ? "Configured" : "Not configured"}
                          </span>
                        </dd>
                      </div>

                      <div>
                        <dt className="font-medium text-slate-700">Telegram Bot</dt>
                        <dd className="mt-1">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              telegramConfigured
                                ? "bg-teal-50 text-teal-700"
                                : "bg-slate-200 text-slate-700"
                            }`}
                          >
                            {telegramConfigured ? "Configured" : "Not configured"}
                          </span>
                        </dd>
                      </div>
                    </div>
                  </dl>
                </div>

                {/* sendDailyCap */}
                <div className="space-y-3 border-t border-slate-200 pt-5">
                  <h3 className="text-sm font-semibold text-slate-800">
                    Daily send limit and storage quota
                  </h3>

                  {isSuperAdmin ? (
                    <form onSubmit={(e) => void handleSaveSettings(e)} className="space-y-3">
                      <div>
                        <label
                          htmlFor="send-daily-cap"
                          className="mb-1.5 block text-sm font-medium text-slate-800"
                        >
                          sendDailyCap
                        </label>
                        <input
                          id="send-daily-cap"
                          type="number"
                          min={0}
                          step={1}
                          value={sendDailyCapInput}
                          onChange={(e) => setSendDailyCapInput(e.target.value)}
                          disabled={settingsSaving}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label htmlFor="storage-quota" className="mb-1.5 block text-sm font-medium text-slate-800">Storage quota per user (MB)</label>
                        <input id="storage-quota" type="number" min={0} max={102400} step={1} value={storageQuotaInput} onChange={e=>setStorageQuotaInput(e.target.value)} disabled={settingsSaving} className={inputClass}/>
                        <p className="mt-1 text-xs text-slate-500">0 = Unlimited</p>
                      </div>

                      {settingsError && (
                        <p role="alert" className="text-sm text-red-600">
                          {settingsError}
                        </p>
                      )}
                      {settingsMessage && (
                        <p role="status" className="text-sm text-teal-700">
                          {settingsMessage}
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={settingsSaving}
                        className={`${primaryButton} sm:w-auto`}
                      >
                        {settingsSaving ? "Saving…" : "Save"}
                      </button>
                    </form>
                  ) : (
                    <p className="text-sm text-slate-700">
                      Current value:{" "}
                      <span className="font-semibold tabular-nums">{currentDailyCap}</span>{" "}
                      <span className="text-xs text-slate-500">
                        (only super_admin can edit)
                      </span>
                    </p>
                  )}
                </div>

                <div className="space-y-3 border-t border-slate-200 pt-5">
                  <h3 className="text-sm font-semibold text-slate-800">Backup</h3>

                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="font-medium text-slate-700">Status</dt>
                      <dd className="mt-1">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            backupEnabled ? "bg-teal-50 text-teal-700" : "bg-slate-200 text-slate-700"
                          }`}
                        >
                          {backupEnabled ? "Enabled" : "Disabled"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-700">Storage</dt>
                      <dd className="mt-1">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            backupBucketConfigured ? "bg-teal-50 text-teal-700" : "bg-slate-200 text-slate-700"
                          }`}
                        >
                          {backupBucketConfigured ? "Configured" : "Not configured"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-700">Last backup</dt>
                      <dd className="mt-0.5 text-slate-900">
                        {lastBackupAt ? `${formatDateTime(lastBackupAt)} (${lastBackupStatus})` : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-700">Retention</dt>
                      <dd className="mt-0.5 text-slate-900">{backupRetentionDays} days</dd>
                    </div>
                  </dl>

                  {isSuperAdmin ? (
                    <form onSubmit={(e) => void handleSaveBackupSettings(e)} className="space-y-3">
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                        <input
                          type="checkbox"
                          checked={backupEnabledInput}
                          onChange={(e) => setBackupEnabledInput(e.target.checked)}
                          disabled={backupSettingsSaving}
                          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                        />
                        Enable daily backup (03:00 Vietnam time)
                      </label>
                      <div>
                        <label
                          htmlFor="backup-retention-days"
                          className="mb-1.5 block text-sm font-medium text-slate-800"
                        >
                          Retention (days)
                        </label>
                        <input
                          id="backup-retention-days"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={backupRetentionInput}
                          onChange={(e) => setBackupRetentionInput(e.target.value)}
                          disabled={backupSettingsSaving}
                          className={inputClass}
                        />
                      </div>

                      {settingsError && (
                        <p role="alert" className="text-sm text-red-600">
                          {settingsError}
                        </p>
                      )}
                      {settingsMessage && (
                        <p role="status" className="text-sm text-teal-700">
                          {settingsMessage}
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={backupSettingsSaving}
                        className={`${primaryButton} sm:w-auto`}
                      >
                        {backupSettingsSaving ? "Saving…" : "Save backup settings"}
                      </button>
                    </form>
                  ) : (
                    <p className="text-sm text-slate-700">
                      Only super_admin can change backup settings.
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
