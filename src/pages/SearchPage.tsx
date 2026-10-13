import { Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { CardFilter } from '../../shared/types.ts';
import { CardRowCompact } from '../components/CardList.tsx';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { EmptyState, ErrorState, Panel, Spinner } from '../components/ui/Feedback.tsx';
import { Checkbox, Input, Segmented, Select } from '../components/ui/Form.tsx';
import { plural } from '../lib/format.ts';
import { useCards, useDashboard, useTags, useTree } from '../lib/queries.ts';
import { useDebounced } from '../lib/util.ts';

const FILTERS: { value: CardFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'due', label: 'Due' },
  { value: 'weak', label: 'Weak' },
  { value: 'bookmarked', label: 'Bookmarked' },
  { value: 'suspended', label: 'Suspended' },
];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const tree = useTree();
  const tags = useTags();
  const dash = useDashboard();
  const inputRef = useRef<HTMLInputElement>(null);
  const q = params.get('q') ?? '';
  const scope = params.get('scope') ?? '';
  const filter = (params.get('filter') as CardFilter) || 'all';
  const tag = params.get('tag') ?? '';
  const archived = params.get('archived') === '1';
  const dq = useDebounced(q.trim(), 200);
  const [level, scopeId] = scope.split(':');
  const anyCriteria = !!(dq || tag || filter !== 'all' || scope);
  const results = useCards(
    {
      q: dq || undefined,
      filter: filter === 'all' ? undefined : filter,
      tag: tag || undefined,
      courseId: level === 'course' ? scopeId : undefined,
      sectionId: level === 'section' ? scopeId : undefined,
      semesterId: level === 'semester' ? scopeId : undefined,
      includeArchived: archived,
      sort: dq ? undefined : 'updated',
      limit: 200,
    },
    anyCriteria,
  );
  useEffect(() => inputRef.current?.focus(), []);
  const update = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Search" subtitle="Questions, answers, explanations, sources and tags — everywhere or within one place." />
      <div className="mb-5 flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <Input ref={inputRef} type="search" className="h-12 pl-11 text-base" placeholder="Search cards…" aria-label="Search cards" value={q} onChange={(e) => update('q', e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Search within" value={scope} onChange={(e) => update('scope', e.target.value)} className="w-auto">
            <option value="">Everywhere</option>
            {(tree.data ?? []).map((p) => (
              <optgroup key={p.id} label={p.title}>
                {p.semesters.flatMap((s) => [
                  <option key={s.id} value={`semester:${s.id}`}>
                    {s.title} (whole semester)
                  </option>,
                  ...s.courses.flatMap((c) => [
                    <option key={c.id} value={`course:${c.id}`}>
                      {'  '}
                      {c.title}
                    </option>,
                    ...c.sections.map((sec) => (
                      <option key={sec.id} value={`section:${sec.id}`}>
                        {'    '}› {sec.title}
                      </option>
                    )),
                  ]),
                ])}
              </optgroup>
            ))}
          </Select>
          <Select aria-label="Tag" value={tag} onChange={(e) => update('tag', e.target.value)} className="w-auto">
            <option value="">Any tag</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.name} value={t.name}>
                #{t.name} ({t.count})
              </option>
            ))}
          </Select>
          <Checkbox checked={archived} onChange={(e) => update('archived', e.target.checked ? '1' : '')} label="Include archived" />
        </div>
        <div className="overflow-x-auto">
          <Segmented ariaLabel="Card status" value={filter} onChange={(v) => update('filter', v === 'all' ? '' : v)} options={FILTERS} />
        </div>
      </div>
      {!anyCriteria ? (
        <EmptyState icon={<Search className="size-6" />} title="Find any card">
          Type a word, pick a tag or a status. Press <kbd className="rounded border border-border px-1">/</kbd> anywhere to jump here.
        </EmptyState>
      ) : results.error ? (
        <ErrorState error={results.error} onRetry={() => results.refetch()} />
      ) : !results.data ? (
        <div className="flex items-center gap-2 text-muted">
          <Spinner className="size-4" /> Searching…
        </div>
      ) : results.data.cards.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border-strong px-5 py-8 text-center text-muted">No cards found.</p>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted" aria-live="polite">
            {plural(results.data.total, 'card')}
            {results.data.total > results.data.cards.length && ` · showing the first ${results.data.cards.length}`}
          </p>
          <Panel as="div" className="divide-y divide-border overflow-hidden">
            {results.data.cards.map((c) => (
              <CardRowCompact key={c.id} card={c} today={dash.data?.today ?? ''} showSection />
            ))}
          </Panel>
        </>
      )}
    </>
  );
}
