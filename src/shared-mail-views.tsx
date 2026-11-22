import { useCallback, useRef, useState, type ReactNode } from "react";

import { MAX_BATCH_SELECTION, type Addr, type BatchAction } from "./api";

export const BATCH_BUTTONS: { action: BatchAction; label: string }[] = [
  { action: "read", label: "Mark read" },
  { action: "unread", label: "Mark unread" },
  { action: "star", label: "Star" },
  { action: "unstar", label: "Unstar" },
  { action: "spam", label: "Move to spam" },
];

export function formatDate(ts: number, long = false) {
  const d = new Date(ts);
  const now = new Date();
  if (long) return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const addrLine = (list: Addr[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

const COLORS = ["bg-teal-600", "bg-sky-600", "bg-indigo-600", "bg-rose-600", "bg-amber-600", "bg-emerald-600", "bg-violet-600"];

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";

export function Avatar({ label, size = "md" }: { label?: string | null; size?: "sm" | "md" }) {
  const safeLabel = (label ?? "").trim();
  const ch = (safeLabel[0] || "?").toUpperCase();
  let h = 0;
  for (const c of safeLabel) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const dim = size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-base";
  return (
    <div className={`${COLORS[h % COLORS.length]} ${dim} flex shrink-0 items-center justify-center rounded-full font-semibold text-white`} aria-hidden>
      {ch}
    </div>
  );
}

export const Icon = ({ d, className = "h-5 w-5" }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export const I = {
  back: "M15 18l-6-6 6-6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  close: "M18 6L6 18M6 6l12 12",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  reply: "M9 17l-5-5 5-5M20 18v-2a4 4 0 00-4-4H4",
  forward: "M15 17l5-5-5-5M4 18v-2a4 4 0 014-4h12",
  clip: "M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48",
  logout: "M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
  unread: "M4 4h16v16H4zM4 4l8 8 8-8",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  mail: "M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  draft: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  bell: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  menu: "M3 12h18M3 6h18M3 18h18",
  check: "M20 6L9 17l-5-5",
  at: "M16 12a4 4 0 11-8 0 4 4 0 018 0zM16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  threads: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
};

export function StarIcon({ filled, className = "h-5 w-5" }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} ${filled ? "fill-amber-400 text-amber-500" : "fill-none text-slate-400 hover:text-amber-500"}`}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  className = "",
  spinning = false,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  className?: string;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 ${focusRing} ${className}`}
    >
      <Icon d={icon} className={spinning ? "h-5 w-5 animate-spin" : "h-5 w-5"} />
    </button>
  );
}

export function BatchBar({
  selectedCount,
  onAction,
  onClear,
  disabled = false,
}: {
  selectedCount: number;
  onAction: (action: BatchAction) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  if (selectedCount <= 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-200 bg-teal-50 px-4 py-2">
      <span className="mr-1 text-xs font-semibold text-teal-900">{selectedCount} selected</span>
      {BATCH_BUTTONS.map((btn) => (
        <button
          key={btn.action}
          type="button"
          disabled={disabled}
          onClick={() => onAction(btn.action)}
          className={`rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 ${focusRing}`}
        >
          {btn.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className={`ml-auto text-xs font-medium text-slate-500 hover:text-slate-900 ${focusRing}`}
      >
        Clear
      </button>
    </div>
  );
}

export function useBatchSelection({
  pageIds,
  onNotice,
  onBatch,
  onAfterBatch,
}: {
  pageIds: string[];
  onNotice: (message: string | null) => void;
  onBatch: (ids: string[], action: BatchAction) => Promise<{ updated: number }>;
  onAfterBatch?: () => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const toggleSelect = useCallback(
    (id: string) => {
      setSelected((prev) => {
        if (prev.has(id)) {
          const copy = new Set(prev);
          copy.delete(id);
          return copy;
        }
        if (prev.size >= MAX_BATCH_SELECTION) {
          onNotice(`You can select at most ${MAX_BATCH_SELECTION} messages per batch.`);
          return prev;
        }
        const copy = new Set(prev);
        copy.add(id);
        return copy;
      });
    },
    [onNotice],
  );

  const toggleSelectMany = useCallback(
    (ids: string[]) => {
      setSelected((prev) => {
        const allInGroup = ids.length > 0 && ids.every((id) => prev.has(id));
        const copy = new Set(prev);
        if (allInGroup) {
          for (const id of ids) copy.delete(id);
          return copy;
        }
        for (const id of ids) {
          if (copy.size >= MAX_BATCH_SELECTION && !copy.has(id)) {
            onNotice(`You can select at most ${MAX_BATCH_SELECTION} messages per batch.`);
            break;
          }
          copy.add(id);
        }
        return copy;
      });
    },
    [onNotice],
  );

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (allSelected) return new Set<string>();
      const copy = new Set(prev);
      for (const id of pageIds) {
        if (copy.size >= MAX_BATCH_SELECTION && !copy.has(id)) {
          onNotice(`Selected the first ${MAX_BATCH_SELECTION} messages (client limit).`);
          break;
        }
        copy.add(id);
      }
      return copy;
    });
  }, [allSelected, pageIds, onNotice]);

  const runBatch = useCallback(
    async (action: BatchAction) => {
      if (selected.size === 0) return;
      setBatchBusy(true);
      onNotice(null);
      const ids = Array.from(selected);
      try {
        const res = await onBatch(ids, action);
        onNotice(`${res.updated} message${res.updated === 1 ? "" : "s"} updated.`);
        setSelected(new Set());
        await onAfterBatch?.();
      } catch (e) {
        onNotice(e instanceof Error ? e.message : "Batch failed");
      } finally {
        setBatchBusy(false);
      }
    },
    [selected, onBatch, onAfterBatch, onNotice],
  );

  return {
    selected,
    batchBusy,
    allSelected,
    clearSelection,
    toggleSelect,
    toggleSelectMany,
    toggleSelectAll,
    runBatch,
  };
}

export function SelectableMailRow({
  highlighted,
  checked,
  onToggleSelect,
  selectAriaLabel,
  starred,
  starLabel,
  onToggleStar,
  children,
}: {
  highlighted: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  selectAriaLabel: string;
  starred: boolean;
  starLabel: string;
  onToggleStar: () => void;
  children: ReactNode;
}) {
  return (
    <li className={`flex items-start gap-3 px-4 py-3 ${highlighted ? "bg-teal-50" : "hover:bg-slate-50"}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggleSelect}
        aria-label={selectAriaLabel}
        className="mt-2.5 h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
      />
      {children}
      <button
        type="button"
        aria-label={starLabel}
        title={starLabel}
        onClick={onToggleStar}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-200/60 ${focusRing}`}
      >
        <StarIcon filled={starred} className="h-4 w-4" />
      </button>
    </li>
  );
}

export function MessageRowContent({
  id,
  avatarLabel,
  who,
  date,
  subject,
  snippet,
  hasAttachments,
  bold,
  isOpen,
}: {
  id: string;
  avatarLabel?: string | null;
  who: string;
  date: number;
  subject: string;
  snippet: string;
  hasAttachments?: boolean;
  bold: boolean;
  isOpen: boolean;
}) {
  return (
    <a
      href={`/m/${id}`}
      aria-current={isOpen ? "true" : undefined}
      className={`flex min-w-0 flex-1 gap-3 rounded ${focusRing}`}
    >
      <Avatar label={avatarLabel} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className={`min-w-0 truncate text-sm ${bold ? "font-bold text-slate-900" : "text-slate-600"}`}>{who}</span>
          <span className={`ml-auto shrink-0 text-xs ${bold ? "font-semibold text-teal-700" : "text-slate-500"}`}>{formatDate(date)}</span>
        </div>
        <div className={`truncate text-sm ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}>{subject || "(No subject)"}</div>
        <div className="flex items-center gap-1 text-sm text-slate-500">
          <span className="flex-1 truncate">{snippet}</span>
          {hasAttachments && <Icon d={I.clip} className="h-4 w-4 shrink-0" />}
        </div>
      </div>
    </a>
  );
}

export function MailBody({ html, text }: { html: string | null; text: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(false);
  const hasRemote = !!html && /<img[^>]+src=["']?https?:/i.test(html);

  if (!html) return <div className="text-base leading-relaxed break-words whitespace-pre-wrap text-slate-900">{text || "(Empty mail)"}</div>;

  const csp = `default-src 'none'; style-src 'unsafe-inline' https:; font-src https: data:; img-src data: ${showImages ? "https: http:" : ""};`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;color:#0f172a;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`;

  const resize = () => {
    const f = ref.current;
    const h = f?.contentDocument?.documentElement?.scrollHeight;
    if (f && h) f.style.height = `${h + 8}px`;
  };

  return (
    <div className="flex flex-col gap-3">
      {hasRemote && !showImages && (
        <button onClick={() => setShowImages(true)} className={`rounded-lg bg-slate-100 px-3 py-2 text-left text-sm text-slate-700 ${focusRing}`}>
          Images from external sources are hidden to protect your privacy. <span className="font-semibold text-teal-700">Show images</span>
        </button>
      )}
      <iframe
        key={String(showImages)}
        ref={ref}
        title="Message content"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        onLoad={() => {
          resize();
          setTimeout(resize, 500);
        }}
        className="block h-40 w-full border-0"
      />
    </div>
  );
}
