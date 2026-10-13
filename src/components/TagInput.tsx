import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTags } from '../lib/queries.ts';
import { cn } from '../lib/util.ts';
import { fieldClass } from './ui/Form.tsx';

export function TagInput({ id, value, onChange }: { id: string; value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const tags = useTags();
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(',').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (p.length <= 60 && !next.some((t) => t.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft('');
  };
  return (
    <div className={cn(fieldClass, 'flex min-h-10 flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/20')}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-2.5 text-sm">
          #{t}
          <button type="button" className="rounded-full p-0.5 text-muted hover:bg-surface-3 hover:text-text" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={listId}
        value={draft}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length ? '' : 'Add tags (Enter or comma)'}
        className="min-w-28 flex-1 bg-transparent py-0.5 text-[15px] outline-none placeholder:text-muted/80"
        aria-describedby={`${id}-hint`}
      />
      <datalist id={listId}>
        {(tags.data ?? []).map((t) => (
          <option key={t.name} value={t.name} />
        ))}
      </datalist>
      <span id={`${id}-hint`} className="sr-only">
        Press Enter or type a comma to add a tag. Backspace removes the last tag.
      </span>
    </div>
  );
}
