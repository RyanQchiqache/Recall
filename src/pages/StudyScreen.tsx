import { Eye, Info, Lightbulb, Pause, Play, Repeat2, RotateCcw, Square, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { MODE_LABEL, RATING_INFO, RATINGS, type Rating } from '../../shared/ratings.ts';
import type { SessionState } from '../../shared/types.ts';
import { Markdown } from '../components/Markdown.tsx';
import { RATING_COLOR, RATING_ICON } from '../components/ratingUi.tsx';
import { Button, IconButton, LinkButton } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Dialog.tsx';
import { Alert, Badge, ErrorState, Kbd, PageLoader } from '../components/ui/Feedback.tsx';
import { Textarea } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { Tip } from '../components/ui/Tooltip.tsx';
import { ApiError, api, errorMessage } from '../lib/api.ts';
import { mdPreview, plural } from '../lib/format.ts';
import { invalidateContent, queryClient, useSession, useSettings } from '../lib/queries.ts';
import { courseVars, dialogOpen, isTypingTarget, useDocumentTitle, uuid } from '../lib/util.ts';

type Dialog = null | 'exit' | 'end';

export function StudyScreen() {
  const { id } = useParams();
  const session = useSession(id);
  const settings = useSettings();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [rateError, setRateError] = useState<{ rating: Rating; message: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [introOpen, setIntroOpen] = useState(false);
  const keyRef = useRef<{ slot: string; key: string } | null>(null);
  useDocumentTitle('Studying', settings.data?.appName);

  const s = session.data;

  // Leave finished sessions for the results page.
  useEffect(() => {
    if (s && (s.status === 'completed' || s.status === 'ended')) navigate(`/study/${s.id}/results`, { replace: true });
  }, [s, navigate]);

  // Reset the typed answer whenever the current card changes.
  const slot = s?.current ? `${s.current.cardId}:${s.progress.totalAttempts}` : 'none';
  useEffect(() => {
    setTyped(s?.typedAnswer ?? '');
    setRateError(null);
  }, [slot]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One idempotency key per card presentation — a retry reuses it, so a rating is never applied twice. */
  const idempotencyKey = () => {
    if (!keyRef.current || keyRef.current.slot !== slot) keyRef.current = { slot, key: uuid() };
    return keyRef.current.key;
  };

  const apply = (next: SessionState) => {
    queryClient.setQueryData(['session', id], next);
    queryClient.invalidateQueries({ queryKey: ['openSession'] });
  };

  const run = useCallback(
    async (fn: () => Promise<SessionState>, opts: { onError?: (e: unknown) => boolean } = {}) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        apply(await fn());
      } catch (e) {
        if (opts.onError?.(e)) return;
        if (e instanceof ApiError && (e.code === 'stale_session' || e.code === 'no_current_card' || e.status === 409)) {
          toast.info(e.code === 'stale_session' ? 'This session was updated in another tab — showing the latest state.' : e.message);
          await session.refetch();
        } else toast.error(errorMessage(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const reveal = () => {
    if (!s || s.revealed || !s.current || s.status !== 'active') return;
    void run(() => api.post<SessionState>(`/api/sessions/${id}/reveal`, { revision: s.revision, typedAnswer: s.mode === 'test' ? typed : undefined }));
    if (settings.data && !settings.data.ratingIntroSeen && s.mode !== 'test') setIntroOpen(true);
  };

  const rate = (rating: Rating) => {
    if (!s || !s.revealed || !s.current || s.status !== 'active') return;
    const cardId = s.current.cardId;
    void run(
      async () => {
        const r = await api.post<{ state: SessionState }>(`/api/sessions/${id}/rate`, { rating, idempotencyKey: idempotencyKey(), revision: s.revision, cardId });
        setRateError(null);
        if (r.state.status === 'completed') invalidateContent();
        return r.state;
      },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 0) {
            setRateError({ rating, message: e.message });
            return true;
          }
          return false;
        },
      },
    );
  };

  const undo = () => {
    if (!s?.canUndo) return;
    const last = s.lastRating;
    void run(async () => {
      const next = await api.post<SessionState>(`/api/sessions/${id}/undo`, { revision: s.revision });
      if (last) toast.info(`Undid “${RATING_INFO[last.rating].label}” on “${mdPreview(last.front, 50)}”`);
      invalidateContent();
      return next;
    });
  };

  const pause = () => s?.status === 'active' && run(() => api.post<SessionState>(`/api/sessions/${id}/pause`));
  const resume = () => s?.status === 'paused' && run(() => api.post<SessionState>(`/api/sessions/${id}/resume`));
  const relax = () => s && run(() => api.post<SessionState>(`/api/sessions/${id}/relax`, { revision: s.revision }));
  const hint = () => s && !s.hintShown && s.current?.snapshot.hint && run(() => api.post<SessionState>(`/api/sessions/${id}/hint`));

  // Keyboard shortcuts (ignored while typing, in dialogs, on key repeat or while a request is pending).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!s) return;
      if (e.key === 'Escape' && isTypingTarget(e.target)) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (isTypingTarget(e.target) || dialogOpen() || e.repeat) return;
      if (e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (mod) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (s.status === 'active') void pause();
        else setDialog('exit');
        return;
      }
      if (s.status === 'paused') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          void resume();
        }
        return;
      }
      if (busyRef.current) return;
      if ((e.key === ' ' || e.key === 'Enter') && !s.revealed && s.current) {
        if ((e.target as HTMLElement)?.tagName === 'BUTTON' && e.key === 'Enter') return;
        e.preventDefault();
        reveal();
      } else if (['1', '2', '3', '4'].includes(e.key) && s.revealed) {
        e.preventDefault();
        rate(Number(e.key) as Rating);
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        void hint();
      } else if (e.key.toLowerCase() === 'u') {
        e.preventDefault();
        undo();
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        void pause();
      } else if (e.key.toLowerCase() === 'r' && s.waiting) {
        e.preventDefault();
        void relax();
      }
    };
    // Capture phase: runs before Radix closes a dialog on Escape, so dialogOpen() is still accurate.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (session.isLoading) return <PageLoader label="Loading session" />;
  if (session.error || !s)
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <ErrorState error={session.error ?? new Error('Session not found')} onRetry={() => session.refetch()} />
        <LinkButton to="/" className="mt-4">
          Back to dashboard
        </LinkButton>
      </div>
    );

  const p = s.progress;
  const done = p.completed + p.unresolved;
  const snap = s.current?.snapshot;
  const atCap = s.current && s.current.attempt >= s.maxAttempts;

  return (
    <div className="flex min-h-dvh flex-col bg-bg" style={courseVars(snap?.courseColor)}>
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-3 py-2.5 sm:px-6">
          <IconButton label="Exit session" onClick={() => setDialog('exit')}>
            <X className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{s.scopeLabel}</p>
            <p className="truncate text-xs text-muted">
              {MODE_LABEL[s.mode]} · card {Math.min(p.attempted + (s.current && !s.current.isRepeat ? 1 : 0), p.selected)} of {p.selected} unique
            </p>
          </div>
          <IconButton label="Undo last rating (U)" onClick={undo} disabled={!s.canUndo || busy}>
            <Undo2 className="size-5" />
          </IconButton>
          {s.status === 'active' ? (
            <IconButton label="Pause (P or Esc)" onClick={() => pause()} disabled={busy}>
              <Pause className="size-5" />
            </IconButton>
          ) : (
            <IconButton label="Resume" onClick={() => resume()} disabled={busy}>
              <Play className="size-5" />
            </IconButton>
          )}
        </div>
        <div className="mx-auto max-w-4xl px-3 pb-3 sm:px-6">
          <div
            className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-label="Cards finished"
            aria-valuemin={0}
            aria-valuemax={p.selected}
            aria-valuenow={done}
            aria-valuetext={`${p.completed} completed, ${p.unresolved} need another session, ${p.remaining} remaining`}
          >
            {p.completed > 0 && <div className="h-full rounded-full bg-[var(--rating-perfect)] transition-[width] duration-200" style={{ width: `${(p.completed / p.selected) * 100}%` }} />}
            {p.unresolved > 0 && <div className="h-full rounded-full bg-[var(--rating-good)] transition-[width] duration-200" style={{ width: `${(p.unresolved / p.selected) * 100}%` }} />}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <div className="flex gap-1">
              <dt>Attempted</dt>
              <dd className="font-medium text-text-2 tabular-nums">
                {p.attempted}/{p.selected}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-[var(--rating-perfect)]" aria-hidden />
                Completed
              </dt>
              <dd className="font-medium text-text-2 tabular-nums">{p.completed}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full bg-[var(--rating-good)]" aria-hidden />
                Needs another session
              </dt>
              <dd className="font-medium text-text-2 tabular-nums">{p.unresolved}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Total attempts</dt>
              <dd className="font-medium text-text-2 tabular-nums">{p.totalAttempts}</dd>
            </div>
          </dl>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 sm:px-6 sm:py-10">
        {s.status === 'paused' ? (
          <PausedPanel onResume={() => resume()} onExit={() => setDialog('exit')} busy={busy} />
        ) : s.waiting ? (
          <div className="anim-pop my-auto rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary-soft text-primary-text">
              <Repeat2 className="size-6" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold">Only recently missed cards are left</h1>
            <p className="mx-auto mt-2 max-w-md text-muted">
              {plural(p.remaining, 'card')} would normally wait until you’d answered a few others. There are none left, so you can review {p.remaining === 1 ? 'it' : 'them'} now.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button variant="primary" size="lg" onClick={() => relax()} loading={busy} icon={<RotateCcw className="size-4" />}>
                Review remaining cards now
              </Button>
              <Button size="lg" onClick={() => setDialog('end')}>
                Finish here
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">
              Shortcut <Kbd>R</Kbd>
            </p>
          </div>
        ) : s.current && snap ? (
          <>
            <article className="anim-pop relative overflow-hidden rounded-2xl border border-border bg-surface shadow-card" aria-live="polite" key={slot}>
              <div className="p-6 sm:p-9">
                <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-2 shrink-0 rounded-[3px] bg-[var(--course)]" aria-hidden />
                    <span className="min-w-0 truncate">
                      {snap.courseTitle} › {snap.sectionTitle}
                    </span>
                  </span>
                  {s.current.isRepeat && (
                    <Badge tone="warning" icon={<Repeat2 className="size-3" aria-hidden />}>
                      Repeat · attempt {s.current.attempt} of {s.maxAttempts}
                    </Badge>
                  )}
                  {snap.tags.map((t) => (
                    <span key={t} className="text-muted">
                      #{t}
                    </span>
                  ))}
                </div>
                {s.current.editedSinceStart && (
                  <p className="mb-4 flex items-center gap-1.5 text-xs text-muted">
                    <Info className="size-3.5" aria-hidden /> This card was edited after the session started; you see the version from the start of the session.
                  </p>
                )}
                <h1 className="sr-only">Question</h1>
                <Markdown className="text-[19px] leading-relaxed sm:text-xl">{snap.front}</Markdown>

                {snap.hint && !s.revealed && (
                  <div className="mt-6">
                    {s.hintShown ? (
                      <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-4 py-3 text-[15px] text-text-2">
                        <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                        {snap.hint}
                      </p>
                    ) : (
                      <Button size="sm" variant="ghost" icon={<Lightbulb className="size-4" />} onClick={() => hint()}>
                        Show hint <Kbd className="ml-1">H</Kbd>
                      </Button>
                    )}
                  </div>
                )}

                {s.mode === 'test' && !s.revealed && (
                  <div className="mt-6">
                    <label htmlFor="typed" className="mb-1.5 block text-sm font-medium text-text-2">
                      Your answer (optional — you’ll compare it yourself)
                    </label>
                    <Textarea id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} rows={4} placeholder="Type a draft answer before revealing…" />
                    <p className="mt-1 text-xs text-muted">Press Esc to leave the text box, then Space to reveal.</p>
                  </div>
                )}

                {s.revealed && (
                  <section className="anim-fade mt-8 border-t border-border pt-7" aria-label="Answer">
                    {s.mode === 'test' && s.typedAnswer && (
                      <div className="mb-5 rounded-xl bg-surface-2 px-4 py-3">
                        <p className="mb-1 text-[13px] font-medium text-muted">Your answer</p>
                        <p className="text-[15px] whitespace-pre-wrap">{s.typedAnswer}</p>
                      </div>
                    )}
                    <p className="mb-3 text-[13px] font-medium text-muted">Answer</p>
                    <Markdown className="text-[17px] leading-relaxed">{snap.back}</Markdown>
                    {snap.explanation && (
                      <div className="mt-6 rounded-xl bg-surface-2 px-5 py-4">
                        <p className="mb-2 text-[13px] font-medium text-muted">Explanation</p>
                        <Markdown className="text-[15px] text-text-2">{snap.explanation}</Markdown>
                      </div>
                    )}
                    {snap.source && <p className="mt-4 text-sm text-muted">Source: {snap.source}</p>}
                  </section>
                )}
              </div>
            </article>

            <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-border bg-bg/95 px-4 pt-3 pb-4 backdrop-blur sm:mx-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none">
              {!s.revealed ? (
                <div className="flex flex-col items-center gap-2">
                  <Button variant="primary" size="lg" className="w-full max-w-sm" onClick={reveal} loading={busy} icon={<Eye className="size-5" />}>
                    Show answer
                  </Button>
                  <p className="text-xs text-muted">
                    <Kbd>Space</Kbd> reveal · <Kbd>H</Kbd> hint · <Kbd>Esc</Kbd> pause
                  </p>
                </div>
              ) : (
                <>
                  {rateError && (
                    <Alert tone="danger" className="mb-3" action={<Button size="sm" onClick={() => rate(rateError.rating)}>Retry</Button>}>
                      {rateError.message} Your rating was not saved yet.
                    </Alert>
                  )}
                  <p className="mb-2 text-center text-sm text-muted">
                    How well did you recall it?{' '}
                    {s.mode !== 'test' && atCap && <span className="text-text-2">Last attempt this session — Bad or Good marks it “Needs another session”.</span>}
                    {s.mode === 'test' && <span className="text-text-2">Test once: each card is shown one time.</span>}
                  </p>
                  <RatingButtons onRate={rate} disabled={busy} mode={s.mode} />
                  <p className="mt-2 hidden text-center text-xs text-muted sm:block">
                    Keys <Kbd>1</Kbd>–<Kbd>4</Kbd> · <Kbd>U</Kbd> undo · <button className="underline underline-offset-2" onClick={() => setIntroOpen(true)}>What do the ratings mean?</button>
                  </p>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="my-auto text-center text-muted">Preparing the next card…</div>
        )}
      </main>

      <RatingIntro
        open={introOpen}
        onClose={async () => {
          setIntroOpen(false);
          if (settings.data && !settings.data.ratingIntroSeen) {
            await api.patch('/api/settings', { ratingIntroSeen: true }).catch(() => undefined);
            queryClient.invalidateQueries({ queryKey: ['settings'] });
          }
        }}
      />

      <Modal
        open={dialog === 'exit'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Leave this session?"
        description="Your progress is saved after every rating. You can resume exactly where you left off."
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Keep studying</Button>
            <Button variant="danger" icon={<Square className="size-4" />} onClick={() => setDialog('end')}>
              End session
            </Button>
            <Button
              variant="primary"
              icon={<Pause className="size-4" />}
              onClick={async () => {
                if (s.status === 'active') await api.post(`/api/sessions/${id}/pause`).catch(() => undefined);
                queryClient.invalidateQueries({ queryKey: ['openSession'] });
                invalidateContent();
                navigate('/');
              }}
            >
              Pause and leave
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-2">
          “End session” finishes it now: {plural(p.remaining, 'card')} not yet finished will not be studied in this session, and you’ll see the results.
        </p>
      </Modal>
      <Modal
        open={dialog === 'end'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="End the session now?"
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                await run(() => api.post<SessionState>(`/api/sessions/${id}/end`));
                setDialog(null);
                invalidateContent();
              }}
            >
              End session
            </Button>
          </>
        }
      >
        <p className="text-[15px] text-text-2">Ratings you already gave stay saved. Unfinished cards simply aren’t counted as studied in this session.</p>
      </Modal>
    </div>
  );
}

function RatingButtons({ onRate, disabled, mode }: { onRate: (r: Rating) => void; disabled: boolean; mode: SessionState['mode'] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Rate your recall">
      {RATINGS.map((r) => {
        const info = RATING_INFO[r];
        const Icon = RATING_ICON[r];
        const effect = mode === 'test' ? 'One attempt only in test mode' : info.sessionEffect;
        return (
          <Tip key={r} content={`${info.meaning}. ${effect}.`}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRate(r)}
              aria-keyshortcuts={info.key}
              aria-label={`${info.label} (key ${info.key}): ${info.meaning}`}
              style={{ ['--rc' as string]: RATING_COLOR[r] }}
              className="group flex min-h-[72px] flex-col items-start justify-center gap-1 rounded-xl border border-border bg-surface px-3.5 py-3 text-left shadow-soft transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-[color-mix(in_srgb,var(--rc)_55%,var(--border))] hover:bg-[color-mix(in_srgb,var(--rc)_6%,var(--surface))] focus-visible:border-[var(--rc)] active:translate-y-px disabled:opacity-50"
            >
              <span className="flex w-full items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[color-mix(in_srgb,var(--rc)_14%,transparent)] text-[var(--rc)]" aria-hidden>
                  <Icon className="size-3.5" strokeWidth={2.5} />
                </span>
                <span className="text-sm font-semibold">{info.label}</span>
                <Kbd className="ml-auto">{info.key}</Kbd>
              </span>
              <span className="line-clamp-2 text-xs leading-snug text-muted">{info.meaning}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

function PausedPanel({ onResume, onExit, busy }: { onResume: () => void; onExit: () => void; busy: boolean }) {
  return (
    <div className="anim-pop my-auto rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-2 text-text-2">
        <Pause className="size-6" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold">Session paused</h1>
      <p className="mx-auto mt-2 max-w-md text-muted">Paused time isn’t counted as study time. Everything is saved — you can close the app and resume later.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" size="lg" autoFocus onClick={onResume} loading={busy} icon={<Play className="size-4 fill-current" />}>
          Resume
        </Button>
        <Button size="lg" onClick={onExit}>
          Leave or end…
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        <Kbd>Space</Kbd> resume · <Link to="/" className="underline">Dashboard</Link>
      </p>
    </div>
  );
}

function RatingIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="How the four ratings work"
      description="They are your own honest judgement of recall — not an automatic correctness check."
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <ul className="flex flex-col gap-3">
        {RATINGS.map((r) => {
          const info = RATING_INFO[r];
          const Icon = RATING_ICON[r];
          return (
            <li key={r} className="flex gap-3 rounded-lg border border-border p-3" style={{ ['--rc' as string]: RATING_COLOR[r] }}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--rc)_14%,transparent)] text-[var(--rc)]" aria-hidden>
                <Icon className="size-4" strokeWidth={2.5} />
              </span>
              <div>
                <p className="font-semibold">
                  {info.key} · {info.label}
                </p>
                <p className="text-[15px] text-text-2">{info.meaning}.</p>
                <p className="text-sm text-muted">In this session: {info.sessionEffect.toLowerCase()}.</p>
              </div>
            </li>
          );
        })}
      </ul>
      <Alert tone="info" className="mt-4" title="Good vs Very good">
        Choose <strong>Good</strong> if you only partly knew it, or got there with real effort or a hint — the card comes back in this session. Choose <strong>Very good</strong> if your answer was correct and you were reasonably confident — the card is done for now.
      </Alert>
      <p className="mt-3 text-sm text-muted">
        In scheduled review, only your <em>first</em> rating of a card sets when it’s due next (Bad 1 day, Good 2+, Very good 4+, Perfect 7+ days). Repeats are practice and don’t change the schedule.
      </p>
    </Modal>
  );
}
