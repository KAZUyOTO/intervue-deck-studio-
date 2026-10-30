'use client';

import { useEffect, useRef, useState } from 'react';
import type { Deck, Manifest } from '@/lib/types';
import { emptyValues, renderSlide } from '@/lib/render';
import { searchDecks, sortDecks } from '@/lib/decks';

export function relTime(iso?: string) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function Cover({ deck }: { deck: Deck }) {
  const first = deck.slides[0];
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!first || first.thumb || !ref.current) return;
    const dpr = window.devicePixelRatio || 1;
    renderSlide(ref.current, first, emptyValues(), (320 * dpr) / first.width).catch(() => setFailed(true));
  }, [first]);
  if (!first) return <div className="cover cover-empty">No slides</div>;
  return (
    <div className="cover" style={{ aspectRatio: `${first.width} / ${first.height}` }}>
      {first.thumb ? <img src={first.thumb} alt="" loading="lazy" /> : failed ? <span>Preview unavailable</span> : <canvas ref={ref} />}
    </div>
  );
}

export default function Library({
  manifest,
  onOpen,
  onDesigner,
}: {
  manifest: Manifest;
  onOpen: (deckId: string) => void;
  onDesigner: () => void;
}) {
  const [query, setQuery] = useState('');
  const matches = searchDecks(sortDecks(manifest.decks), query);

  return (
    <div className="library-page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Deck Studio
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={onDesigner}>
          For designers
        </button>
      </header>

      <main className="lib-main">
        <div className="lib-head">
          <div>
            <h1>Deck library</h1>
            <p>
              Pick a deck, add the client’s name and logo, and download a PDF.
              {manifest.source === 'demo' && ' No decks have been published yet — this is a demo deck.'}
            </p>
          </div>
          {manifest.decks.length > 1 && (
            <input
              type="search"
              className="search lib-search"
              placeholder="Search decks by name or slide text"
              aria-label="Search decks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
          )}
        </div>

        <div className="deck-grid">
          {matches.map(({ deck: d, inName, snippet, slide }) => (
            <button key={d.id} className="deck-card" onClick={() => onOpen(d.id)}>
              <Cover deck={d} />
              <span className="deck-card-meta">
                <strong>{d.name}</strong>
                <span>
                  {d.slides.length} {d.slides.length === 1 ? 'slide' : 'slides'}
                  {d.updatedAt ? ` · updated ${relTime(d.updatedAt)}` : ''}
                </span>
                {!inName && snippet && (
                  <span className="deck-card-hit">
                    Slide {slide}: “{snippet}”
                  </span>
                )}
              </span>
            </button>
          ))}
          {matches.length === 0 && <p className="hint">No decks match “{query}”.</p>}
        </div>
      </main>
    </div>
  );
}
