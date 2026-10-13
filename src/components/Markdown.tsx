import { ImageOff } from 'lucide-react';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
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

const remarkPlugins = [remarkGfm, remarkMath];
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
