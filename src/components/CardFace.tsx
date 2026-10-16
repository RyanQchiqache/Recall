import { parseCloze, clozeDisplayMarkdown, type CardRender, type OcclusionMask, type OcclusionMode } from '../../shared/notes.ts';
import { cn } from '../lib/util.ts';
import { isLocalMedia, Markdown } from './Markdown.tsx';

/**
 * One side of a card, drawn according to its type:
 *  - markdown: the stored front/back
 *  - cloze: the note text with the asked gap blanked (front) or highlighted (back)
 *  - occlusion: the image with boxes; the asked box is revealed on the back
 */
export function CardFace({
  render,
  front,
  back,
  side,
  className,
}: {
  render?: CardRender;
  front: string;
  back: string;
  side: 'front' | 'back';
  className?: string;
}) {
  if (render?.type === 'cloze') {
    let md: string;
    try {
      md = clozeDisplayMarkdown(parseCloze(render.text), render.ord, side);
    } catch {
      md = side === 'front' ? front : back;
    }
    return <Markdown className={className}>{md}</Markdown>;
  }
  if (render?.type === 'occlusion') {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        <OcclusionView image={render.image} masks={render.masks} activeId={render.activeId} mode={render.mode} revealed={side === 'back'} />
        {render.header && <Markdown className="text-[15px] text-text-2">{render.header}</Markdown>}
      </div>
    );
  }
  return <Markdown className={className}>{side === 'front' ? front : back}</Markdown>;
}

/** True when the card shows its answer by changing the question view itself (cloze, occlusion). */
export function revealsInPlace(render?: CardRender): boolean {
  return render?.type === 'cloze' || render?.type === 'occlusion';
}

export function OcclusionView({
  image,
  masks,
  activeId,
  mode,
  revealed,
  className,
}: {
  image: string;
  masks: OcclusionMask[];
  activeId: string;
  mode: OcclusionMode;
  revealed: boolean;
  className?: string;
}) {
  const index = masks.findIndex((m) => m.id === activeId);
  const active = masks[index];
  const shown = masks.filter((m) => (m.id === activeId ? true : mode === 'hide-all'));
  const description = revealed
    ? `Image with ${masks.length} boxes. Box ${index + 1} is uncovered${active?.label ? `: ${active.label}` : ''}.`
    : `Image with ${masks.length} hidden ${masks.length === 1 ? 'box' : 'boxes'}. Name what is under box ${index + 1}, marked with a question mark.`;
  if (!isLocalMedia(image)) return <p className="text-sm text-muted">This card’s image is missing.</p>;
  return (
    <figure className={cn('m-0', className)}>
      <div className="relative inline-block max-w-full overflow-hidden rounded-xl border border-border">
        <img src={image} alt="" className="block h-auto max-w-full select-none" draggable={false} />
        {shown.map((m) => {
          const isActive = m.id === activeId;
          if (isActive && revealed) {
            return (
              <div
                key={m.id}
                aria-hidden
                className="absolute rounded-[3px] border-2 border-dashed border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]"
                style={box(m)}
              >
                {m.label && (
                  <span className="absolute top-full left-0 mt-1 max-w-[16rem] rounded-md bg-[var(--primary)] px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-white shadow-soft">
                    {m.label}
                  </span>
                )}
              </div>
            );
          }
          return (
            <div
              key={m.id}
              aria-hidden
              className={cn(
                'absolute flex items-center justify-center rounded-[3px]',
                isActive ? 'border-[3px] border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_78%,var(--surface))] text-white' : 'border border-border-strong bg-surface-3',
              )}
              style={box(m)}
            >
              {isActive && <span className="text-lg leading-none font-bold">?</span>}
            </div>
          );
        })}
      </div>
      <figcaption className="sr-only">{description}</figcaption>
    </figure>
  );
}

function box(m: OcclusionMask): React.CSSProperties {
  return { left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` };
}
