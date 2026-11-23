export type Addr = { address: string; name: string };

export interface MessageItem {
  id: string;
  shortCode?: string | null;
  folder: 'inbox' | 'sent' | 'spam';
  from: Addr;
  to: Addr[];
  subject: string;
  snippet: string;
  date: number;
  isRead: boolean;
  isFocused?: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  [key: string]: any;
}

export interface MessageDetail extends MessageItem {
  cc: Addr[];
  replyTo: Addr[];
  messageId: string | null;
  text: string;
  html: string | null;
  attachments: { index: number; filename: string; mimeType: string; size: number }[];
}

export type Config = {
  googleClientId: string;
  devLogin: boolean;
  mailbox: string;
  sendingEnabled: boolean;
  totpEncryptionKey?: string;
};

export type Alias = {
  id: string;
  address: string;
  local_part?: string;
  domain?: string;
  label?: string;
  enabled: boolean;
  created_by?: string;
  created_at?: number;
  [key: string]: any;
};

export type Domain = {
  domain: string;
  name?: string;
  is_default?: boolean | number;
  default?: boolean;
  active?: boolean | number;
  verified?: boolean | number;
  [key: string]: any;
};

export interface NotificationSettings {
  push_enabled: boolean;
  telegram_enabled: boolean;
  telegram_chat_id: string;
  detail_level: 'basic' | 'full';
}

export interface NotificationSettingsUpdate {
  push_enabled?: boolean;
  telegram_enabled?: boolean;
  telegram_chat_id?: string;
  detail_level?: 'basic' | 'full';
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type UserRole = 'super_admin' | 'admin' | 'user';
export type UserStatus = 'active' | 'banned';

export interface AdminStats {
  users: {
    total: number;
    active: number;
    banned: number;
    admins: number;
  };
  mailboxes: {
    total: number;
  };
  messages: {
    total: number;
    unread: number;
    spam: number;
    trash: number;
  };
  domains: {
    total: number;
    enabled: number;
  };
  aliases: {
    total: number;
    enabled: number;
  };
  notifications: {
    pushEnabled: number;
    telegramEnabled: number;
    pushSubscriptions: number;
  };
  storage: { totalBytes:number; totalMessages:number; attachmentBytes:number; quotaMb:number; quotaBytes:number; byMailbox:Array<{mailbox:string;messages:number;bytes:number;percentOfQuota:number|null;overQuota:boolean}>; daily:Array<{date:string;received:number;sent:number}> };
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: string;
  verified: boolean;
  createdAt: number;
  mailbox?: string | null;
}

export interface AdminDomain {
  domain: string;
  enabled: boolean;
  createdAt: number;
  aliasCount?: number;
}

export interface AdminAlias {
  id: string;
  localPart: string;
  domain: string;
  address: string;
  label: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
}

export interface CleanupOptions {
  mailbox?: string;
  folder: string;
  olderThanDays: number;
}

export interface CleanupPreview {
  count: number;
  folder: string;
  mailbox: string | null;
  olderThanDays: number;
  cutoffMs: number;
}

export interface CleanupResult {
  deleted: number;
  r2Errors: number;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  createdAt: number;
}

export interface ListAuditLogsOptions {
  action?: string;
  limit?: number;
  before?: number;
}

export interface AdminSettings {
  sendDailyCap: number;
  storageQuotaMb?: number;
  updatedAt?: number;
  allowedEmails: string[];
  mailboxAddress?: string;
  vapidConfigured?: boolean;
  telegramConfigured?: boolean;
  backupEnabled?: boolean;
  backupRetentionDays?: number;
  backupSchedule?: string;
  backupBucketConfigured?: boolean;
  lastBackupAt?: number | null;
  lastBackupStatus?: string;
}

export interface UpdateAdminSettingsPayload {
  sendDailyCap?: number;
  storageQuotaMb?: number;
  backupEnabled?: boolean;
  backupRetentionDays?: number;
  backupSchedule?: string;
}

export interface BackupRun {
  id: string;
  trigger: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  d1ObjectKey: string;
  d1Size: number;
  r2Copied: number;
  r2Errors: number;
  error: string;
}

export interface BackupObject {
  key: string;
  size: number;
  uploaded?: string;
}

export interface BackupObjectsResult {
  objects: BackupObject[];
  cursor?: string;
}

export interface ClientErrorEntry {
  id: string;
  crashId: string;
  mailboxHash: string;
  message: string;
  stack: string;
  url: string;
  userAgent: string;
  createdAt: number;
}

// PHASE4-R7
export interface ExternalAccount {
  id: string;
  provider: string;
  email: string;
  status: string;
  lastSyncedAt: number | null;
  lastSeenUid: number;
  lastError: string;
}

export type GmailSyncResult =
  | { skipped: true }
  | { fetched: number; inserted: number; duplicates: number; errors: number };

export interface ConnectGmailPayload {
  email: string;
  appPassword: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Mail-Client': '1' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    let body: unknown;
    try {
      body = await res.json();
      if (body && typeof body === 'object') {
        const obj = body as { error?: string; message?: string; code?: string };
        if (obj.message) message = obj.message;
        else if (obj.error) message = obj.error;
        if (obj.code) code = obj.code;
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, message, code, body);
  }

  return (await res.json()) as T;
}

export interface DraftItem {
  id: string;
  mailboxAddress: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  replyToId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SaveDraftPayload {
  id?: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  replyToId?: string | null;
}

export interface SendMailPayload {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  replyToId?: string | null;
  draftId?: string | null;
  clientId?: string;
  from?: string;
  attachments?: { key: string; filename: string; size: number; mimeType: string }[];
}

export interface MessageListResult {
  items: MessageItem[];
  nextBefore: number | null;
}

export interface ThreadItem {
  threadKey: string;
  subject: string;
  participants: string[];
  count: number;
  unreadCount: number;
  latestDate: number;
  latestId: string;
  starred: boolean;
  snippet: string;
  ids?: string[];
}

export type BatchAction = 'read' | 'unread' | 'star' | 'unstar' | 'spam';

export const MAX_BATCH_SELECTION = 50;

export async function fetchDrafts(): Promise<DraftItem[]> {
  const data = await requestJson<{ drafts: DraftItem[] }>('/api/drafts');
  return data.drafts ?? [];
}

export async function fetchDraft(id: string): Promise<DraftItem> {
  const data = await requestJson<{ draft: DraftItem }>(
    `/api/drafts/${encodeURIComponent(id)}`,
  );
  return data.draft;
}

export async function saveDraft(payload: SaveDraftPayload): Promise<DraftItem> {
  const data = await requestJson<{ draft: DraftItem }>('/api/drafts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.draft;
}

export async function deleteDraftApi(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/drafts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchMessages(
  params: {
    folder?: string;
    q?: string;
    before?: number;
    limit?: number;
    tab?: string;
  } = {},
): Promise<MessageListResult> {
  const qs = new URLSearchParams();
  if (params.folder) qs.set('folder', params.folder);
  if (params.q) qs.set('q', params.q);
  if (params.before) qs.set('before', String(params.before));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.tab) qs.set('tab', params.tab);
  const data = await requestJson<MessageListResult>(`/api/messages?${qs.toString()}`);
  return { items: data.items ?? [], nextBefore: data.nextBefore ?? null };
}

export async function searchMessages(
  q: string,
  folder = 'inbox',
  limit?: number,
): Promise<{ items: MessageItem[]; total: number }> {
  const qs = new URLSearchParams({ q, folder });
  if (limit) qs.set('limit', String(limit));
  const data = await requestJson<{ items: MessageItem[]; total: number }>(`/api/search?${qs.toString()}`);
  return { items: data.items ?? [], total: data.total ?? 0 };
}

export async function fetchStarred(before?: number): Promise<MessageListResult> {
  const qs = new URLSearchParams({ starred: '1' });
  if (before) qs.set('before', String(before));
  const data = await requestJson<MessageListResult>(`/api/messages?${qs.toString()}`);
  return { items: data.items ?? [], nextBefore: data.nextBefore ?? null };
}

export async function fetchMessage(id: string): Promise<MessageItem & Record<string, any>> {
  return requestJson(`/api/messages/${encodeURIComponent(id)}`);
}

export async function markMessageRead(id: string, read: boolean): Promise<{ ok: boolean }> {
  return requestJson(`/api/messages/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    body: JSON.stringify({ read }),
  });
}

export async function setStarred(
  id: string,
  starred: boolean,
): Promise<{ id: string; is_starred: boolean }> {
  return requestJson(`/api/messages/${encodeURIComponent(id)}/star`, {
    method: 'POST',
    body: JSON.stringify({ starred }),
  });
}

export async function fetchThreads(
  folder: string,
  before?: number,
): Promise<{ threads: ThreadItem[] }> {
  const qs = new URLSearchParams({ folder });
  if (before) qs.set('before', String(before));
  const data = await requestJson<{ threads: ThreadItem[] }>(`/api/threads?${qs.toString()}`);
  return { threads: data.threads ?? [] };
}

export async function fetchThread(
  key: string,
): Promise<{ messages: (MessageItem & Record<string, any>)[] }> {
  const data = await requestJson<{ messages: (MessageItem & Record<string, any>)[] }>(
    `/api/threads/${encodeURIComponent(key)}`,
  );
  return { messages: data.messages ?? [] };
}

export async function batchMessages(
  ids: string[],
  action: BatchAction,
): Promise<{ updated: number }> {
  return requestJson('/api/messages/batch', {
    method: 'POST',
    body: JSON.stringify({ ids, action }),
  });
}

export async function sendMail(payload: SendMailPayload): Promise<void> {
  await requestJson<{ ok: boolean }>('/api/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface ApiClient {
  config: () => Promise<Config>;
  session: () => Promise<{ email: string; mailbox: string; role: UserRole }>;
  loginGoogle: (credential: string) => Promise<{ email: string; mfaRequired?: boolean }>;
  loginDev: () => Promise<{ email: string }>;
  logout: () => Promise<unknown>;

  mfaStatus: () => Promise<{ ready: boolean; enabled: boolean; recoveryCodesRemaining: number }>;
  mfaSetup: (email: string) => Promise<{ secret: string; uri: string }>;
  mfaConfirm: (code: string) => Promise<{ recoveryCodes: string[] }>;
  mfaDisable: (code: string) => Promise<{ ok: boolean }>;
  mfaChallenge: (code: string) => Promise<{ email: string; mailbox: string }>;

  list: (
    folder: string,
    q?: string,
    before?: number | null,
    tab?: string,
  ) => Promise<{ items: MessageItem[]; nextBefore: number | null }>;
  counts: () => Promise<{ unread: number }>;
  get: (id: string) => Promise<MessageDetail>;
  markRead: (id: string, read: boolean) => Promise<unknown>;
  send: (payload: SendMailPayload) => Promise<{ ok: boolean; id: string }>;
  summary: (id: string) => Promise<{ summary: string }>;
  draftReply: (id: string) => Promise<{ draft: string }>;

  domains: () => Promise<{ domains: Domain[]; [key: string]: any }>;
  listDomains: () => Promise<{ domains: Domain[]; [key: string]: any }>;
  addDomain: (domain: string) => Promise<{ domain: { domain: string; enabled: boolean } }>;
  setDomainEnabled: (
    domain: string,
    enabled: boolean,
  ) => Promise<{ domain: { domain: string; enabled: boolean } }>;

  listAliases: () => Promise<{ aliases: Alias[]; [key: string]: any }>;
  aliases: () => Promise<{ aliases: Alias[]; [key: string]: any }>;
  createAlias: (label: string, domain?: string) => Promise<{ alias: Alias }>;
  setAliasEnabled: (id: string, enabled: boolean) => Promise<{ alias: Alias }>;
  deleteAlias: (id: string) => Promise<{ ok: boolean }>;
  toggleAlias: (id: string, enabled?: boolean) => Promise<{ id: string; enabled: boolean }>;
  updateAlias: (id: string, payload: Record<string, any>) => Promise<any>;

  listDrafts: () => Promise<{ drafts: DraftItem[] }>;
  getDraft: (id: string) => Promise<{ draft: DraftItem }>;
  saveDraft: (payload: SaveDraftPayload) => Promise<{ draft: DraftItem }>;
  deleteDraft: (id: string) => Promise<{ ok: boolean }>;

  loginPassword: (
    email: string,
    password: string,
  ) => Promise<{ email: string; mfaRequired?: boolean }>;
  signup: (email: string, password: string) => Promise<{ email: string }>;
  forgotPassword: (email: string) => Promise<{ success: boolean }>;
  resetPassword: (token: string, password: string) => Promise<{ success: boolean }>;
  verifyEmail: (token: string) => Promise<{ success: boolean; email: string }>;

  getNotificationSettings: () => Promise<NotificationSettings>;
  updateNotificationSettings: (payload: NotificationSettingsUpdate) => Promise<NotificationSettings>;
  getVapidPublicKey: () => Promise<{ publicKey: string }>;
  subscribePush: (subscription: PushSubscriptionPayload) => Promise<{ ok: true }>;
  unsubscribePush: (endpoint: string) => Promise<{ ok: true }>;
  sendTestNotification: (channel: 'push' | 'telegram') => Promise<{ ok: true }>;

  getAdminStats: () => Promise<AdminStats>;
  listAdminUsers: () => Promise<AdminUser[]>;
  setUserRole: (email: string, role: UserRole) => Promise<{ email: string; role: UserRole }>;
  setUserStatus: (email: string, status: UserStatus) => Promise<{ email: string; status: UserStatus }>;
  listAdminDomains: () => Promise<AdminDomain[]>;
  toggleDomain: (domain: string, enabled: boolean) => Promise<{ domain: string; enabled: boolean }>;
  listAdminAliases: () => Promise<AdminAlias[]>;
  previewMailCleanup: (opts: CleanupOptions) => Promise<CleanupPreview>;
  runMailCleanup: (opts: CleanupOptions) => Promise<CleanupResult>;
  listAuditLogs: (opts?: ListAuditLogsOptions) => Promise<AuditLogEntry[]>;
  getAdminSettings: () => Promise<AdminSettings>;
  updateAdminSettings: (payload: UpdateAdminSettingsPayload) => Promise<AdminSettings>;
  listBackupRuns: (limit?: number) => Promise<BackupRun[]>;
  runBackupNow: () => Promise<BackupRun>;
  listBackupObjects: (runId: string, cursor?: string) => Promise<BackupObjectsResult>;
  downloadBackupObject: (runId: string, key: string) => Promise<Blob>;
  listClientErrors: (limit?: number) => Promise<ClientErrorEntry[]>;
  reportClientError: (payload: { crashId: string; message?: string; stack?: string; url?: string; userAgent?: string }) => Promise<{ ok: boolean; crashId: string }>;

  // PHASE4-R7
  listExternalAccounts: () => Promise<{ accounts: ExternalAccount[] }>;
  connectGmail: (payload: ConnectGmailPayload) => Promise<{ account: ExternalAccount }>;
  disconnectGmail: (accountId: string) => Promise<{ account: ExternalAccount }>;
  syncGmailNow: (accountId: string) => Promise<GmailSyncResult>;
  uploadAttachments: (files: File[]) => Promise<{ attachments: { key: string; filename: string; size: number; mimeType: string }[] }>;
}

export const api: ApiClient = {
  config: () => requestJson<Config>('/api/config'),
  session: () => requestJson<{ email: string; mailbox: string; role: UserRole }>('/api/session'),
  loginGoogle: (credential) =>
    requestJson<{ email: string; mfaRequired?: boolean }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),
  loginDev: () => requestJson<{ email: string }>('/api/auth/dev', { method: 'POST' }),
  logout: () => requestJson('/api/logout', { method: 'POST' }),

  mfaStatus: () =>
    requestJson<{ ready: boolean; enabled: boolean; recoveryCodesRemaining: number }>(
      '/api/auth/mfa/status',
    ),
  mfaSetup: (email) =>
    requestJson<{ secret: string; uri: string }>('/api/auth/mfa/setup', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  mfaConfirm: (code) =>
    requestJson<{ recoveryCodes: string[] }>('/api/auth/mfa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  mfaDisable: (code) =>
    requestJson<{ ok: boolean }>('/api/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  mfaChallenge: (code) =>
    requestJson<{ email: string; mailbox: string }>('/api/auth/mfa/challenge', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  list: (folder, q, before, tab) => {
    const p = new URLSearchParams({ folder });
    if (q) p.set('q', q);
    if (before) p.set('before', String(before));
    if (tab) p.set('tab', tab);
    return requestJson<{ items: MessageItem[]; nextBefore: number | null }>(`/api/messages?${p}`);
  },
  counts: () => requestJson<{ unread: number }>('/api/counts'),
  get: (id) => requestJson<MessageDetail>(`/api/messages/${encodeURIComponent(id)}`),
  markRead: (id, read) =>
    requestJson(`/api/messages/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: JSON.stringify({ read }),
    }),
  send: (payload) =>
    requestJson<{ ok: boolean; id: string }>('/api/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadAttachments: async (files) => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const res = await fetch('/api/attachments/upload', { method: 'POST', credentials: 'include', headers: { 'X-Mail-Client': '1' }, body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new ApiError(res.status, body.error || `Request failed (${res.status})`);
    }
    return res.json() as Promise<{ attachments: { key: string; filename: string; size: number; mimeType: string }[] }>;
  },
  summary: (id) =>
    requestJson<{ summary: string }>(`/api/messages/${encodeURIComponent(id)}/summary`, {
      method: 'POST',
    }),
  draftReply: (id) =>
    requestJson<{ draft: string }>(`/api/messages/${encodeURIComponent(id)}/draft-reply`, {
      method: 'POST',
    }),

  domains: () => requestJson<{ domains: Domain[] }>('/api/domains'),
  listDomains: () => requestJson<{ domains: Domain[] }>('/api/domains'),
  addDomain: (domain) =>
    requestJson<{ domain: { domain: string; enabled: boolean } }>('/api/domains', {
      method: 'POST',
      body: JSON.stringify({ domain }),
    }),
  setDomainEnabled: (domain, enabled) =>
    requestJson<{ domain: { domain: string; enabled: boolean } }>(
      `/api/domains/${encodeURIComponent(domain)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),

  listAliases: () => requestJson<{ aliases: Alias[] }>('/api/aliases'),
  aliases: () => requestJson<{ aliases: Alias[] }>('/api/aliases'),
  createAlias: (label, domain) =>
    requestJson<{ alias: Alias }>('/api/aliases', {
      method: 'POST',
      body: JSON.stringify({ label, domain }),
    }),
  setAliasEnabled: (id, enabled) =>
    requestJson<{ alias: Alias }>(
      `/api/aliases/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  deleteAlias: (id) =>
    requestJson<{ ok: boolean }>(`/api/aliases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  toggleAlias: (id, enabled) =>
    requestJson<{ id: string; enabled: boolean }>('/api/admin/aliases/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled }),
    }),
  updateAlias: (id, payload) =>
    requestJson(`/api/aliases/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  listDrafts: () => requestJson<{ drafts: DraftItem[] }>('/api/drafts'),
  getDraft: (id) =>
    requestJson<{ draft: DraftItem }>(`/api/drafts/${encodeURIComponent(id)}`),
  saveDraft: (payload) =>
    requestJson<{ draft: DraftItem }>('/api/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteDraft: (id) =>
    requestJson<{ ok: boolean }>(`/api/drafts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  loginPassword: (email, password) =>
    requestJson<{ email: string; mfaRequired?: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signup: (email, password) =>
    requestJson<{ email: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  forgotPassword: (email) =>
    requestJson<{ success: boolean }>('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token, password) =>
    requestJson<{ success: boolean }>('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  verifyEmail: (token) =>
    requestJson<{ success: boolean; email: string }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  getNotificationSettings: () =>
    requestJson<NotificationSettings>('/api/notifications/settings'),
  updateNotificationSettings: (payload) =>
    requestJson<NotificationSettings>('/api/notifications/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getVapidPublicKey: () =>
    requestJson<{ publicKey: string }>('/api/notifications/push/vapid-key'),
  subscribePush: (subscription) =>
    requestJson<{ ok: true }>('/api/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),
  unsubscribePush: (endpoint) =>
    requestJson<{ ok: true }>('/api/notifications/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),
  sendTestNotification: (channel) =>
    requestJson<{ ok: true }>('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),

  getAdminStats: () => requestJson<AdminStats>('/api/admin/stats'),
  listAdminUsers: async () => {
    const r = await requestJson<AdminUser[] | { users?: AdminUser[] }>('/api/admin/users');
    return Array.isArray(r) ? r : (r.users ?? []);
  },
  setUserRole: (email, role) =>
    requestJson<{ email: string; role: UserRole }>('/api/admin/users/role', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  setUserStatus: (email, status) =>
    requestJson<{ email: string; status: UserStatus }>('/api/admin/users/status', {
      method: 'POST',
      body: JSON.stringify({ email, status }),
    }),
  listAdminDomains: async () => {
    const r = await requestJson<AdminDomain[] | { domains?: AdminDomain[] }>('/api/admin/domains');
    return Array.isArray(r) ? r : (r.domains ?? []);
  },
  toggleDomain: (domain, enabled) =>
    requestJson<{ domain: string; enabled: boolean }>('/api/admin/domains/toggle', {
      method: 'POST',
      body: JSON.stringify({ domain, enabled }),
    }),
  listAdminAliases: async () => {
    const r = await requestJson<AdminAlias[] | { aliases?: AdminAlias[] }>('/api/admin/aliases');
    return Array.isArray(r) ? r : (r.aliases ?? []);
  },
  previewMailCleanup: (opts) => {
    const qs = new URLSearchParams({
      folder: opts.folder,
      olderThanDays: String(opts.olderThanDays),
    });
    if (opts.mailbox) qs.set('mailbox', opts.mailbox);
    return requestJson<CleanupPreview>(`/api/admin/mail-cleanup/preview?${qs.toString()}`);
  },
  runMailCleanup: (opts) =>
    requestJson<CleanupResult>('/api/admin/mail-cleanup', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  listAuditLogs: (opts) => {
    const qs = new URLSearchParams();
    if (opts?.action) qs.set('action', opts.action);
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.before !== undefined) qs.set('before', String(opts.before));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson<AuditLogEntry[] | { logs?: AuditLogEntry[] }>(`/api/admin/audit-logs${suffix}`).then((r) =>
      Array.isArray(r) ? r : (r.logs ?? []),
    );
  },
  getAdminSettings: () => requestJson<AdminSettings>('/api/admin/settings'),
  updateAdminSettings: (payload) =>
    requestJson<AdminSettings>('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listBackupRuns: (limit) => {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return requestJson<BackupRun[]>(`/api/admin/backups${qs}`);
  },
  runBackupNow: () =>
    requestJson<BackupRun>('/api/admin/backups/run', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listBackupObjects: (runId, cursor) => {
    const qs = new URLSearchParams({ runId });
    if (cursor) qs.set('cursor', cursor);
    return requestJson<BackupObjectsResult>(`/api/admin/backups/objects?${qs.toString()}`);
  },
  downloadBackupObject: async (runId, key) => {
    const qs = new URLSearchParams({ runId, key });
    const res = await fetch(`/api/admin/backups/download?${qs.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body && typeof body === 'object' && (body as { error?: string }).error) {
          message = (body as { error: string }).error;
        }
      } catch {
        // ignore non-JSON error bodies
      }
      throw new ApiError(res.status, message);
    }
    return res.blob();
  },
  listClientErrors: (limit) => {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return requestJson<ClientErrorEntry[]>(`/api/admin/client-errors${qs}`);
  },
  reportClientError: (payload) =>
    requestJson<{ ok: boolean; crashId: string }>('/api/client-errors', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // PHASE4-R7
  listExternalAccounts: () =>
    requestJson<{ accounts: ExternalAccount[] }>('/api/external/accounts'),
  connectGmail: (payload) =>
    requestJson<{ account: ExternalAccount }>('/api/external/gmail/connect', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disconnectGmail: (accountId) =>
    requestJson<{ account: ExternalAccount }>('/api/external/gmail/disconnect', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  syncGmailNow: (accountId) =>
    requestJson<GmailSyncResult>('/api/external/gmail/sync', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
};
