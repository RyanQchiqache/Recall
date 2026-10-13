import { FileUp } from 'lucide-react';
import { useState } from 'react';
import type { CsvPreview, Section } from '../../shared/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { plural } from '../lib/format.ts';
import { invalidateContent } from '../lib/queries.ts';
import { cn } from '../lib/util.ts';
import { Button } from './ui/Button.tsx';
import { Alert, Badge } from './ui/Feedback.tsx';
import { Checkbox, Field, Select, Segmented, Textarea } from './ui/Form.tsx';
import { Modal } from './ui/Dialog.tsx';
import { useToast } from './ui/Toast.tsx';

const FIELDS = [
  { key: 'front', label: 'Front (question)', required: true },
  { key: 'back', label: 'Back (answer)', required: true },
  { key: 'section', label: 'Section' },
  { key: 'tags', label: 'Tags (separated by ; , or |)' },
  { key: 'source', label: 'Source' },
  { key: 'explanation', label: 'Explanation' },
  { key: 'hint', label: 'Hint' },
] as const;

interface Inspect {
  headers: string[];
  sample: string[][];
  totalRows: number;
  suggestedMapping: Record<string, number | null>;
}

export function CsvImportDialog({ courseId, courseTitle, sections, onClose }: { courseId: string; courseTitle: string; sections: Section[]; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [hasHeader, setHasHeader] = useState(true);
  const [defaultSection, setDefaultSection] = useState<string>(sections[0]?.id ?? '');
  const [dupPolicy, setDupPolicy] = useState<'skip' | 'import'>('skip');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [confirmSections, setConfirmSections] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = () => ({ text, courseId, hasHeader, mapping, defaultSectionId: defaultSection || null, duplicatePolicy: dupPolicy });

  const doInspect = async (t: string) => {
    setError(null);
    setPreview(null);
    setBusy(true);
    try {
      const r = await api.post<Inspect>('/api/import/csv/inspect', { text: t });
      setInspect(r);
      setMapping(r.suggestedMapping);
    } catch (e) {
      setError(errorMessage(e));
      setInspect(null);
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    setError(null);
    if (mapping.front == null || mapping.back == null) {
      setError('Map both the front and the back column.');
      return;
    }
    setBusy(true);
    try {
      setPreview(await api.post<CsvPreview>('/api/import/csv/preview', body()));
      setConfirmSections(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ imported: number; skippedDuplicates: number; skippedErrors: number; createdSections: number }>('/api/import/csv/apply', { ...body(), confirmCreateSections: confirmSections });
      invalidateContent();
      toast.success(`Imported ${plural(r.imported, 'card')}${r.createdSections ? ` and created ${plural(r.createdSections, 'section')}` : ''}.`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canImport = preview && (preview.valid > 0 || (dupPolicy === 'import' && preview.duplicates > 0)) && (!preview.sectionsToCreate.length || confirmSections);

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={`Import CSV into ${courseTitle}`}
      description="Columns are mapped to card fields. Nothing is saved until you confirm the preview."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!preview ? (
            <Button variant="primary" onClick={doPreview} disabled={!inspect} loading={busy}>
              Preview import
            </Button>
          ) : (
            <>
              <Button onClick={() => setPreview(null)}>Back to mapping</Button>
              <Button variant="primary" onClick={doImport} disabled={!canImport} loading={busy}>
                Import {plural(preview.valid + (dupPolicy === 'import' ? preview.duplicates : 0), 'card')}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {!preview && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-medium shadow-soft hover:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]">
                <FileUp className="size-4" aria-hidden />
                Choose CSV file
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const t = await f.text();
                    setText(t);
                    setFileName(f.name);
                    void doInspect(t);
                  }}
                />
              </label>
              <span className="text-sm text-muted">{fileName || 'UTF-8 CSV with quoted fields and multi-line text is supported.'}</span>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">…or paste CSV text</summary>
              <Textarea className="mt-2 font-mono text-sm" rows={5} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && doInspect(text)} placeholder={'front,back,section,tags\n"What is NMS?","Removes duplicate boxes",Week 3,cv'} />
            </details>
            {inspect && (
              <>
                <p className="text-sm text-text-2">
                  Found {plural(inspect.totalRows, 'data row')} and {plural(inspect.headers.length, 'column')}.
                </p>
                <Checkbox checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} label="The first row contains column names" />
                <div className="grid gap-4 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <Field key={f.key} label={f.label} htmlFor={`map-${f.key}`} optional={!('required' in f)}>
                      <Select id={`map-${f.key}`} value={mapping[f.key] == null ? '' : String(mapping[f.key])} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })}>
                        <option value="">— Not imported —</option>
                        {inspect.headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                  <Field label="Section for rows without one" htmlFor="map-default" hint={mapping.section == null ? 'All rows go here.' : 'Used when a row’s section cell is empty.'}>
                    <Select id="map-default" value={defaultSection} onChange={(e) => setDefaultSection(e.target.value)}>
                      <option value="">— None (rows need a section) —</option>
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Cards that already exist in the destination section" htmlFor="dup">
                  <Segmented
                    ariaLabel="Duplicate handling"
                    value={dupPolicy}
                    onChange={setDupPolicy}
                    options={[
                      { value: 'skip', label: 'Skip duplicates' },
                      { value: 'import', label: 'Import them anyway' },
                    ]}
                  />
                </Field>
              </>
            )}
          </>
        )}
        {preview && (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">{plural(preview.valid, 'new card')}</Badge>
              <Badge tone={preview.duplicates ? 'warning' : 'neutral'}>{plural(preview.duplicates, 'duplicate')}</Badge>
              <Badge tone={preview.errors ? 'danger' : 'neutral'}>{plural(preview.errors, 'row')} with errors (skipped)</Badge>
            </div>
            {preview.sectionsToCreate.length > 0 && (
              <Alert tone="warning" title={`${plural(preview.sectionsToCreate.length, 'section')} will be created`}>
                <p>{preview.sectionsToCreate.join(', ')}</p>
                <Checkbox className="mt-2" checked={confirmSections} onChange={(e) => setConfirmSections(e.target.checked)} label="Create these sections in this course" />
              </Alert>
            )}
            <div className="max-h-[45vh] overflow-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium">Front</th>
                    <th className="px-3 py-2 font-medium">Back</th>
                    <th className="px-3 py-2 font-medium">Section</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className={cn('border-t border-border align-top', r.status === 'error' && 'bg-danger-soft/50')}>
                      <td className="px-3 py-2 text-muted tabular-nums">{r.row}</td>
                      <td className="max-w-56 px-3 py-2">
                        <span className="line-clamp-3 whitespace-pre-wrap">{r.front || <em className="text-muted">empty</em>}</span>
                      </td>
                      <td className="max-w-56 px-3 py-2">
                        <span className="line-clamp-3 whitespace-pre-wrap">{r.back || <em className="text-muted">empty</em>}</span>
                      </td>
                      <td className="px-3 py-2">{r.section}</td>
                      <td className="px-3 py-2">
                        {r.status === 'ok' ? <Badge tone="success">OK</Badge> : r.status === 'duplicate' ? <Badge tone="warning">Duplicate</Badge> : <span className="text-danger">{r.errors.join('; ')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.totalRows > preview.rows.length && <p className="text-sm text-muted">Showing the first {preview.rows.length} of {preview.totalRows} rows.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
