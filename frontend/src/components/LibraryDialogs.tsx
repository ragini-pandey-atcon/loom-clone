import { useEffect, useRef, useState } from 'react';

import { api, type Folder, type Video } from '../api/client';
import { IconFolder, IconFolderPlus, IconVideo } from './Icons';
import { toast } from './ui';

/** A modal <dialog> that opens while `open` is true. */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

/** One text field: rename a video, name or rename a folder. */
export function TextDialog({
  open,
  title,
  label,
  initial,
  submitLabel,
  maxLength,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  maxLength: number;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const ref = useModal(open);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="text-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!value.trim() || busy) return;
            setBusy(true);
            try {
              await onSave(value.trim());
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 id="text-dialog-title">{title}</h2>
          <div className="field">
            <label className="field-label" htmlFor="text-dialog-input">
              {label}
            </label>
            <input
              id="text-dialog-input"
              className="input"
              value={value}
              maxLength={maxLength}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!value.trim() || busy}>
              {submitLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** Move a video into a folder, back to My videos, or into a folder made right here. */
export function MoveDialog({
  video,
  folders,
  onClose,
  onMoved,
}: {
  video: Video | null;
  folders: Folder[];
  onClose: () => void;
  onMoved: (video: Video, folderName: string | null) => void;
}) {
  const ref = useModal(video !== null);
  const [target, setTarget] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (video) {
      setTarget(video.folderId ?? '');
      setNewName('');
    }
  }, [video]);

  async function move() {
    if (!video) return;
    setBusy(true);
    try {
      let folderId: string | null = target === '' ? null : target;
      let name = folders.find((f) => f.id === folderId)?.name ?? null;
      if (target === 'new') {
        const created = await api.createFolder(newName.trim());
        folderId = created.id;
        name = created.name;
      }
      const updated = await api.patchVideo(video.id, { folderId });
      onMoved(updated, name);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The video was not moved', 'error');
    } finally {
      setBusy(false);
    }
  }

  const unchanged = target === (video?.folderId ?? '');
  const canMove = !busy && !unchanged && (target !== 'new' || newName.trim().length > 0);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="move-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {video && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canMove) void move();
          }}
        >
          <h2 id="move-title">Move "{video.title}"</h2>
          <div className="move-list" role="radiogroup" aria-label="Destination">
            <label className="move-option">
              <input type="radio" name="dest" checked={target === ''} onChange={() => setTarget('')} />
              <IconVideo />
              <span>My videos</span>
              <span className="muted">No folder</span>
            </label>
            {folders.map((f) => (
              <label key={f.id} className="move-option">
                <input type="radio" name="dest" checked={target === f.id} onChange={() => setTarget(f.id)} />
                <IconFolder />
                <span>{f.name}</span>
                <span className="muted">{f.videoCount}</span>
              </label>
            ))}
            <label className="move-option">
              <input type="radio" name="dest" checked={target === 'new'} onChange={() => setTarget('new')} />
              <IconFolderPlus />
              <span>New folder</span>
            </label>
            {target === 'new' && (
              <input
                className="input"
                aria-label="New folder name"
                placeholder="Folder name"
                value={newName}
                maxLength={100}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
              />
            )}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canMove}>
              Move
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
