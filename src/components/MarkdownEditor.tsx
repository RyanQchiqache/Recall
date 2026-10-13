import { Bold, Code2, Heading2, ImagePlus, Italic, List, ListOrdered, Quote, Radical, SquareCode, SquareSigma } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { MediaAsset } from '../../shared/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { cn, useLatest } from '../lib/util.ts';
import { Spinner } from './ui/Feedback.tsx';
import { fieldClass } from './ui/Form.tsx';
import { Tip } from './ui/Tooltip.tsx';

export interface MarkdownEditorHandle {
  focus: () => void;
}

const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    id: string;
    value: string;
    onChange: (v: string) => void;
    label: ReactNode;
    placeholder?: string;
    minRows?: number;
    invalid?: boolean;
    describedBy?: string;
    onError: (msg: string) => void;
  }
>(function MarkdownEditor({ id, value, onChange, label, placeholder, minRows = 5, invalid, describedBy, onError }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const latest = useLatest(value);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }));

  const replaceSelection = (fn: (sel: string) => { text: string; cursorStart?: number; cursorEnd?: number }) => {
    const el = ta.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const current = latest.current;
    const sel = current.slice(start, end);
    const r = fn(sel);
    const next = current.slice(0, start) + r.text + current.slice(end);
    latest.current = next;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + (r.cursorStart ?? r.text.length), start + (r.cursorEnd ?? r.cursorStart ?? r.text.length));
    });
  };

  const wrap = (before: string, after = before, placeholderText = 'text') =>
    replaceSelection((sel) => {
      const inner = sel || placeholderText;
      return { text: `${before}${inner}${after}`, cursorStart: before.length, cursorEnd: before.length + inner.length };
    });

  const prefixLines = (prefix: (i: number) => string) =>
    replaceSelection((sel) => {
      const lines = (sel || 'item').split('\n');
      const text = lines.map((l, i) => `${prefix(i)}${l}`).join('\n');
      return { text, cursorStart: text.length };
    });

  const insertBlock = (block: string, cursorOffset: number) => {
    const el = ta.current;
    const atLineStart = !el || el.selectionStart === 0 || latest.current[el.selectionStart - 1] === '\n';
    const pre = atLineStart ? '' : '\n';
    replaceSelection(() => ({ text: `${pre}${block}`, cursorStart: pre.length + cursorOffset }));
  };

  const uploadFiles = async (files: File[]) => {
    const images = files.filter((f) => ALLOWED.includes(f.type));
    if (files.length && !images.length) {
      onError('Only PNG, JPEG, GIF and WebP images can be added.');
      return;
    }
    for (const file of images) {
      setUploading((n) => n + 1);
      try {
        const asset = await api.upload<MediaAsset>('/api/media', file, file.name || 'pasted-image.png');
        const alt = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '');
        insertBlock(`![${alt}](${asset.url})\n`, `![${alt}](${asset.url})\n`.length);
      } catch (e) {
        onError(errorMessage(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const tools: { label: string; icon: ReactNode; run: () => void; shortcut?: string }[] = [
    { label: 'Bold', icon: <Bold />, run: () => wrap('**'), shortcut: '⌘B' },
    { label: 'Italic', icon: <Italic />, run: () => wrap('*'), shortcut: '⌘I' },
    { label: 'Heading', icon: <Heading2 />, run: () => prefixLines(() => '### ') },
    { label: 'Bulleted list', icon: <List />, run: () => prefixLines(() => '- ') },
    { label: 'Numbered list', icon: <ListOrdered />, run: () => prefixLines((i) => `${i + 1}. `) },
    { label: 'Quote', icon: <Quote />, run: () => prefixLines(() => '> ') },
    { label: 'Inline code', icon: <Code2 />, run: () => wrap('`', '`', 'code') },
    { label: 'Code block', icon: <SquareCode />, run: () => insertBlock('```python\n\n```\n', 10) },
    { label: 'Inline math', icon: <Radical />, run: () => wrap('$', '$', 'x^2') },
    { label: 'Display equation', icon: <SquareSigma />, run: () => insertBlock('$$\n\n$$\n', 3) },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-text-2">
          {label}
        </label>
        <div role="toolbar" aria-label={`Formatting for ${typeof label === 'string' ? label : 'text'}`} className="flex flex-wrap items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {tools.map((t) => (
            <Tip key={t.label} content={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}>
              <button type="button" aria-label={t.label} onClick={t.run} className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-text [&_svg]:size-4">
                {t.icon}
              </button>
            </Tip>
          ))}
          <Tip content="Add image (or paste / drop one)">
            <button type="button" aria-label="Add image" onClick={() => fileInput.current?.click()} className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-text [&_svg]:size-4">
              {uploading ? <Spinner className="size-4" /> : <ImagePlus />}
            </button>
          </Tip>
          <input
            ref={fileInput}
            type="file"
            accept={ALLOWED.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              void uploadFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      <div className="relative">
        <textarea
          ref={ta}
          id={id}
          value={value}
          rows={minRows}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          spellCheck
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
              e.preventDefault();
              wrap('**');
            } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
              e.preventDefault();
              wrap('*');
            } else if (e.key === 'Tab' && !e.shiftKey && !mod && ta.current && ta.current.selectionStart !== ta.current.selectionEnd) {
              e.preventDefault();
              prefixLines(() => '  ');
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void uploadFiles(files);
            }
          }}
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              setDragOver(false);
              void uploadFiles([...e.dataTransfer.files]);
            }
          }}
          className={cn(fieldClass, 'field-sizing-content min-h-32 resize-y py-3 font-mono text-[14px] leading-relaxed', dragOver && 'border-primary ring-3 ring-primary/20')}
        />
        {uploading > 0 && (
          <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-lg bg-surface px-2 py-1 text-xs text-muted shadow-soft">
            <Spinner className="size-3.5" /> Uploading image…
          </div>
        )}
      </div>
    </div>
  );
});
