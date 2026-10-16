import { ImageOff } from 'lucide-react';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MARK } from '../../shared/notes.ts';
import { cn } from '../lib/util.ts';

/** Only same-origin uploaded media is rendered as images. Remote images are never fetched. */
export function isLocalMedia(src: string | undefined): boolean {
  return !!src && /^\/media\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(src);
}

function safeUrl(url: string): string {
  if (url.startsWith('/media/') || url.startsWith('#')) return url;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  return '';
}

const components: Components = {
  img: ({ src, alt }) => {
    const s = typeof src === 'string' ? src : undefined;
    if (isLocalMedia(s)) return <img src={s} alt={alt ?? ''} loading="lazy" decoding="async" />;
    return (
      <span className="my-1 inline-flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-muted">
        <ImageOff className="size-4" aria-hidden />
        Remote image not loaded{alt ? ` (“${alt}”)` : ''}. Upload the image locally instead.
      </span>
    );
  },
  a: ({ href, children }) =>
    href ? (
      <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

const MARK_PAIRS: Record<string, { close: string; className: string }> = {
  [MARK.blankOpen]: { close: MARK.blankClose, className: 'cloze-blank' },
  [MARK.answerOpen]: { close: MARK.answerClose, className: 'cloze-answer' },
};
const ANY_MARK = new RegExp(`[${Object.values(MARK).join('')}]`, 'g');

/**
 * Turn the private-use markers from clozeDisplayMarkdown() into <mark> elements. A gap may
 * span several inline nodes (text, emphasis, inline math), so this works on sibling lists.
 * Unmatched markers are dropped. No raw HTML is involved.
 */
function remarkClozeMarks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children.forEach(walk);
    const out: MdNode[] = [];
    let open: { close: string; className: string; kids: MdNode[] } | null = null;
    for (const child of node.children) {
      if (child.type !== 'text' || !child.value || !ANY_MARK.test(child.value)) {
        ANY_MARK.lastIndex = 0;
        (open ? open.kids : out).push(child);
        continue;
      }
      ANY_MARK.lastIndex = 0;
      let rest = child.value;
      while (rest) {
        if (!open) {
          let idx = -1;
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] in MARK_PAIRS) {
              idx = i;
              break;
            }
          }
          const plain = idx < 0 ? rest : rest.slice(0, idx);
          if (plain) out.push({ type: 'text', value: plain.replace(ANY_MARK, '') });
          if (idx < 0) break;
          const pair = MARK_PAIRS[rest[idx]];
          open = { ...pair, kids: [] };
          rest = rest.slice(idx + 1);
        } else {
          const idx = rest.indexOf(open.close);
          const inner = idx < 0 ? rest : rest.slice(0, idx);
          if (inner) open.kids.push({ type: 'text', value: inner.replace(ANY_MARK, '') });
          if (idx < 0) break;
          out.push({ type: 'clozeMark', data: { hName: 'mark', hProperties: { className: [open.className] } }, children: open.kids });
          open = null;
          rest = rest.slice(idx + 1);
        }
      }
    }
    if (open) out.push(...open.kids);
    node.children = out;
  };
  return (tree: MdNode) => walk(tree);
}

const remarkPlugins = [remarkGfm, remarkMath, remarkClozeMarks];
const rehypePlugins = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' }],
  [rehypeHighlight, { detect: false }],
] as never;

/** Sanitised Markdown: raw HTML is skipped, links are inert unless clicked, math rendered locally by KaTeX. */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml urlTransform={safeUrl} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
