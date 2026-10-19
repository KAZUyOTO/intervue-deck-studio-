'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, LogoAsset, Manifest, Slide } from '@/lib/types';
import { emptyValues, isOverridden, missingFonts, rawText, renderSlide, type DeckValues, type LogoAlign } from '@/lib/render';
import { exportPdf, formatBytes } from '@/lib/pdf';
import { hydrateSlides, loadDeckFonts } from '@/lib/measure';
import Library, { relTime } from './Library';
import DesignerDialog from './DesignerDialog';

type DeckResponse = {
  manifest: Manifest;
  figmaConfigured: boolean;
  adminKeyRequired: boolean;
  storage: { ok: boolean; reason?: string };
};

type Selection = { type: 'text' | 'slot'; id: string } | null;
const LOGO_MIME = 'application/x-deck-logo';
const draftKey = (deckId: string) => `deck-studio:draft:${deckId}`;

const tokenLabel = (t: string) => (t === 'client' ? 'Client name' : t.charAt(0).toUpperCase() + t.slice(1).replace(/[-_]/g, ' '));
const slotLabel = (k: string) => (k === 'client' ? 'Client logo' : `${tokenLabel(k)} logo`);

/* ---------------- small pieces ---------------- */

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Thumb({ slide, values, active, index, onClick }: { slide: Slide; values: DeckValues; active: boolean; index: number; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useDebounced(values, 250);
  // Untouched slides show the picture Figma exported; edited ones are drawn live.
  const plain = Boolean(slide.thumb) && !slide.texts.some((t) => isOverridden(t, v)) && !slide.slots.some((s) => v.logos[s.key]);
  useEffect(() => {
    if (plain || !ref.current) return;
    const dpr = window.devicePixelRatio || 1;
    renderSlide(ref.current, slide, v, (168 * dpr) / slide.width).catch(() => {});
  }, [slide, v, plain]);
  return (
    <button className={`thumb ${active ? 'is-active' : ''}`} onClick={onClick} aria-label={`Slide ${index + 1}: ${slide.name}`}>
      <span className="thumb-num">{index + 1}</span>
      {plain ? (
        <img src={slide.thumb} alt="" style={{ aspectRatio: `${slide.width} / ${slide.height}` }} />
      ) : (
        <canvas ref={ref} style={{ aspectRatio: `${slide.width} / ${slide.height}` }} />
      )}
    </button>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* ---------------- editor ---------------- */

export default function Editor() {
  const [data, setData] = useState<DeckResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deckId, setDeckId] = useState<string>('');
  const [values, setValues] = useState<DeckValues>(emptyValues());
  const [slideIdx, setSlideIdx] = useState(0);
  const [selected, setSelected] = useState<Selection>(null);
  const [logos, setLogos] = useState<LogoAsset[]>([]);
  const [logoQuery, setLogoQuery] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dropSlot, setDropSlot] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone?: 'error' } | null>(null);
  const [exporting, setExporting] = useState<{ msg: string; pct: number } | null>(null);
  const [confirmExport, setConfirmExport] = useState<string[] | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [fontsMissing, setFontsMissing] = useState<string[]>([]);

  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const loadedDraft = useRef<string>('');

  const showToast = useCallback((msg: string, tone?: 'error') => {
    setToast({ msg, tone });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4000);
  }, []);

  /* ---- data ---- */
  const loadDeck = useCallback(async () => {
    try {
      const res = await fetch('/api/deck', { cache: 'no-store' });
      const json: DeckResponse = await res.json();
      // Figma Slides decks: work out text layers and logo spots in the browser.
      const decks = await Promise.all(json.manifest.decks.map(async (d) => ({ ...d, slides: await hydrateSlides(d.slides) })));
      json.manifest = { ...json.manifest, decks };
      // Load the deck's fonts (Google Fonts) so edited text matches Figma.
      const fonts = decks.flatMap((d) => d.slides.flatMap((s) => s.texts.filter((t) => t.editable)))
        .map((t) => ({ family: t.style.fontFamily, weight: t.style.fontWeight, italic: t.style.italic }));
      await loadDeckFonts(fonts);
      setData(json);
      const wanted = new URLSearchParams(window.location.search).get('deck') || '';
      setDeckId(json.manifest.decks.some((d) => d.id === wanted) ? wanted : '');
    } catch {
      setLoadError('Could not load the deck. Refresh to try again.');
    }
  }, []);

  const loadLogos = useCallback(async () => {
    try {
      const res = await fetch('/api/logos', { cache: 'no-store' });
      const json = await res.json();
      setLogos(json.logos || []);
    } catch {
      /* library stays empty */
    }
  }, []);

  useEffect(() => {
    loadDeck();
    loadLogos();
  }, [loadDeck, loadLogos]);

  // ?deck=… in the address bar, so a deck link can be shared and the back button works
  const openDeck = useCallback((id: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('deck', id);
    else url.searchParams.delete('deck');
    window.history.pushState(null, '', url);
    setDeckId(id);
  }, []);
  useEffect(() => {
    const pop = () => setDeckId(new URLSearchParams(window.location.search).get('deck') || '');
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const deck: Deck | undefined = data?.manifest.decks.find((d) => d.id === deckId);
  const slide = deck?.slides[Math.min(slideIdx, (deck?.slides.length || 1) - 1)];

  // restore + persist this deck's draft
  useEffect(() => {
    if (!deckId) return;
    try {
      const raw = localStorage.getItem(draftKey(deckId));
      setValues(raw ? { ...emptyValues(), ...JSON.parse(raw) } : emptyValues());
    } catch {
      setValues(emptyValues());
    }
    loadedDraft.current = deckId;
    setSlideIdx(0);
    setSelected(null);
  }, [deckId]);

  useEffect(() => {
    if (!deckId || loadedDraft.current !== deckId) return;
    try {
      localStorage.setItem(draftKey(deckId), JSON.stringify(values));
    } catch {
      /* private mode */
    }
  }, [values, deckId]);

  useEffect(() => {
    if (!deck || data?.manifest.source === 'demo') return setFontsMissing([]);
    // Only text that sales changed is redrawn, so only those layers need the font.
    const edited = deck.slides.map((s) => ({ ...s, texts: s.texts.filter((t) => isOverridden(t, values)) }));
    document.fonts.ready.then(() => setFontsMissing(missingFonts(edited)));
  }, [deck, data?.manifest.source, values]);

  const tokens = useMemo(() => {
    const set = new Set<string>();
    deck?.slides.forEach((s) => s.texts.forEach((t) => t.editable && t.tokens.forEach((k) => set.add(k))));
    return [...set].sort((a, b) => (a === 'client' ? -1 : b === 'client' ? 1 : a.localeCompare(b)));
  }, [deck]);

  const slotKeys = useMemo(() => {
    const map = new Map<string, number>();
    deck?.slides.forEach((s) => s.slots.forEach((sl) => map.set(sl.key, (map.get(sl.key) || 0) + 1)));
    return [...map.entries()].sort((a, b) => (a[0] === 'client' ? -1 : b[0] === 'client' ? 1 : a[0].localeCompare(b[0])));
  }, [deck]);

  /* ---- main canvas ---- */
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStageSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
    // the stage only exists while a deck is open, so re-attach whenever one is opened
  }, [data, deckId]);

  const fit = useMemo(() => {
    if (!slide || !stageSize.w) return { w: 0, h: 0 };
    const ar = slide.width / slide.height;
    const w = Math.min(stageSize.w, stageSize.h * ar);
    return { w: Math.floor(w), h: Math.floor(w / ar) };
  }, [slide, stageSize]);

  const renderSeq = useRef(0);
  useEffect(() => {
    if (!slide || !canvasRef.current || !fit.w) return;
    const seq = ++renderSeq.current;
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement('canvas');
    renderSlide(off, slide, values, (fit.w * dpr) / slide.width)
      .then(() => {
        if (seq !== renderSeq.current || !canvasRef.current) return;
        const c = canvasRef.current;
        c.width = off.width;
        c.height = off.height;
        c.getContext('2d')!.drawImage(off, 0, 0);
      })
      .catch((e) => showToast(e.message || 'Slide failed to render', 'error'));
  }, [slide, values, fit.w, showToast]);

  /* ---- editing ---- */
  const setVar = (k: string, v: string) => setValues((s) => ({ ...s, vars: { ...s.vars, [k]: v } }));
  const setText = (id: string, v: string) => setValues((s) => ({ ...s, text: { ...s.text, [id]: v } }));
  const resetText = (id: string) =>
    setValues((s) => {
      const text = { ...s.text };
      delete text[id];
      return { ...s, text };
    });
  const assignLogo = useCallback((key: string, logo: { url: string; name: string }) => {
    setValues((s) => ({ ...s, logos: { ...s.logos, [key]: logo } }));
  }, []);
  const setLogoSize = (key: string, size: number) => setValues((s) => ({ ...s, logoSize: { ...s.logoSize, [key]: size } }));
  const setLogoAlign = (key: string, align: LogoAlign) => setValues((s) => ({ ...s, logoAlign: { ...s.logoAlign, [key]: align } }));
  const clearLogo = (key: string) =>
    setValues((s) => {
      const l = { ...s.logos };
      delete l[key];
      return { ...s, logos: l };
    });

  const uploadFiles = useCallback(
    async (files: File[]): Promise<LogoAsset[]> => {
      const out: LogoAsset[] = [];
      for (const file of files) {
        setUploading((n) => n + 1);
        try {
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch('/api/logos', { method: 'POST', body: fd });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Upload failed');
          out.push(json.logo);
          setLogos((cur) => [json.logo, ...cur.filter((l) => l.pathname !== json.logo.pathname)]);
          if (json.duplicate) showToast(`"${json.logo.name}" is already in the library`);
        } catch (e: any) {
          showToast(e.message || 'Upload failed', 'error');
        } finally {
          setUploading((n) => n - 1);
        }
      }
      return out;
    },
    [showToast],
  );

  const handleDrop = async (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropSlot(null);
    setDragging(false);
    const raw = e.dataTransfer.getData(LOGO_MIME);
    if (raw) {
      assignLogo(key, JSON.parse(raw));
      return;
    }
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || f.name.endsWith('.svg'));
    if (!files.length) return;
    const [first] = await uploadFiles(files);
    if (first) assignLogo(key, { url: first.url, name: first.name });
  };

  const selectText = (id: string) => {
    setSelected({ type: 'text', id });
    requestAnimationFrame(() => {
      const el = fieldRefs.current[id];
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.focus();
    });
  };

  // ← → between slides (outside text fields)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || !deck) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setSlideIdx((i) => Math.min(i + 1, deck.slides.length - 1));
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setSlideIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [deck]);

  // highlight drop targets while anything is dragged over the window
  useEffect(() => {
    let depth = 0;
    const enter = () => {
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
      window.removeEventListener('dragover', stop);
    };
  }, []);

  /* ---- export ---- */
  const missingBeforeExport = () => {
    const out: string[] = [];
    tokens.forEach((t) => !values.vars[t]?.trim() && out.push(tokenLabel(t)));
    slotKeys.forEach(([k, n]) => !values.logos[k] && out.push(`${slotLabel(k)} (${n} ${n === 1 ? 'spot' : 'spots'})`));
    return out;
  };

  const runExport = async () => {
    if (!deck) return;
    setConfirmExport(null);
    setExporting({ msg: 'Preparing', pct: 0 });
    try {
      const client = values.vars.client?.trim();
      const title = `${client ? client + ' – ' : ''}${deck.name}`;
      const { bytes, overLimit } = await exportPdf(deck, values, {
        title,
        onProgress: (msg, pct) => setExporting({ msg, pct }),
      });
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Deck'}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      showToast(
        overLimit
          ? `PDF downloaded · ${formatBytes(bytes.length)} — still over 3 MB, the slides are very image-heavy`
          : `PDF downloaded · ${formatBytes(bytes.length)}`,
        overLimit ? 'error' : undefined,
      );
    } catch (e: any) {
      showToast(e.message || 'Export failed', 'error');
    } finally {
      setExporting(null);
    }
  };

  const startExport = () => {
    const missing = missingBeforeExport();
    if (missing.length) setConfirmExport(missing);
    else runExport();
  };

  /* ---- render ---- */
  if (loadError) return <div className="center-msg">{loadError}</div>;
  if (!data) return <div className="center-msg">Loading decks…</div>;
  if (!deck || !slide) {
    return (
      <>
        <Library manifest={data.manifest} onOpen={openDeck} onDesigner={() => setSyncOpen(true)} />
        {syncOpen && (
          <DesignerDialog manifest={data.manifest} adminKeyRequired={data.adminKeyRequired} onClose={() => setSyncOpen(false)} onChanged={loadDeck} />
        )}
      </>
    );
  }

  const editableTexts = slide.texts.filter((t) => t.editable);
  const filteredLogos = logos.filter((l) => l.name.toLowerCase().includes(logoQuery.toLowerCase()));
  const changedCount = Object.keys(values.text).length + Object.keys(values.logos).length + Object.values(values.vars).filter(Boolean).length;
  const selectedSlotKey = selected?.type === 'slot' ? slide.slots.find((s) => s.id === selected.id)?.key : undefined;
  const pct = (n: number, of: number) => `${(n / of) * 100}%`;

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn ghost back" onClick={() => openDeck('')}>
          ← All decks
        </button>
        <span className="deck-name">{deck.name}</span>
        <span className="source">{deck.updatedAt ? `Updated ${relTime(deck.updatedAt)}` : data.manifest.source === 'demo' ? 'Demo deck' : ''}</span>
        <div className="spacer" />
        {changedCount > 0 && (
          <button
            className="btn ghost"
            onClick={() => {
              if (window.confirm('Clear all your edits on this deck?')) setValues(emptyValues());
            }}
          >
            Start over
          </button>
        )}
        <button className="btn primary" onClick={startExport} disabled={!!exporting}>
          {exporting ? 'Exporting…' : 'Download PDF'}
        </button>
      </header>

      <div className="workspace">
        <nav className="rail" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <Thumb key={s.id} slide={s} values={values} index={i} active={s.id === slide.id} onClick={() => setSlideIdx(i)} />
          ))}
        </nav>

        <section className="stage" ref={stageRef} onClick={() => setSelected(null)}>
          <div className="slide" style={{ width: fit.w, height: fit.h }}>
            <canvas ref={canvasRef} style={{ width: fit.w, height: fit.h }} />
            {editableTexts.map((t) => (
              <button
                key={t.id}
                className={`hit hit-text ${selected?.id === t.id ? 'is-selected' : ''}`}
                style={{ left: pct(t.box.x, slide.width), top: pct(t.box.y, slide.height), width: pct(t.box.w, slide.width), height: pct(t.box.h, slide.height) }}
                onClick={(e) => {
                  e.stopPropagation();
                  selectText(t.id);
                }}
                title={`Edit “${t.name}”`}
                aria-label={`Edit ${t.name}`}
              />
            ))}
            {slide.slots.map((s) => (
              <button
                key={s.id}
                className={`hit hit-slot ${dragging ? 'is-target' : ''} ${dropSlot === s.id ? 'is-over' : ''} ${selected?.id === s.id ? 'is-selected' : ''} ${values.logos[s.key] ? 'has-logo' : ''}`}
                style={{ left: pct(s.box.x, slide.width), top: pct(s.box.y, slide.height), width: pct(s.box.w, slide.width), height: pct(s.box.h, slide.height) }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setDropSlot(s.id);
                }}
                onDragLeave={() => setDropSlot((d) => (d === s.id ? null : d))}
                onDrop={(e) => handleDrop(e, s.key)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected({ type: 'slot', id: s.id });
                  document.getElementById('library')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }}
                title={`${slotLabel(s.key)} – drop a logo here`}
                aria-label={`${slotLabel(s.key)} drop zone`}
              >
                <span className="hit-label">Drop logo</span>
              </button>
            ))}
          </div>
          <div className="stage-foot">
            <span>
              Slide {slideIdx + 1} of {deck.slides.length} · {slide.name}
            </span>
          </div>
        </section>

        <aside className="panel">
          {tokens.length > 0 && (
            <div className="group">
              <h3>Client details</h3>
              <p className="hint">Fills in everywhere it appears in the deck.</p>
              {tokens.map((t) => (
                <label key={t} className="field">
                  <span>{tokenLabel(t)}</span>
                  <input
                    value={values.vars[t] || ''}
                    placeholder={t === 'client' ? 'e.g. Acme Corp' : ''}
                    onChange={(e) => setVar(t, e.target.value)}
                  />
                </label>
              ))}
            </div>
          )}

          {slotKeys.length > 0 && (
            <div className="group">
              <h3>Logos</h3>
              <p className="hint">
                Drag a logo from the library onto a dashed box on the slide, or drop an image file straight onto it. Use Size to make it bigger or
                smaller — it stays pinned to the same spot.
              </p>
              {slotKeys.map(([k, n]) => {
                const l = values.logos[k];
                return (
                  <div
                    key={k}
                    className={`assigned ${selectedSlotKey === k ? 'is-selected' : ''}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleDrop(e, k)}
                  >
                    <div className="assigned-thumb">{l ? <img src={l.url} alt="" /> : <span>Empty</span>}</div>
                    <div className="assigned-meta">
                      <strong>{slotLabel(k)}</strong>
                      <span>
                        {l ? l.name : 'Not set'} · {n} {n === 1 ? 'spot' : 'spots'}
                      </span>
                    </div>
                    {l && (
                      <button className="link" onClick={() => clearLogo(k)}>
                        Remove
                      </button>
                    )}
                    {l && (
                      <div className="logo-controls">
                        <label className="size-row">
                          <span>Size</span>
                          <input
                            type="range"
                            min={25}
                            max={300}
                            step={5}
                            value={Math.round((values.logoSize?.[k] ?? 1) * 100)}
                            onChange={(e) => setLogoSize(k, Number(e.target.value) / 100)}
                            aria-label={`${slotLabel(k)} size`}
                          />
                          <output>{Math.round((values.logoSize?.[k] ?? 1) * 100)}%</output>
                        </label>
                        <div className="seg" role="group" aria-label="Pin logo to">
                          {(['left', 'center', 'right'] as LogoAlign[]).map((a) => (
                            <button
                              key={a}
                              type="button"
                              className={(values.logoAlign?.[k] ?? 'center') === a ? 'is-on' : ''}
                              onClick={() => setLogoAlign(k, a)}
                              title={`Keep the logo pinned to the ${a === 'center' ? 'centre' : a} of its spot`}
                            >
                              {a === 'left' ? 'Left' : a === 'center' ? 'Centre' : 'Right'}
                            </button>
                          ))}
                        </div>
                        {(values.logoSize?.[k] ?? 1) !== 1 && (
                          <button type="button" className="link" onClick={() => setLogoSize(k, 1)}>
                            Reset size
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="group">
            <h3>Text on this slide</h3>
            {editableTexts.length === 0 && <p className="hint">Nothing editable on this slide.</p>}
            {editableTexts.map((t) => {
              const changed = values.text[t.id] !== undefined && values.text[t.id] !== t.characters;
              return (
                <label key={t.id} className={`field ${selected?.id === t.id ? 'is-selected' : ''}`}>
                  <span>
                    {t.name}
                    {changed && (
                      <button
                        type="button"
                        className="link"
                        onClick={(e) => {
                          e.preventDefault();
                          resetText(t.id);
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </span>
                  <textarea
                    ref={(el) => {
                      fieldRefs.current[t.id] = el;
                    }}
                    rows={Math.min(6, Math.max(1, rawText(t, values).split('\n').length))}
                    value={rawText(t, values)}
                    onFocus={() => setSelected({ type: 'text', id: t.id })}
                    onChange={(e) => setText(t.id, e.target.value)}
                  />
                  {t.mixed && isOverridden(t, values) && <em className="note">Mixed styling in Figma is simplified once edited.</em>}
                </label>
              );
            })}
          </div>

          <div className="group" id="library">
            <h3>
              Logo library <span className="count">{logos.length}</span>
            </h3>
            {selectedSlotKey && <p className="hint strong">Click a logo to use it as the {slotLabel(selectedSlotKey).toLowerCase()}.</p>}
            <label
              className={`dropzone ${uploading ? 'is-busy' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.getData(LOGO_MIME)) return;
                await uploadFiles([...e.dataTransfer.files]);
              }}
            >
              <input
                type="file"
                accept="image/png,image/svg+xml,image/jpeg,image/webp"
                multiple
                onChange={async (e) => {
                  const files = [...(e.target.files || [])];
                  e.target.value = '';
                  await uploadFiles(files);
                }}
              />
              {uploading ? `Uploading ${uploading}…` : 'Upload logos — PNG or SVG, drop here or click'}
            </label>
            {!data.storage.ok && <p className="hint error">{data.storage.reason}</p>}
            {logos.length > 6 && <input className="search" placeholder="Search logos" value={logoQuery} onChange={(e) => setLogoQuery(e.target.value)} />}
            <div className="library">
              {filteredLogos.map((l) => (
                <button
                  key={l.pathname}
                  className={`logo-tile ${Object.values(values.logos).some((v) => v.url === l.url) ? 'in-use' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(LOGO_MIME, JSON.stringify({ url: l.url, name: l.name }));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => {
                    const key = selectedSlotKey || (slotKeys.length === 1 ? slotKeys[0][0] : undefined);
                    if (key) assignLogo(key, { url: l.url, name: l.name });
                    else showToast('Drag the logo onto the box where it should go');
                  }}
                  title={l.name}
                >
                  <span className="logo-img">
                    <img src={l.url} alt="" loading="lazy" draggable={false} />
                  </span>
                  <span className="logo-name">{l.name}</span>
                </button>
              ))}
              {logos.length === 0 && <p className="hint">Every logo anyone uploads is saved here for the whole team.</p>}
              {logos.length > 0 && filteredLogos.length === 0 && <p className="hint">No logos match “{logoQuery}”.</p>}
            </div>
          </div>
        </aside>
      </div>

      {exporting && (
        <div className="modal-backdrop">
          <div className="modal progress">
            <h2>Building your PDF</h2>
            <p>{exporting.msg}</p>
            <div className="bar">
              <div style={{ width: `${Math.round(exporting.pct * 100)}%` }} />
            </div>
          </div>
        </div>
      )}

      {confirmExport && (
        <Modal title="Some things are still empty" onClose={() => setConfirmExport(null)}>
          <ul className="missing">
            {confirmExport.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setConfirmExport(null)}>
              Go back
            </button>
            <button className="btn primary" onClick={runExport}>
              Download anyway
            </button>
          </div>
        </Modal>
      )}

      {toast && <div className={`toast ${toast.tone === 'error' ? 'is-error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
