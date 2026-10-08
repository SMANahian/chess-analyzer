// "Delete all data": a button that opens a confirmation dialog naming what will be lost, with Cancel
// first (and focused), a "Download a backup first" action, and the destructive button last. Used by
// Settings and by the app's crash-recovery screen, so it never relies on the toast host or on the
// training views (which may be what crashed).
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import * as store from '../../state/store';
import { blockKeyRepeat, isDeliberateClick } from './buttons';
import { friendlyError } from './errors';
import { isoDate, plural } from './format';
import { downloadBlob } from './hooks';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { safeRead } from './safe';

export interface DataSummary {
  games: number;
  leaks: number;
  /** Positions with a training history. */
  reviews: number;
  scouts: number;
}

/** What "Delete all data" removes, as list items (counts that are 0 are left out). */
export function deleteSummary(s: DataSummary): string[] {
  return [
    'your accounts and profile',
    s.games > 0 ? `${plural(s.games, 'downloaded game')}` : '',
    s.leaks > 0 ? `${plural(s.leaks, 'leak')} found by the analysis` : '',
    s.reviews > 0 ? `your training history (${plural(s.reviews, 'position')} in training)` : 'your training history',
    s.scouts > 0 ? `${plural(s.scouts, 'scouted player')} and their games` : '',
    'your settings',
  ].filter(Boolean);
}

function currentSummary(): DataSummary {
  return {
    games: safeRead(() => store.games.value.length, 0),
    leaks: safeRead(() => store.mistakes.value.length, 0),
    reviews: safeRead(() => store.reviews.value.size, 0),
    scouts: safeRead(() => store.scoutProfiles.value.length, 0),
  };
}

export interface DeleteAllDataProps {
  /** After the data was deleted (navigate home, or reload). */
  onDeleted(): void;
  /** Classes of the opening button, default 'btn btn-outline-danger'. */
  class?: string;
}

export function DeleteAllData({ onDeleted, class: cls = 'btn btn-outline-danger' }: DeleteAllDataProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<'backup' | 'delete' | null>(null);
  const [status, setStatus] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const openedAt = useRef(0);

  const show = (): void => {
    openedAt.current = Date.now();
    setStatus(null);
    setOpen(true);
  };
  const close = (): void => {
    if (pending !== 'delete') setOpen(false);
  };
  const backup = async (): Promise<void> => {
    setPending('backup');
    setStatus(null);
    try {
      const blob = await store.exportData();
      downloadBlob(blob, `chess-analyzer-backup-${isoDate(Date.now())}.json`);
      setStatus({ tone: 'ok', text: 'Backup downloaded. Keep the file to restore everything later (Settings → Restore backup).' });
    } catch (err) {
      const e = friendlyError(err);
      setStatus({ tone: 'error', text: `The backup couldn’t be made: ${e.text}` });
    } finally {
      setPending(null);
    }
  };
  const confirm = async (e: MouseEvent): Promise<void> => {
    // The second click of a double-click on "Delete all data" (or a held-down Enter) must not land here.
    if (pending || !isDeliberateClick(openedAt.current, Date.now(), e.detail)) return;
    setPending('delete');
    setStatus(null);
    try {
      await store.clearData();
    } catch (err) {
      const f = friendlyError(err);
      setStatus({ tone: 'error', text: `Nothing was deleted: ${f.text}` });
      setPending(null);
      return;
    }
    setPending(null);
    setOpen(false);
    onDeleted();
  };

  const items = open ? deleteSummary(currentSummary()) : [];
  return (
    <>
      <button type="button" class={cls} onClick={show} onKeyDown={blockKeyRepeat} aria-haspopup="dialog">
        <Icon name="trash" size={18} /> Delete all data
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Delete all data?"
        actions={
          <>
            <button type="button" class="btn" autoFocus onClick={close} onKeyDown={blockKeyRepeat} disabled={pending === 'delete'}>
              Cancel
            </button>
            <button type="button" class="btn btn-danger" onClick={e => void confirm(e)} onKeyDown={blockKeyRepeat} disabled={pending !== null}>
              <Icon name="trash" size={18} /> {pending === 'delete' ? 'Deleting…' : 'Delete everything'}
            </button>
          </>
        }
      >
        <div class="stack-sm delete-all">
          <p>This permanently removes from this browser:</p>
          <ul class="delete-all-list">
            {items.map(t => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p>
            <strong>It can’t be undone.</strong> Nothing is kept anywhere else, so a backup file is the only way to get it back.
          </p>
          <div>
            <button type="button" class="btn btn-sm" onClick={() => void backup()} disabled={pending !== null}>
              <Icon name="download" size={18} /> {pending === 'backup' ? 'Preparing…' : 'Download a backup first'}
            </button>
          </div>
          {status ? (
            <p class={status.tone === 'error' ? 'field-error' : 'small muted'} role={status.tone === 'error' ? 'alert' : 'status'}>
              {status.text}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
