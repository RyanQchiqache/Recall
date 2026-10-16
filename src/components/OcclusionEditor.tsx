import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { newMaskId, type OcclusionMask } from '../../shared/notes.ts';
import type { MediaAsset } from '../../shared/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { cn } from '../lib/util.ts';
import { isLocalMedia } from './Markdown.tsx';
import { Button, IconButton } from './ui/Button.tsx';
import { Spinner } from './ui/Feedback.tsx';
import { Input } from './ui/Form.tsx';

const MIN = 0.01;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10000) / 10000;

type Drag =
  | { mode: 'draw'; x0: number; y0: number; id: string }
  | { mode: 'move'; id: string; dx: number; dy: number; orig: OcclusionMask }
  | { mode: 'resize'; id: string; corner: 'nw' | 'ne' | 'sw' | 'se'; orig: OcclusionMask };

/**
 * Draw, move, resize, label and delete boxes over a local image.
 * Pointer: drag on the image to draw, drag a box to move it, drag a corner to resize.
 * Keyboard: Tab to a box, arrows move it (Shift = larger steps), Alt+arrows resize, Delete removes.
 */
export function OcclusionEditor({
  image,
  masks,
  onImage,
  onMasks,
  onError,
}: {
  image: string;
  masks: OcclusionMask[];
  onImage: (url: string) => void;
  onMasks: (masks: OcclusionMask[]) => void;
  onError: (msg: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<OcclusionMask | null>(null);
  const [uploading, setUploading] = useState(false);
  const [announce, setAnnounce] = useState('');

  const point = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  const update = (id: string, patch: Partial<OcclusionMask>) => onMasks(masks.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const remove = (id: string) => {
    onMasks(masks.filter((m) => m.id !== id));
    setSelected(null);
    setAnnounce('Box deleted');
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const asset = await api.upload<MediaAsset>('/api/media', file, file.name || 'image.png');
      onImage(asset.url);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const addBox = () => {
    const offset = (masks.length % 6) * 0.04;
    const m: OcclusionMask = { id: newMaskId(), x: round(0.35 + offset), y: round(0.35 + offset), w: 0.2, h: 0.15, label: '' };
    onMasks([...masks, m]);
    setSelected(m.id);
    setAnnounce(`Box ${masks.length + 1} added`);
    requestAnimationFrame(() => document.getElementById(`mask-${m.id}`)?.focus());
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const maskId = target.closest('[data-mask]')?.getAttribute('data-mask');
    const corner = target.getAttribute('data-corner') as 'nw' | 'ne' | 'sw' | 'se' | null;
    const p = point(e);
    area.current!.setPointerCapture(e.pointerId);
    if (maskId) {
      const orig = masks.find((m) => m.id === maskId)!;
      setSelected(maskId);
      drag.current = corner ? { mode: 'resize', id: maskId, corner, orig } : { mode: 'move', id: maskId, dx: p.x - orig.x, dy: p.y - orig.y, orig };
    } else {
      const id = newMaskId();
      drag.current = { mode: 'draw', x0: p.x, y0: p.y, id };
      setDraft({ id, x: p.x, y: p.y, w: 0, h: 0, label: '' });
      setSelected(null);
    }
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.mode === 'draw') {
      setDraft({ id: d.id, x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0), label: '' });
    } else if (d.mode === 'move') {
      update(d.id, { x: round(clamp(p.x - d.dx, 0, 1 - d.orig.w)), y: round(clamp(p.y - d.dy, 0, 1 - d.orig.h)) });
    } else {
      const o = d.orig;
      let x1 = o.x;
      let y1 = o.y;
      let x2 = o.x + o.w;
      let y2 = o.y + o.h;
      if (d.corner.includes('w')) x1 = Math.min(p.x, x2 - MIN);
      if (d.corner.includes('e')) x2 = Math.max(p.x, x1 + MIN);
      if (d.corner.includes('n')) y1 = Math.min(p.y, y2 - MIN);
      if (d.corner.includes('s')) y2 = Math.max(p.y, y1 + MIN);
      update(d.id, { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    area.current?.releasePointerCapture?.(e.pointerId);
    if (d?.mode === 'draw' && draft) {
      setDraft(null);
      if (draft.w >= MIN * 2 && draft.h >= MIN * 2) {
        const m = { ...draft, x: round(draft.x), y: round(draft.y), w: round(draft.w), h: round(draft.h) };
        onMasks([...masks, m]);
        setSelected(m.id);
        setAnnounce(`Box ${masks.length + 1} added`);
      }
    }
  };

  const onMaskKey = (e: React.KeyboardEvent, m: OcclusionMask) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dx, dy] = arrows[e.key];
      if (e.altKey) update(m.id, { w: round(clamp(m.w + dx, MIN, 1 - m.x)), h: round(clamp(m.h + dy, MIN, 1 - m.y)) });
      else update(m.id, { x: round(clamp(m.x + dx, 0, 1 - m.w)), y: round(clamp(m.y + dy, 0, 1 - m.h)) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(m.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById(`mask-label-${m.id}`)?.focus();
    }
  };

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (!isLocalMedia(image)) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
        <p className="max-w-sm text-sm text-muted">Choose a diagram, slide or photo. You then draw boxes over the parts to hide; each box becomes its own card.</p>
        <Button variant="primary" loading={uploading} icon={<ImagePlus className="size-4" />} onClick={() => fileInput.current?.click()}>
          Choose image
        </Button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
    );
  }

  const all = draft ? [...masks, draft] : masks;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Plus className="size-4" />} onClick={addBox}>
          Add box
        </Button>
        <Button size="sm" variant="ghost" loading={uploading} icon={<ImagePlus className="size-4" />} onClick={() => fileInput.current?.click()}>
          Replace image
        </Button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
        <span className="text-[13px] text-muted">Drag on the image to draw a box. Arrow keys move the selected box (⇧ larger steps, ⌥ resize), Delete removes it.</span>
      </div>
      <div
        ref={area}
        className="relative inline-block max-w-full cursor-crosshair touch-none overflow-hidden rounded-xl border border-border select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img src={image} alt="Image to hide parts of" className="pointer-events-none block h-auto max-w-full" draggable={false} />
        {all.map((m, i) => {
          const isSel = m.id === selected;
          const isDraft = draft?.id === m.id;
          return (
            <div
              key={m.id}
              id={isDraft ? undefined : `mask-${m.id}`}
              data-mask={isDraft ? undefined : m.id}
              role={isDraft ? undefined : 'button'}
              tabIndex={isDraft ? -1 : 0}
              aria-label={`Box ${i + 1}${m.label ? `: ${m.label}` : ''}, at ${pct(m.x)} from the left and ${pct(m.y)} from the top, ${pct(m.w)} wide and ${pct(m.h)} high`}
              aria-pressed={isSel}
              onFocus={() => setSelected(m.id)}
              onKeyDown={(e) => onMaskKey(e, m)}
              className={cn(
                'absolute cursor-move rounded-[3px] border-2 focus:outline-none',
                isSel ? 'border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_45%,transparent)] ring-2 ring-white/70' : 'border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_30%,transparent)]',
                isDraft && 'border-dashed',
              )}
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
            >
              {!isDraft && (
                <span className="pointer-events-none absolute top-0.5 left-1 rounded bg-[var(--primary)] px-1 text-[11px] leading-4 font-bold text-white">{i + 1}</span>
              )}
              {isSel &&
                (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                  <span
                    key={c}
                    data-corner={c}
                    aria-hidden
                    className={cn(
                      'absolute size-3 rounded-sm border-2 border-[var(--primary)] bg-white',
                      c === 'nw' && '-top-1.5 -left-1.5 cursor-nwse-resize',
                      c === 'ne' && '-top-1.5 -right-1.5 cursor-nesw-resize',
                      c === 'sw' && '-bottom-1.5 -left-1.5 cursor-nesw-resize',
                      c === 'se' && '-right-1.5 -bottom-1.5 cursor-nwse-resize',
                    )}
                  />
                ))}
            </div>
          );
        })}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {masks.length > 0 && (
        <ol className="flex flex-col gap-1.5" aria-label="Boxes">
          {masks.map((m, i) => (
            <li key={m.id} className={cn('flex items-center gap-2 rounded-lg px-2 py-1', m.id === selected && 'bg-primary-soft')}>
              <span className="w-6 shrink-0 text-center text-sm font-semibold text-text-2 tabular-nums">{i + 1}</span>
              <Input
                id={`mask-label-${m.id}`}
                aria-label={`Answer for box ${i + 1}`}
                placeholder="What is hidden here? (the answer, optional)"
                value={m.label}
                maxLength={200}
                onFocus={() => setSelected(m.id)}
                onChange={(e) => update(m.id, { label: e.target.value })}
                className="h-9"
              />
              <IconButton size="sm" label={`Delete box ${i + 1}`} onClick={() => remove(m.id)}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ol>
      )}
      {uploading && (
        <span className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-4" /> Uploading image…
        </span>
      )}
    </div>
  );
}
