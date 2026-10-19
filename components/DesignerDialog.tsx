'use client';

import { useEffect, useState } from 'react';
import type { Manifest } from '@/lib/types';
import { relTime } from './Library';

/** Publishing help for the designer, plus removing decks from the library. */
export default function DesignerDialog({
  manifest,
  adminKeyRequired,
  onClose,
  onChanged,
}: {
  manifest: Manifest;
  adminKeyRequired: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [key, setKey] = useState(() => {
    try {
      return localStorage.getItem('deck-studio:admin') || '';
    } catch {
      return '';
    }
  });
  const [state, setState] = useState<{ busy?: string; error?: string; done?: string }>({});
  const published = manifest.decks.filter((d) => d.id.startsWith('pub:'));

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const remove = async (deckId: string, name: string) => {
    if (adminKeyRequired && !key) return setState({ error: 'Enter the designer passcode first.' });
    if (!window.confirm(`Remove “${name}” from the deck library? Publishing it again from Figma brings it back.`)) return;
    setState({ busy: deckId });
    try {
      localStorage.setItem('deck-studio:admin', key);
    } catch {}
    const res = await fetch('/api/publish/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ deckId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setState({ error: json.error || 'Could not remove the deck.' });
    setState({ done: `Removed “${name}”.` });
    onChanged();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-label="For designers">
        <h2>Add decks to the library</h2>
        <ol className="steps">
          <li>
            <a href="/deck-studio-plugin.zip" download>
              Download the Figma plugin
            </a>{' '}
            and unzip it. If you installed an earlier version, replace those files with the new ones.
          </li>
          <li>
            In the Figma desktop app, open any design file and choose <strong>Plugins → Development → Import plugin from manifest…</strong>, then pick{' '}
            <code>manifest.json</code> (one time).
          </li>
          <li>
            Open a deck, press <strong>⌘ /</strong> (Ctrl / on Windows), run <strong>Deck Studio – Publish</strong>, enter the designer passcode and press{' '}
            <strong>Publish</strong>.
          </li>
        </ol>
        <p className="hint">
          A new deck name adds a deck to the library; an existing name updates that deck. Layouts are exported exactly as designed — nothing in the Figma
          file changes.
        </p>

        {published.length > 0 && (
          <>
            <h3 className="sub">In the library</h3>
            <div className="deck-list">
              {published.map((d) => (
                <div key={d.id} className="deck-row">
                  <span>
                    {d.name}{' '}
                    <em>
                      · {d.slides.length} slides{d.updatedAt ? ` · ${relTime(d.updatedAt)}` : ''}
                    </em>
                  </span>
                  <button className="link" onClick={() => remove(d.id, d.name)} disabled={!!state.busy}>
                    {state.busy === d.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ))}
            </div>
            {adminKeyRequired && (
              <label className="field">
                <span>Designer passcode (needed to remove a deck)</span>
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
              </label>
            )}
          </>
        )}

        {state.error && <p className="hint error">{state.error}</p>}
        {state.done && <pre className="done">{state.done}</pre>}

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
