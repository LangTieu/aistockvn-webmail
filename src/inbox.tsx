import React, { useCallback, useEffect, useState } from 'react';
import {
  MAX_BATCH_SELECTION,
  batchMessages,
  fetchMessage,
  fetchMessages,
  fetchStarred,
  fetchThread,
  fetchThreads,
  markMessageRead,
  setStarred,
  type BatchAction,
  type MessageItem,
  type ThreadItem,
} from './api';

export interface ReplyTarget {
  to: string;
  subject: string;
  replyToId: string;
}

interface ViewProps {
  onReply: (target: ReplyTarget) => void;
}

type Folder = 'inbox' | 'sent' | 'spam';
type Mode = 'list' | 'threads';

const FOLDERS: Folder[] = ['inbox', 'sent', 'spam'];
const BATCH_BUTTONS: { action: BatchAction; label: string }[] = [
  { action: 'read', label: 'Mark read' },
  { action: 'unread', label: 'Mark unread' },
  { action: 'star', label: 'Star' },
  { action: 'unstar', label: 'Unstar' },
  { action: 'spam', label: 'Move to spam' },
];

function formatDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function displayName(addr?: { address?: string; name?: string } | null): string {
  if (!addr) return '(unknown)';
  return addr.name?.trim() || addr.address?.trim() || '(unknown)';
}

const StarIcon: React.FC<{ filled: boolean }> = ({ filled }) => (
  <span aria-hidden="true" className={filled ? 'text-amber-500' : 'text-gray-300'}>
    {filled ? '\u2605' : '\u2606'}
  </span>
);

const Spinner: React.FC = () => (
  <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
);

const ErrorBox: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="m-4 p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md flex items-center justify-between gap-3">
    <span>{message}</span>
    <button type="button" onClick={onRetry} className="text-red-700 underline shrink-0">
      Retry
    </button>
  </div>
);

/* ---------------- reading pane ---------------- */

interface ReadingPaneProps {
  messages: (MessageItem & Record<string, any>)[];
  onBack: () => void;
  onReply: (target: ReplyTarget) => void;
  onToggleStar: (msg: MessageItem) => void;
}

const ReadingPane: React.FC<ReadingPaneProps> = ({ messages, onBack, onReply, onToggleStar }) => {
  const first = messages[0];
  if (!first) return null;
  const stacked = messages.length > 1;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200">
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back
        </button>
        <h2 className="flex-1 truncate text-base font-semibold text-gray-900">
          {first.subject || '(No subject)'}
        </h2>
        {stacked && (
          <span className="text-xs text-gray-500 shrink-0">{messages.length} messages</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-gray-200">
        {messages.map((msg) => (
          <article key={msg.id} className="px-4 py-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {displayName(msg.from)}
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    &lt;{msg.from?.address}&gt;
                  </span>
                </p>
                <p className="text-xs text-gray-500">
                  To {((msg.to ?? []) as { address: string }[]).map((t) => t.address).join(', ')}
                </p>
              </div>
              <span className="text-xs text-gray-400 shrink-0">{formatDate(msg.date)}</span>
              <button
                type="button"
                aria-label={msg.isStarred ? 'Unstar message' : 'Star message'}
                onClick={() => onToggleStar(msg)}
                className="text-lg leading-none px-1"
              >
                <StarIcon filled={!!msg.isStarred} />
              </button>
            </div>

            <div className="mt-3 text-sm text-gray-800">
              {msg.html ? (
                <iframe
                  title="Message body"
                  srcDoc={msg.html}
                  sandbox=""
                  className="w-full min-h-[16rem] border border-gray-200 rounded"
                />
              ) : (
                <pre className="whitespace-pre-wrap font-sans break-words">{msg.text || ''}</pre>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  onReply({
                    to: msg.from?.address ?? '',
                    subject:
                      msg.subject && /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject ?? ''}`,
                    replyToId: msg.id,
                  })
                }
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
              >
                Reply
              </button>
              {msg.hasAttachments && (
                <span className="text-xs text-gray-500">Has attachments</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
};

/* ---------------- list row ---------------- */

interface RowProps {
  msg: MessageItem;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleStar: (msg: MessageItem) => void;
  onOpen: (msg: MessageItem) => void;
}

const MessageRow: React.FC<RowProps> = ({ msg, selected, onToggleSelect, onToggleStar, onOpen }) => {
  const bold = !msg.isRead;
  return (
    <li className={`flex items-start gap-3 px-4 py-3 ${selected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(msg.id)}
        aria-label={`Select message from ${displayName(msg.from)}`}
        className="mt-1"
      />
      <button
        type="button"
        onClick={() => onOpen(msg)}
        className="flex-1 min-w-0 text-left"
      >
        <div className="flex items-baseline gap-2">
          <span className={`flex-1 truncate text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
            {msg.folder === 'sent'
              ? `To: ${((msg.to ?? []) as { address: string; name?: string }[])
                  .map((t) => t.name || t.address)
                  .join(', ')}`
              : displayName(msg.from)}
          </span>
          {msg.source === 'gmail' && msg.mailboxAddress && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 shrink-0">
              {msg.mailboxAddress}
            </span>
          )}
          <span className={`shrink-0 text-xs ${bold ? 'font-bold text-blue-700' : 'text-gray-400'}`}>
            {formatDate(msg.date)}
          </span>
        </div>
        <div className={`truncate text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
          {msg.subject || '(No subject)'}
        </div>
        <div className="flex items-center gap-1 text-sm text-gray-500">
          <span className="flex-1 truncate">{msg.snippet}</span>
          {msg.hasAttachments && <span aria-hidden="true">{"\u{1F4CE}"}</span>}
          {msg.isFocused && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 shrink-0">
              Focused
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        aria-label={msg.isStarred ? 'Unstar message' : 'Star message'}
        onClick={() => onToggleStar(msg)}
        className="text-lg leading-none px-1 mt-0.5"
      >
        <StarIcon filled={!!msg.isStarred} />
      </button>
    </li>
  );
};

/* ---------------- shared list shell ---------------- */

interface ThreadListProps {
  threads: ThreadItem[];
  selected: Set<string>;
  onToggleThread: (thread: ThreadItem) => void;
  onToggleStar: (thread: ThreadItem) => void;
  onOpen: (thread: ThreadItem) => void;
}

const ThreadRow: React.FC<ThreadListProps & { thread: ThreadItem }> = ({
  thread,
  selected,
  onToggleThread,
  onToggleStar,
  onOpen,
}) => {
  const ids = thread.ids ?? (thread.latestId ? [thread.latestId] : []);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <li
      className={`flex items-start gap-3 px-4 py-3 ${allSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
    >
      <input
        type="checkbox"
        checked={allSelected}
        onChange={() => onToggleThread(thread)}
        aria-label={`Select thread ${thread.subject || '(No subject)'}`}
        className="mt-1"
      />
      <button type="button" onClick={() => onOpen(thread)} className="flex-1 min-w-0 text-left">
        <div className="flex items-baseline gap-2">
          <span className="flex-1 truncate text-sm font-semibold text-gray-900">
            {thread.subject || '(No subject)'}
          </span>
          <span className="shrink-0 text-xs text-gray-400">{formatDate(thread.latestDate)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="truncate">{thread.participants.join(', ')}</span>
          <span className="shrink-0">{thread.count} messages</span>
          {thread.unreadCount > 0 && (
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-blue-600 text-white">
              {thread.unreadCount} unread
            </span>
          )}
          {thread.starred && <StarIcon filled />}
        </div>
        <div className="truncate text-sm text-gray-500">{thread.snippet}</div>
      </button>
      <button
        type="button"
        aria-label={thread.starred ? 'Unstar thread' : 'Star thread'}
        onClick={() => onToggleStar(thread)}
        className="text-lg leading-none px-1 mt-0.5"
      >
        <StarIcon filled={!!thread.starred} />
      </button>
    </li>
  );
};

/* ---------------- inbox ---------------- */

export const InboxView: React.FC<ViewProps> = ({ onReply }) => {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [mode, setMode] = useState<Mode>('list');
  const [items, setItems] = useState<MessageItem[]>([]);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<(MessageItem & Record<string, any>)[] | null>(null);

  const load = useCallback(
    async (reset = true) => {
      setLoading(true);
      setError(null);
      try {
        if (mode === 'threads') {
          const res = await fetchThreads(folder);
          setThreads(res.threads);
          setNext(null);
        } else {
          const res = await fetchMessages({
            folder,
            before: reset ? undefined : next ?? undefined,
          });
          setItems(reset ? res.items : (prev) => [...prev, ...res.items]);
          setNext(res.nextBefore);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load messages');
      } finally {
        setLoading(false);
      }
    },
    [folder, mode, next]
  );

  useEffect(() => {
    setSelected(new Set());
    setOpen(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, mode]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      }
      if (prev.size >= MAX_BATCH_SELECTION) {
        setNotice(`You can select at most ${MAX_BATCH_SELECTION} messages per batch.`);
        return prev;
      }
      const copy = new Set(prev);
      copy.add(id);
      return copy;
    });
  };

  const toggleThread = (thread: ThreadItem) => {
    const ids = thread.ids ?? (thread.latestId ? [thread.latestId] : []);
    setSelected((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const copy = new Set(prev);
      if (allSelected) {
        for (const id of ids) copy.delete(id);
        return copy;
      }
      for (const id of ids) {
        if (copy.size >= MAX_BATCH_SELECTION && !copy.has(id)) {
          setNotice(`You can select at most ${MAX_BATCH_SELECTION} messages per batch.`);
          break;
        }
        copy.add(id);
      }
      return copy;
    });
  };

  const pageIds: string[] =
    mode === 'threads'
      ? threads.flatMap((t) => t.ids ?? (t.latestId ? [t.latestId] : []))
      : items.map((m) => m.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) return new Set<string>();
      const copy = new Set(prev);
      for (const id of pageIds) {
        if (copy.size >= MAX_BATCH_SELECTION && !copy.has(id)) {
          setNotice(`Selected the first ${MAX_BATCH_SELECTION} messages (client limit).`);
          break;
        }
        copy.add(id);
      }
      return copy;
    });
  };

  const runBatch = async (action: BatchAction) => {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await batchMessages(Array.from(selected), action);
      setNotice(`${res.updated} message${res.updated === 1 ? '' : 's'} updated.`);
      setSelected(new Set());
      if (action === 'spam') setFolder('spam');
      else await load(true);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Batch failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleStar = async (msg: MessageItem) => {
    try {
      const res = await setStarred(msg.id, !msg.isStarred);
      const apply = (m: MessageItem) => (m.id === msg.id ? { ...m, isStarred: res.is_starred } : m);
      setItems((prev) => (res.is_starred ? prev.map(apply) : prev.filter((m) => m.id !== msg.id)));
      setOpen((prev) => (prev ? prev.map((m) => apply(m) as typeof m) : prev));
      setThreads((prev) =>
        prev.map((t) => {
          if (!(t.ids ?? []).includes(msg.id) && t.latestId !== msg.id) return t;
          return { ...t, starred: res.is_starred };
        })
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to update star');
    }
  };

  const toggleThreadStar = async (thread: ThreadItem) => {
    const ids = thread.ids ?? (thread.latestId ? [thread.latestId] : []);
    if (ids.length === 0) return;
    try {
      const target = !thread.starred;
      let updated = 0;
      for (const id of ids) {
        await setStarred(id, target);
        updated += 1;
      }
      setThreads((prev) =>
        prev.map((t) => (t.threadKey === thread.threadKey ? { ...t, starred: target } : t))
      );
      setItems((prev) =>
        prev.map((m) => (ids.includes(m.id) ? { ...m, isStarred: target } : m))
      );
      setNotice(`${updated} message${updated === 1 ? '' : 's'} updated.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to update star');
    }
  };

  const openMessage = async (msg: MessageItem) => {
    try {
      const detail = await fetchMessage(msg.id);
      setOpen([detail as MessageItem & Record<string, any>]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to open message');
    }
  };

  const openThread = async (thread: ThreadItem) => {
    try {
      const res = await fetchThread(thread.threadKey);
      setOpen(res.messages);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to open thread');
    }
  };

  const handleOpenItem = (msg: MessageItem) => {
    void openMessage(msg);
    void markMessageRead(msg.id, true).catch(() => undefined);
  };

  const batchBar = selected.size > 0 && (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 bg-blue-50">
      <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
      {BATCH_BUTTONS.map((btn) => (
        <button
          key={btn.action}
          type="button"
          disabled={busy}
          onClick={() => void runBatch(btn.action)}
          className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
        >
          {btn.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setSelected(new Set())}
        className="ml-auto text-xs text-gray-500 hover:text-gray-800"
      >
        Clear
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mr-2">Inbox</h2>
        {FOLDERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFolder(f)}
            className={`px-2.5 py-1 text-sm rounded-md capitalize ${
              folder === f ? 'bg-gray-100 font-semibold text-gray-900' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f}
          </button>
        ))}
        <div className="ml-auto inline-flex rounded-md border border-gray-300 overflow-hidden">
          {(['list', 'threads'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-sm capitalize ${
                mode === m ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && (
        <div className="mx-4 mt-2 p-2 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded flex items-center justify-between gap-2">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-gray-500">
            Dismiss
          </button>
        </div>
      )}

      {batchBar}

      {open ? (
        <ReadingPane
          messages={open}
          onBack={() => setOpen(null)}
          onReply={onReply}
          onToggleStar={(msg) => void toggleStar(msg)}
        />
      ) : (
        <>
          {error && <ErrorBox message={error} onRetry={() => void load(true)} />}

          {mode === 'list' && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                aria-label="Select all messages on this page"
              />
              <span className="text-xs text-gray-500">Select all on this page</span>
            </div>
          )}

          {mode === 'threads' && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                aria-label="Select all threads on this page"
              />
              <span className="text-xs text-gray-500">Select all on this page</span>
            </div>
          )}

          {loading && items.length === 0 && threads.length === 0 ? (
            <Spinner />
          ) : mode === 'list' ? (
            items.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">No messages.</p>
            ) : (
              <ul className="divide-y divide-gray-200 overflow-y-auto flex-1">
                {items.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    selected={selected.has(msg.id)}
                    onToggleSelect={toggleSelect}
                    onToggleStar={(m) => void toggleStar(m)}
                    onOpen={handleOpenItem}
                  />
                ))}
              </ul>
            )
          ) : threads.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-500">No conversations.</p>
          ) : (
            <ul className="divide-y divide-gray-200 overflow-y-auto flex-1">
              {threads.map((thread) => (
                <ThreadRow
                  key={thread.threadKey}
                  thread={thread}
                  threads={threads}
                  selected={selected}
                  onToggleThread={toggleThread}
                  onToggleStar={(t) => void toggleThreadStar(t)}
                  onOpen={(t) => void openThread(t)}
                />
              ))}
            </ul>
          )}

          {mode === 'list' && next && (
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={loading}
              className="mx-auto my-4 block rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:text-gray-400"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
};

/* ---------------- starred ---------------- */

export const StarredView: React.FC<ViewProps> = ({ onReply }) => {
  const [items, setItems] = useState<MessageItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<(MessageItem & Record<string, any>)[] | null>(null);

  const load = useCallback(async (reset = true) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchStarred(reset ? undefined : next ?? undefined);
      setItems(reset ? res.items : (prev) => [...prev, ...res.items]);
      setNext(res.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load starred messages');
    } finally {
      setLoading(false);
    }
  }, [next]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.has(id)) {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      }
      if (prev.size >= MAX_BATCH_SELECTION) {
        setNotice(`You can select at most ${MAX_BATCH_SELECTION} messages per batch.`);
        return prev;
      }
      const copy = new Set(prev);
      copy.add(id);
      return copy;
    });
  };

  const pageIds = items.map((m) => m.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) return new Set<string>();
      const copy = new Set(prev);
      for (const id of pageIds) {
        if (copy.size >= MAX_BATCH_SELECTION && !copy.has(id)) {
          setNotice(`Selected the first ${MAX_BATCH_SELECTION} messages (client limit).`);
          break;
        }
        copy.add(id);
      }
      return copy;
    });
  };

  const runBatch = async (action: BatchAction) => {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await batchMessages(Array.from(selected), action);
      setNotice(`${res.updated} message${res.updated === 1 ? '' : 's'} updated.`);
      setSelected(new Set());
      if (action === 'spam' || action === 'unstar') {
        await load(true);
      } else {
        setItems((prev) =>
          prev.map((m) =>
            selected.has(m.id)
              ? {
                  ...m,
                  isStarred: action === 'star' ? true : m.isStarred,
                  isRead: action === 'read' ? true : action === 'unread' ? false : m.isRead,
                }
              : m
          )
        );
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Batch failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleStar = async (msg: MessageItem) => {
    try {
      const res = await setStarred(msg.id, !msg.isStarred);
      setItems((prev) =>
        res.is_starred ? prev.map((m) => (m.id === msg.id ? { ...m, isStarred: true } : m)) : prev.filter((m) => m.id !== msg.id)
      );
      setOpen((prev) => (prev ? prev.filter((m) => m.id !== msg.id || res.is_starred) : prev));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to update star');
    }
  };

  const openMessage = async (msg: MessageItem) => {
    try {
      const detail = await fetchMessage(msg.id);
      setOpen([detail as MessageItem & Record<string, any>]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to open message');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mr-2">Starred</h2>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="ml-auto px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && (
        <div className="mx-4 mt-2 p-2 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded flex items-center justify-between gap-2">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-gray-500">
            Dismiss
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 bg-blue-50">
          <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
          {BATCH_BUTTONS.map((btn) => (
            <button
              key={btn.action}
              type="button"
              disabled={busy}
              onClick={() => void runBatch(btn.action)}
              className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              {btn.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-gray-500 hover:text-gray-800"
          >
            Clear
          </button>
        </div>
      )}

      {open ? (
        <ReadingPane
          messages={open}
          onBack={() => setOpen(null)}
          onReply={onReply}
          onToggleStar={(msg) => void toggleStar(msg)}
        />
      ) : (
        <>
          {error && <ErrorBox message={error} onRetry={() => void load(true)} />}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              aria-label="Select all starred messages on this page"
            />
            <span className="text-xs text-gray-500">Select all on this page</span>
          </div>

          {loading && items.length === 0 ? (
            <Spinner />
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-500">No starred messages.</p>
          ) : (
            <ul className="divide-y divide-gray-200 overflow-y-auto flex-1">
              {items.map((msg) => (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  selected={selected.has(msg.id)}
                  onToggleSelect={toggleSelect}
                  onToggleStar={(m) => void toggleStar(m)}
                  onOpen={(m) => {
                    void openMessage(m);
                    void markMessageRead(m.id, true).catch(() => undefined);
                  }}
                />
              ))}
            </ul>
          )}

          {next && (
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={loading}
              className="mx-auto my-4 block rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:text-gray-400"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default InboxView;