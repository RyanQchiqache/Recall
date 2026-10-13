import { Archive, Database, Download, FlaskConical, HardDrive, Info, Package, RotateCcw, Save, ShieldCheck, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AppSettings } from '../../shared/settings.ts';
import type { RestorePreview, SnapshotInfo } from '../../shared/types.ts';
import { PageHeader } from '../components/layout/AppShell.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Modal } from '../components/ui/Dialog.tsx';
import { Alert, Badge, ErrorState, PageLoader, Panel, Spinner } from '../components/ui/Feedback.tsx';
import { Checkbox, Field, Input, Segmented, Select, Switch } from '../components/ui/Form.tsx';
import { useToast } from '../components/ui/Toast.tsx';
import { api, downloadUrl, errorMessage } from '../lib/api.ts';
import { formatBytes, formatDateTime } from '../lib/format.ts';
import { invalidateContent, queryClient, useDashboard, useSettings, useSnapshots, useSystem, useTree } from '../lib/queries.ts';

const NAV = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'scheduling', label: 'Time & scheduling' },
  { id: 'study', label: 'Study defaults' },
  { id: 'backups', label: 'Backups & import' },
  { id: 'data', label: 'Data location' },
  { id: 'demo', label: 'Demo content' },
];

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isLoading) return <PageLoader />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  return <SettingsForm initial={settings.data!} />;
}

function Card({ id, title, description, children, icon }: { id: string; title: string; description?: ReactNode; children: ReactNode; icon: ReactNode }) {
  return (
    <Panel id={id} className="scroll-mt-6 p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-text [&_svg]:size-[18px]">{icon}</span>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </Panel>
  );
}

function SettingsForm({ initial }: { initial: AppSettings }) {
  const toast = useToast();
  const [s, setS] = useState<AppSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setS(initial), [initial]);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const timeZones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['Europe/Berlin', 'Europe/London', 'UTC'];
    }
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.patch<AppSettings>('/api/settings', s);
      queryClient.setQueryData(['settings'], next);
      invalidateContent();
      toast.success('Settings saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const rule = (k: 'bad' | 'good' | 'veryGood' | 'perfect', field: 'base' | 'multiplier', v: string) =>
    setS({ ...s, scheduler: { ...s.scheduler, [k]: { ...s.scheduler[k], [field]: Number(v) } } });

  return (
    <>
      <PageHeader title="Settings" subtitle="Everything is stored in the local database on this computer." />
      <div className="grid gap-8 lg:grid-cols-[180px_1fr]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-6 flex flex-col gap-0.5 text-sm">
            {NAV.map((n) => (
              <li key={n.id}>
                <a href={`#${n.id}`} className="block rounded-lg px-3 py-1.5 text-text-2 hover:bg-surface-2 hover:text-text">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-6">
          <Card id="appearance" title="Appearance" icon={<Info />}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="App name" htmlFor="set-name" hint="Shown in the sidebar and browser tab.">
                <Input id="set-name" value={s.appName} maxLength={40} onChange={(e) => setS({ ...s, appName: e.target.value })} />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-2">Theme</span>
                <Segmented
                  ariaLabel="Theme"
                  value={s.theme}
                  onChange={(theme) => setS({ ...s, theme })}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </div>
            </div>
          </Card>

          <Card id="scheduling" title="Time & scheduling" icon={<RotateCcw />} description="Changes apply to future reviews only. Existing due dates are never rewritten.">
            <div className="flex flex-col gap-5">
              <Field label="Timezone (IANA)" htmlFor="set-tz" hint="Days, due dates and statistics are counted in this timezone. Cards become due at local midnight.">
                <Input id="set-tz" list="tz-list" value={s.timeZone} onChange={(e) => setS({ ...s, timeZone: e.target.value })} />
                <datalist id="tz-list">
                  {timeZones.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <div>
                <p className="mb-2 text-sm font-medium text-text-2">Interval rules (recall-heuristic-v1)</p>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-surface-2/60 text-left text-xs text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">First rating</th>
                        <th className="px-3 py-2 font-medium">New card / minimum (days)</th>
                        <th className="px-3 py-2 font-medium">Multiplier on previous interval</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ['bad', 'Bad'],
                          ['good', 'Good'],
                          ['veryGood', 'Very good'],
                          ['perfect', 'Perfect'],
                        ] as const
                      ).map(([k, label]) => (
                        <tr key={k} className="border-t border-border">
                          <td className="px-3 py-2 font-medium">{label}</td>
                          <td className="px-3 py-2">
                            <Input aria-label={`${label}: days`} type="number" min={1} max={3650} className="w-24" value={s.scheduler[k].base} onChange={(e) => rule(k, 'base', e.target.value)} />
                          </td>
                          <td className="px-3 py-2">
                            {s.scheduler[k].multiplier === null ? (
                              <span className="text-muted">Always resets to the base</span>
                            ) : (
                              <Input aria-label={`${label}: multiplier`} type="number" min={1} max={10} step={0.1} className="w-24" value={s.scheduler[k].multiplier ?? ''} onChange={(e) => rule(k, 'multiplier', e.target.value)} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[13px] text-muted">
                  For a reviewed card with previous interval I: next = max(base, ⌈I × multiplier⌉). This is a simple, transparent rule of this app — not FSRS, SM-2 or a calibrated memory model.
                </p>
              </div>
              <Field label="Maximum interval (days)" htmlFor="set-max">
                <Input id="set-max" type="number" min={1} max={3650} className="w-32" value={s.scheduler.maxIntervalDays} onChange={(e) => setS({ ...s, scheduler: { ...s.scheduler, maxIntervalDays: Number(e.target.value) } })} />
              </Field>
            </div>
          </Card>

          <Card id="study" title="Study defaults" icon={<Archive />}>
            <div className="flex flex-col gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Default session size (unique cards)" htmlFor="set-size">
                  <Input id="set-size" type="number" min={1} max={1000} value={s.defaultSessionSize} onChange={(e) => setS({ ...s, defaultSessionSize: Number(e.target.value) })} />
                </Field>
                <Field label="Default max attempts per card" htmlFor="set-att" hint="1–10, including the first attempt.">
                  <Input id="set-att" type="number" min={1} max={10} value={s.defaultMaxAttempts} onChange={(e) => setS({ ...s, defaultMaxAttempts: Number(e.target.value) })} />
                </Field>
              </div>
              <Switch checked={s.includeNewByDefault} onChange={(v) => setS({ ...s, includeNewByDefault: v })} label="Include new cards in scheduled review by default" />
              <Switch checked={s.showHeatmap} onChange={(v) => setS({ ...s, showHeatmap: v })} label="Show activity heatmap" description="On the statistics page." />
              <Switch checked={s.showStreak} onChange={(v) => setS({ ...s, showStreak: v })} label="Show study streak" description="A gentle count of consecutive study days. Purely informational." />
              <Switch checked={!s.ratingIntroSeen} onChange={(v) => setS({ ...s, ratingIntroSeen: !v })} label="Explain the four ratings again" description="Shows the rating guide the next time you reveal an answer." />
            </div>
          </Card>

          {dirty && (
            <div className="anim-pop sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-pop">
              <span className="text-sm">You have unsaved settings.</span>
              {error && <span className="text-sm text-danger">{error}</span>}
              <div className="flex gap-2">
                <Button onClick={() => setS(initial)}>Reset</Button>
                <Button variant="primary" loading={saving} icon={<Save className="size-4" />} onClick={save}>
                  Save settings
                </Button>
              </div>
            </div>
          )}

          <BackupsCard settings={initial} />
          <DataCard />
          <DemoCard />
        </div>
      </div>
    </>
  );
}

// ---------------- Backups ----------------

function BackupsCard({ settings }: { settings: AppSettings }) {
  const toast = useToast();
  const system = useSystem();
  const snaps = useSnapshots();
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ data: RestorePreview; source: string } | null>(null);
  const [b, setB] = useState(settings.backup);
  useEffect(() => setB(settings.backup), [settings.backup]);
  const status = system.data?.backupStatus;

  const pickFile = (onFile: (f: File) => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = () => input.files?.[0] && onFile(input.files[0]);
    input.click();
  };
  const previewFile = (f: File) => {
    setBusy('upload');
    api
      .upload<RestorePreview>('/api/restore/preview', f, f.name)
      .then((data) => setPreview({ data, source: f.name }))
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setBusy(null));
  };
  const saveBackupSettings = async () => {
    try {
      await api.patch('/api/settings', { backup: { ...b, directory: b.directory?.trim() || null } });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['system'] });
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      toast.success('Backup settings saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const backupDirty = JSON.stringify(b) !== JSON.stringify(settings.backup);

  return (
    <Card id="backups" title="Backups & import" icon={<HardDrive />} description="Your data never leaves this computer unless you copy a backup file somewhere yourself.">
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => downloadUrl('/api/export/full')}>
            Export full backup
          </Button>
          <Button icon={<Upload className="size-4" />} loading={busy === 'upload'} onClick={() => pickFile(previewFile)}>
            Restore or import…
          </Button>
          <Button
            icon={<Database className="size-4" />}
            loading={busy === 'snap'}
            onClick={async () => {
              setBusy('snap');
              try {
                await api.post('/api/snapshots');
                queryClient.invalidateQueries({ queryKey: ['snapshots'] });
                queryClient.invalidateQueries({ queryKey: ['system'] });
                toast.success('Snapshot created');
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            Snapshot now
          </Button>
        </div>
        <p className="text-[13px] text-muted">
          A full backup (.zip) contains every program, card, image, schedule, review, session and setting. “Restore or import” accepts a full backup (replaces everything after a preview) or a course package exported from a course page (added as a new course).
          Copy full backups to a separate drive — snapshots on the same disk do not protect against disk failure.
        </p>

        <div className="rounded-2xl border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Automatic snapshots</h3>
            {status?.lastErrorAt && (!status.lastSuccessAt || status.lastErrorAt > status.lastSuccessAt) ? (
              <Badge tone="danger">Last attempt failed</Badge>
            ) : status?.lastSuccessAt ? (
              <Badge tone="success">Last snapshot {formatDateTime(status.lastSuccessAt)}</Badge>
            ) : (
              <Badge>No snapshot yet</Badge>
            )}
          </div>
          {status?.lastError && status.lastErrorAt && (!status.lastSuccessAt || status.lastErrorAt > status.lastSuccessAt) && (
            <Alert tone="danger" className="mb-3">
              {formatDateTime(status.lastErrorAt)}: {status.lastError}
            </Alert>
          )}
          <div className="flex flex-col gap-4">
            <Switch checked={b.enabled} onChange={(v) => setB({ ...b, enabled: v })} label="Create snapshots automatically" description="Uses SQLite’s online backup API, so the copy is always consistent." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Every (hours)" htmlFor="bk-int">
                <Input id="bk-int" type="number" min={1} max={720} value={b.intervalHours} onChange={(e) => setB({ ...b, intervalHours: Number(e.target.value) })} />
              </Field>
              <Field label="Keep the newest" htmlFor="bk-ret" hint="Older automatic snapshots are deleted.">
                <Input id="bk-ret" type="number" min={1} max={200} value={b.retention} onChange={(e) => setB({ ...b, retention: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Snapshot folder" optional htmlFor="bk-dir" hint={`Absolute path. Empty = ${system.data ? system.data.dataDir + '/backups' : 'the data folder'}.`}>
              <Input id="bk-dir" value={b.directory ?? ''} placeholder={system.data?.backupDir} onChange={(e) => setB({ ...b, directory: e.target.value })} />
            </Field>
            {backupDirty && (
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={saveBackupSettings}>
                  Save snapshot settings
                </Button>
                <Button size="sm" onClick={() => setB(settings.backup)}>
                  Reset
                </Button>
              </div>
            )}
          </div>
          <h4 className="mt-5 mb-2 text-sm font-medium text-text-2">Snapshots in {system.data?.backupDir}</h4>
          {snaps.isLoading ? (
            <Spinner />
          ) : (snaps.data ?? []).length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {snaps.data!.map((sn: SnapshotInfo) => (
                <li key={sn.name} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block truncate font-mono text-[13px]">{sn.name}</span>
                    <span className="text-xs text-muted">
                      {formatDateTime(sn.createdAt)} · {formatBytes(sn.sizeBytes)}
                    </span>
                  </span>
                  <Badge>{sn.kind}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        const data = await api.post<RestorePreview>(`/api/snapshots/${encodeURIComponent(sn.name)}/preview`);
                        setPreview({ data, source: sn.name });
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Restore…
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {preview && <RestoreDialog preview={preview.data} source={preview.source} onClose={() => setPreview(null)} />}
    </Card>
  );
}

function RestoreDialog({ preview, source, onClose }: { preview: RestorePreview; source: string; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const tree = useTree();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [semesterId, setSemesterId] = useState('');
  const [includeSchedules, setIncludeSchedules] = useState(false);
  const semesters = (tree.data ?? []).flatMap((p) => p.semesters.map((s) => ({ id: s.id, label: `${p.title} › ${s.title}` })));
  useEffect(() => {
    if (!semesterId && semesters.length) setSemesterId(semesters[0].id);
  }, [semesters.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = preview.counts;
  const isCourse = preview.kind === 'course';

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isCourse) {
        const r = await api.post<{ courseId: string }>('/api/import/package', { token: preview.token, semesterId, includeSchedules });
        invalidateContent();
        toast.success('Course imported');
        onClose();
        navigate(`/courses/${r.courseId}`);
      } else {
        const r = await api.post<{ preRestoreSnapshot: string }>('/api/restore/apply', { token: preview.token, confirm: true });
        queryClient.clear();
        toast.success(`Restored. Your previous data was saved as snapshot ${r.preRestoreSnapshot}.`);
        onClose();
        navigate('/');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: [string, number | undefined][] = isCourse
    ? [
        ['Sections', c.sections],
        ['Cards', c.cards],
        ['Tags', c.tags],
        ['Images', c.media_assets],
        ['Card schedules', c.card_schedules],
      ]
    : [
        ['Study programs', c.programs],
        ['Semesters', c.semesters],
        ['Courses', c.courses],
        ['Sections', c.sections],
        ['Cards', c.cards],
        ['Images', c.media_assets],
        ['Review events', c.review_events],
        ['Study sessions', c.study_sessions],
      ];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      size="lg"
      title={isCourse ? 'Import course package' : 'Restore full backup'}
      description={`${source} · created ${formatDateTime(preview.createdAt)} · app ${preview.appVersion} · schema v${preview.schemaVersion}`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={isCourse ? 'primary' : 'danger'} loading={busy} disabled={isCourse ? !semesterId : !confirm} onClick={apply}>
            {isCourse ? 'Import course' : 'Replace all data'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-success">✓ The file was checked completely (structure, references and images) before anything changes.</p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {rows.map(([label, n]) => (
            <div key={label} className="rounded-xl bg-surface-2 px-3 py-2">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="font-semibold tabular-nums">{n ?? 0}</dd>
            </div>
          ))}
        </dl>
        {preview.includes.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Includes</p>
            <ul className="mt-1 list-disc pl-5 text-text-2">
              {preview.includes.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        {preview.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
        {isCourse ? (
          <>
            <Field label="Add to semester" htmlFor="imp-sem">
              <Select id="imp-sem" value={semesterId} onChange={(e) => setSemesterId(e.target.value)}>
                {semesters.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox checked={includeSchedules} onChange={(e) => setIncludeSchedules(e.target.checked)} label="Keep the cards’ schedules (due dates and intervals)" description="Off: all imported cards start as new. Review history is never part of a course package." />
          </>
        ) : (
          <>
            <Alert tone="danger" title="This replaces everything currently in Recall">
              All-or-nothing: if anything fails, your current data stays untouched. A snapshot of your current data is created first, so you can go back.
            </Alert>
            <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)} label="I understand that my current data will be replaced by this backup" />
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

// ---------------- Data location ----------------

function DataCard() {
  const system = useSystem();
  const d = system.data;
  const rows: [string, string | undefined][] = [
    ['Data folder', d?.dataDir],
    ['Database', d?.dbPath],
    ['Images', d?.mediaDir],
    ['Snapshots', d?.backupDir],
  ];
  return (
    <Card id="data" title="Data location" icon={<ShieldCheck />} description="SQLite is the single source of truth. The browser only keeps disposable preferences like collapsed sidebar groups.">
      <dl className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 rounded-xl bg-surface-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-4">
            <dt className="w-28 shrink-0 text-sm text-muted">{k}</dt>
            <dd className="min-w-0 font-mono text-[13px] break-all">{v ?? '…'}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 flex flex-col gap-1.5 text-[13px] text-muted">
        <li>
          • Change the folder by starting Recall with <code className="rounded bg-surface-2 px-1">--data-dir /path</code> or <code className="rounded bg-surface-2 px-1">RECALL_DATA_DIR</code>.
        </li>
        <li>• Rebuilding or updating the app never touches this folder.</li>
        <li>
          • Recall listens only on {d ? `${d.host}:${d.port}` : 'the loopback address'} and is not reachable from your network. Loopback is not a password: other programs or users on this computer could reach it.
        </li>
        {d && (
          <li>
            • Version {d.appVersion} · database schema v{d.schemaVersion} · Node {d.nodeVersion}
          </li>
        )}
      </ul>
    </Card>
  );
}

// ---------------- Demo ----------------

function DemoCard() {
  const dash = useDashboard();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const loaded = dash.data?.demoLoaded;
  return (
    <Card id="demo" title="Demo content" icon={<FlaskConical />} description="A small, clearly labelled Computer Vision demo course with equations, code, an image and a long answer. Not an official syllabus or exam source.">
      {loaded ? (
        <Button
          loading={busy}
          icon={<Package className="size-4" />}
          onClick={async () => {
            setBusy(true);
            try {
              await api.del('/api/demo');
              invalidateContent();
              toast.success('Demo content removed');
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Remove demo content
        </Button>
      ) : (
        <Button
          loading={busy}
          icon={<FlaskConical className="size-4" />}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<{ courseId: string }>('/api/demo');
              invalidateContent();
              toast.success('Demo course loaded');
              navigate(`/courses/${r.courseId}`);
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Load demo course
        </Button>
      )}
      <p className="mt-2 text-[13px] text-muted">Removing it deletes only the demo program and its cards, history and image — never your own content.</p>
    </Card>
  );
}
