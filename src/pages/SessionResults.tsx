import { ArrowRight, Dumbbell, LayoutDashboard, Play, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { MODE_LABEL, type Rating } from '../../shared/ratings.ts';
import type { SessionState } from '../../shared/types.ts';
import { DistributionBar } from '../components/charts.tsx';
import { PageHeader, SectionTitle } from '../components/layout/AppShell.tsx';
import { RatingBadge, ratingParts } from '../components/ratingUi.tsx';
import { Button, LinkButton } from '../components/ui/Button.tsx';
import { Alert, Badge, ErrorState, PageLoader, Panel, Stat } from '../components/ui/Feedback.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage, qs } from '../lib/api.ts';
import { formatDateTime, formatDuration, mdPreview, percent, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useSessionResults } from '../lib/queries.ts';

export function SessionResultsPage() {
  const { id } = useParams();
  const results = useSessionResults(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [undoing, setUndoing] = useState(false);
  if (results.isLoading) return <PageLoader />;
  if (results.error) return <ErrorState error={results.error} onRetry={() => results.refetch()} />;
  const r = results.data!;
  const s = r.session;
  const p = s.progress;
  const firstTotal = Object.values(r.firstRatingCounts).reduce((a, b) => a + b, 0);
  const firstRecalled = r.firstRatingCounts[3] + r.firstRatingCounts[4];
  const finishedRecalled = r.cards.filter((c) => c.status === 'completed').length;
  const unresolved = r.cards.filter((c) => c.status === 'unresolved');
  const isTest = s.mode === 'test';
  const open = s.status === 'active' || s.status === 'paused';

  const undoLast = async () => {
    setUndoing(true);
    try {
      const st = await api.get<SessionState>(`/api/sessions/${s.id}`);
      await api.post(`/api/sessions/${s.id}/undo`, { revision: st.revision });
      invalidateContent();
      queryClient.removeQueries({ queryKey: ['session', s.id] });
      navigate(`/study/${s.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <>
      <PageHeader
        docTitle="Session results"
        title={s.status === 'completed' ? 'Session complete' : s.status === 'ended' ? 'Session ended' : 'Session in progress'}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="primary">{MODE_LABEL[s.mode]}</Badge>
            <span>{s.scopeLabel}</span>
            <span>· {formatDateTime(s.startedAt)}</span>
            <span>· active time {formatDuration(s.activeMs)}</span>
          </span>
        }
        actions={
          <>
            {open ? (
              <LinkButton to={`/study/${s.id}`} variant="primary" icon={<Play className="size-4 fill-current" />}>
                Resume
              </LinkButton>
            ) : (
              <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={undoLast} loading={undoing} disabled={p.totalAttempts === 0}>
                Undo last rating
              </Button>
            )}
            <LinkButton to="/" icon={<LayoutDashboard className="size-4" />}>
              Dashboard
            </LinkButton>
          </>
        }
      />

      {s.status === 'ended' && r.notReached > 0 && (
        <Alert tone="info" className="mb-6">
          You ended the session early — {plural(r.notReached, 'card')} {r.notReached === 1 ? 'was' : 'were'} not reached and keep their previous state.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-soft lg:grid-cols-4">
        <Stat label="Unique cards" value={`${p.attempted} / ${p.selected}`} hint="attempted / selected" />
        <Stat label="First-attempt recall" value={percent(firstRecalled, firstTotal)} hint={`${firstRecalled} of ${firstTotal} rated Very good or Perfect first time`} />
        <Stat
          label={isTest ? 'Recalled (self-assessed)' : 'Finished after repeats'}
          value={`${finishedRecalled} / ${p.attempted}`}
          hint={isTest ? 'Self-assessed recall, not an exam score' : 'reached Very good or Perfect by the end'}
        />
        <Stat label="Total attempts" value={p.totalAttempts} hint={`${plural(r.repeatAttempts, 'repeat attempt')}`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="mb-1 font-semibold">First rating per card</h2>
          <p className="mb-4 text-sm text-muted">Your initial recall — out of {plural(firstTotal, 'attempted card')}.</p>
          <DistributionBar parts={ratingParts(r.firstRatingCounts)} total={firstTotal} label="First ratings" />
        </Panel>
        <Panel className="p-5">
          <h2 className="mb-1 font-semibold">Final rating per card</h2>
          <p className="mb-4 text-sm text-muted">After in-session repeats. This is practice, not mastery.</p>
          <DistributionBar parts={ratingParts(r.finalRatingCounts)} total={firstTotal} label="Final ratings" />
        </Panel>
      </div>

      {r.weakCardIds.length > 0 && (
        <Panel className="mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="font-semibold">{isTest ? 'Cards you didn’t recall' : 'Cards that need more work'}</h2>
            <p className="text-sm text-muted">
              {plural(r.weakCardIds.length, 'card')} {isTest ? 'rated Bad or Good' : 'rated Bad or Good at first, or still unresolved'}. A practice session won’t change their schedule.
            </p>
          </div>
          <LinkButton to={`/study/new${qs({ cards: r.weakCardIds.join(','), mode: 'practice' })}`} variant="primary" icon={<Dumbbell className="size-4" />}>
            Review weak cards
          </LinkButton>
        </Panel>
      )}

      {!isTest && unresolved.length > 0 && (
        <section className="mt-8" aria-labelledby="unres-h">
          <SectionTitle id="unres-h">Needs another session ({unresolved.length})</SectionTitle>
          <Panel as="div" className="divide-y divide-border overflow-hidden">
            {unresolved.map((c) => (
              <Link key={c.cardId} to={`/cards/${c.cardId}/edit`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1">{mdPreview(c.front, 160)}</span>
                  <span className="text-sm text-muted">
                    {c.sectionTitle} · {plural(c.attempts, 'attempt')}
                  </span>
                </span>
                <RatingBadge rating={c.finalRating} />
              </Link>
            ))}
          </Panel>
        </section>
      )}

      <section className="mt-8" aria-labelledby="bysec-h">
        <SectionTitle id="bysec-h">By section</SectionTitle>
        <Panel as="div" className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-surface-2/60 text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Section</th>
                <th className="px-3 py-2.5 text-right font-medium">Cards</th>
                <th className="px-3 py-2.5 text-right font-medium">First-attempt recall</th>
                <th className="px-3 py-2.5 text-right font-medium">Unresolved</th>
                <th className="px-5 py-2.5 text-right font-medium">Attempts</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {r.bySection.map((b) => (
                <tr key={b.sectionId} className="border-t border-border">
                  <td className="px-5 py-2.5">
                    <Link to={`/sections/${b.sectionId}`} className="font-medium hover:underline">
                      {b.sectionTitle}
                    </Link>
                    <span className="block text-xs text-muted">{b.courseTitle}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">{b.cards}</td>
                  <td className="px-3 py-2.5 text-right">
                    {b.firstRecalled} <span className="text-muted">({percent(b.firstRecalled, b.cards)})</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">{b.unresolved}</td>
                  <td className="px-5 py-2.5 text-right">{b.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      <section className="mt-8" aria-labelledby="all-h">
        <SectionTitle id="all-h">All cards in this session</SectionTitle>
        <Panel as="div" className="divide-y divide-border overflow-hidden">
          {r.cards.map((c) => (
            <Link key={c.cardId} to={`/cards/${c.cardId}/edit`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2">
              <span className="min-w-0 flex-1 basis-60">
                <span className="line-clamp-1">{mdPreview(c.front, 160) || 'Image-only question'}</span>
                <span className="text-sm text-muted">
                  {c.sectionTitle} · {c.attempts ? plural(c.attempts, 'attempt') : 'not reached'}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-sm text-muted">
                {c.firstRating ? (
                  <>
                    first <RatingBadge rating={c.firstRating as Rating} />
                    {c.attempts > 1 && (
                      <>
                        <ArrowRight className="size-3.5" aria-label="then" /> final <RatingBadge rating={c.finalRating as Rating} />
                      </>
                    )}
                  </>
                ) : (
                  <Badge>Not reached</Badge>
                )}
              </span>
            </Link>
          ))}
        </Panel>
      </section>
    </>
  );
}
