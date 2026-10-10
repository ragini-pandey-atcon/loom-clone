import { useEffect, useRef, useState } from 'react';

import { displayName, setDisplayName } from '../lib/identity';

/**
 * Asks for a display name the first time someone comments or reacts. Kept in this browser only.
 * `onDone` receives the name, or null when the dialog was dismissed.
 */
export function NamePrompt({ open, onDone }: { open: boolean; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(displayName() ?? '');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValue(displayName() ?? '');
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const trimmed = value.trim();

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="name-title"
      onCancel={(e) => {
        e.preventDefault();
        onDone(null);
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          setDisplayName(trimmed);
          onDone(trimmed);
        }}
      >
        <h2 id="name-title">What's your name?</h2>
        <p>It appears next to your comments and reactions. This browser remembers it.</p>
        <div className="field">
          <label className="field-label" htmlFor="display-name">
            Display name
          </label>
          <input
            id="display-name"
            className="input"
            value={value}
            maxLength={60}
            autoComplete="name"
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!trimmed}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}
