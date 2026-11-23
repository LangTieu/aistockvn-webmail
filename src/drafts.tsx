import React, { useState } from 'react';
import type { DraftItem } from './api';

interface DraftsViewProps {
  drafts: DraftItem[];
  loading: boolean;
  error: string | null;
  onOpenDraft: (draft: DraftItem) => void;
  onDeleteDraft: (id: string) => Promise<void>;
  onRefresh: () => void;
}

function formatDraftTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const DraftsView: React.FC<DraftsViewProps> = ({
  drafts,
  loading,
  error,
  onOpenDraft,
  onDeleteDraft,
  onRefresh,
}) => {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await onDeleteDraft(id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Drafts</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">
          {error}
        </div>
      )}

      {!loading && drafts.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 p-8 text-center text-gray-500">
          <p className="text-sm font-medium">No saved drafts.</p>
          <p className="mt-1 text-xs text-gray-400">
            Unfinished messages in Compose are saved automatically (up to 5 per mailbox).
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 overflow-y-auto flex-1">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              onClick={() => onOpenDraft(draft)}
              className="flex items-start justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                    Draft
                  </span>
                  <span className="text-sm font-medium text-gray-900 truncate">
                    {draft.to || '(No recipient)'}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-gray-800 truncate">
                  {draft.subject || '(No subject)'}
                </p>
                {draft.text && (
                  <p className="mt-0.5 text-xs text-gray-500 truncate">{draft.text}</p>
                )}
              </div>

              <div className="flex flex-col items-end gap-2 shrink-0">
                <span className="text-xs text-gray-400">
                  {formatDraftTime(draft.updatedAt)}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, draft.id)}
                  disabled={deletingId === draft.id}
                  className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {deletingId === draft.id ? 'Deleting…' : 'Discard'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
