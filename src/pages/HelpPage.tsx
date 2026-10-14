import { ArrowRight, BookOpenCheck, ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { EmptyState, Panel } from '../components/ui/Feedback.tsx';
import { Input } from '../components/ui/Form.tsx';
import { HELP_CATEGORIES, HELP_ITEMS, helpSearchText, type HelpItem } from '../lib/helpContent.ts';

export function HelpPage() {
  const location = useLocation();
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => (normalized ? HELP_ITEMS.filter((item) => helpSearchText(item).includes(normalized)) : HELP_ITEMS), [normalized]);
  const target = location.hash.slice(1);

  return (
    <>
      <PageHeader title="How to use Recall" subtitle="Straightforward answers about creating cards, studying, exam plans, statistics, settings and your local data." />

      <div className="relative mb-5">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          type="search"
          className="h-12 pl-11 text-base"
          placeholder="Search how Recall works…"
          aria-label="Search help"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {!normalized && (
        <Panel className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-text" aria-hidden>
            <BookOpenCheck className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">New to Recall?</h2>
            <p className="mt-0.5 text-sm text-muted">Create your library, add a card, then let Scheduled review bring it back when it is due.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm font-medium">
            <Link to="/organize" className="rounded-lg px-3 py-2 text-primary-text hover:bg-primary-soft">
              Set up library
            </Link>
            <Link to="/study/new" className="rounded-lg px-3 py-2 text-primary-text hover:bg-primary-soft">
              Start studying
            </Link>
          </div>
        </Panel>
      )}

      {!normalized && (
        <nav aria-label="Help topics" className="mb-7 flex flex-wrap gap-2">
          {HELP_CATEGORIES.map((category) => (
            <a key={category.id} href={`#${category.id}`} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-text-2 shadow-soft hover:border-border-strong hover:bg-surface-2 hover:text-text">
              {category.label}
            </a>
          ))}
        </nav>
      )}

      <p className="mb-3 text-sm text-muted" aria-live="polite">
        {normalized ? `${matches.length} ${matches.length === 1 ? 'answer' : 'answers'} found` : `${HELP_ITEMS.length} common questions`}
      </p>

      {matches.length === 0 ? (
        <EmptyState icon={<Search className="size-6" />} title="No help answer found">
          Try a shorter phrase such as “ratings”, “new cards”, “exam”, “backup” or “timezone”.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-7">
          {HELP_CATEGORIES.map((category) => {
            const items = matches.filter((item) => item.category === category.id);
            if (!items.length) return null;
            return (
              <section key={category.id} id={category.id} className="scroll-mt-6" aria-labelledby={`${category.id}-title`}>
                <div className="mb-3">
                  <h2 id={`${category.id}-title`} className="text-[17px] font-semibold tracking-[-0.01em]">
                    {category.label}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted">{category.description}</p>
                </div>
                <Panel as="div" className="divide-y divide-border overflow-hidden p-0">
                  {items.map((item) => (
                    <Answer key={`${item.id}:${target}`} item={item} open={target === item.id || (!!normalized && matches.length === 1)} />
                  ))}
                </Panel>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function Answer({ item, open }: { item: HelpItem; open: boolean }) {
  return (
    <details id={item.id} className="group scroll-mt-6" {...(open ? { open: true } : {})}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 font-medium marker:hidden hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)] sm:px-5">
        <span className="min-w-0 flex-1">{item.question}</span>
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-150 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border bg-surface-2/40 px-4 py-4 text-sm leading-relaxed text-text-2 sm:px-5">
        <p>{item.answer}</p>
        {item.bullets && (
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {item.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        )}
        {item.link && (
          <Link to={item.link.to} className="mt-3 inline-flex items-center gap-1.5 font-medium text-primary-text hover:underline">
            {item.link.label}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </details>
  );
}
