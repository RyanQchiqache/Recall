import { BarChart3, ChevronRight, CircleHelp, FolderTree, LayoutDashboard, Moon, Play, Plus, Search, Settings, Sun, Trash2 } from 'lucide-react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import type { TreeProgram } from '../../../shared/types.ts';
import { useOpenSession, useSettings, useTree } from '../../lib/queries.ts';
import { setThemePreference, useIsDark } from '../../lib/theme.ts';
import { cn, courseVars, usePersistentState } from '../../lib/util.ts';
import { useHierarchy } from '../HierarchyDialogs.tsx';
import { Kbd } from '../ui/Feedback.tsx';
import { Logo } from './Logo.tsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/study/new', label: 'Study', icon: Play },
  { to: '/stats', label: 'Statistics', icon: BarChart3 },
  { to: '/organize', label: 'Organize', icon: FolderTree },
  { to: '/trash', label: 'Trash', icon: Trash2 },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/help', label: 'How to', icon: CircleHelp },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const settings = useSettings();
  const open = useOpenSession();
  const tree = useTree();
  const h = useHierarchy();
  const navigate = useNavigate();
  const dark = useIsDark();
  const totals = (tree.data ?? []).reduce((t, p) => ({ due: t.due + p.counts.due, total: t.total + p.counts.total }), { due: 0, total: 0 });

  return (
    <nav aria-label="Main" className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <Logo size={26} />
        <span className="truncate text-[16px] font-semibold tracking-[-0.01em]">{settings.data?.appName ?? 'Recall'}</span>
      </div>

      <div className="px-3 pb-3">
        <Link
          to="/search"
          onClick={onNavigate}
          className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-sm text-muted shadow-soft transition-colors duration-150 hover:border-border-strong hover:text-text-2"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate">Search cards</span>
          <Kbd>/</Kbd>
        </Link>
      </div>

      {open.data && (
        <button
          onClick={() => {
            onNavigate?.();
            navigate(`/study/${open.data!.id}`);
          }}
          className="mx-3 mb-3 flex items-center gap-3 rounded-lg bg-primary px-3 py-2 text-left text-on-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.14),var(--shadow-sm)] transition-colors duration-150 hover:bg-primary-hover"
        >
          <Play className="size-4 shrink-0 fill-current" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Resume session</span>
            <span className="block truncate text-xs opacity-85">
              {open.data.progress.completed + open.data.progress.unresolved} of {open.data.progress.selected} cards done
            </span>
          </span>
        </button>
      )}

      <ul className="flex flex-col gap-px px-3">
        {NAV.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150',
                  isActive ? 'bg-primary-soft text-primary-text' : 'text-text-2 hover:bg-surface-2 hover:text-text',
                )
              }
            >
              <n.icon className="size-4 shrink-0 opacity-80" aria-hidden />
              <span className="flex-1">{n.label}</span>
              {n.to === '/study/new' && totals.due > 0 && (
                <span className="text-xs font-medium text-muted tabular-nums" aria-label={`${totals.due} cards due`}>
                  {totals.due}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center justify-between px-5 pb-1.5">
        <span className="text-[13px] font-medium text-muted">Library</span>
        <button
          onClick={() => h.create('course')}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Create course"
        >
          <Plus className="size-3.5" /> Course
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <LibraryTree onNavigate={onNavigate} />
      </div>

      <div className="mx-3 flex items-center justify-between border-t border-border px-2 py-3">
        <span className="flex items-center gap-2 text-xs text-muted">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          Saved locally{tree.data ? ` · ${totals.total} ${totals.total === 1 ? 'card' : 'cards'}` : ''}
        </span>
        <button
          className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setThemePreference(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </nav>
  );
}

function LibraryTree({ onNavigate }: { onNavigate?: () => void }) {
  const tree = useTree();
  const location = useLocation();
  const [expanded, setExpanded] = usePersistentState<Record<string, boolean>>('recall.sidebar.expanded', {});
  const toggle = (id: string, def: boolean) => setExpanded({ ...expanded, [id]: !(expanded[id] ?? def) });
  const data: TreeProgram[] = tree.data ?? [];
  if (tree.isLoading) return <p className="px-2 py-1 text-sm text-muted">Loading…</p>;
  if (!data.length) return <p className="px-2 py-1 text-sm text-muted">No courses yet.</p>;

  const isActive = (path: string) => location.pathname === path;
  return (
    <ul className="flex flex-col gap-0.5 text-sm" role="tree" aria-label="Programs, semesters and courses">
      {data.map((p) => {
        const pOpen = expanded[p.id] ?? true;
        return (
          <li key={p.id} role="treeitem" aria-expanded={pOpen} aria-selected={false}>
            <TreeToggle open={pOpen} onClick={() => toggle(p.id, true)} label={p.title} className="font-semibold text-text-2" />
            {pOpen && (
              <ul role="group" className="ml-2 border-l border-border pl-1.5">
                {p.semesters.map((s) => {
                  const sOpen = expanded[s.id] ?? true;
                  return (
                    <li key={s.id} role="treeitem" aria-expanded={sOpen} aria-selected={false}>
                      <TreeToggle open={sOpen} onClick={() => toggle(s.id, true)} label={s.title} className="text-muted" />
                      {sOpen && (
                        <ul role="group" className="flex flex-col gap-0.5">
                          {s.courses.length === 0 && <li className="py-1 pl-6 text-xs text-muted">No courses</li>}
                          {s.courses.map((c) => {
                            const cOpen = expanded[c.id] ?? false;
                            return (
                              <li key={c.id} role="treeitem" aria-expanded={cOpen} aria-selected={isActive(`/courses/${c.id}`)}>
                                <div className="flex items-center">
                                  <button
                                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-text"
                                    aria-label={cOpen ? `Collapse ${c.title}` : `Expand ${c.title}`}
                                    onClick={() => toggle(c.id, false)}
                                  >
                                    <ChevronRight className={cn('size-3.5 transition-transform duration-150', cOpen && 'rotate-90')} />
                                  </button>
                                  <NavLink
                                    to={`/courses/${c.id}`}
                                    onClick={onNavigate}
                                    style={courseVars(c.color)}
                                    className={({ isActive: a }) =>
                                      cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2', a ? 'bg-primary-soft font-medium text-primary-text' : 'text-text-2')
                                    }
                                  >
                                    <span className="size-2 shrink-0 rounded-[3px] bg-[var(--course)]" aria-hidden />
                                    <span className="truncate">{c.title}</span>
                                    {c.counts.due > 0 && (
                                      <span className="ml-auto shrink-0 pl-1 text-xs font-medium text-primary-text tabular-nums" aria-label={`${c.counts.due} due`}>
                                        {c.counts.due}
                                      </span>
                                    )}
                                  </NavLink>
                                </div>
                                {cOpen && (
                                  <ul role="group" className="ml-[22px] flex flex-col gap-0.5 border-l border-border pl-1.5">
                                    {c.sections.length === 0 && <li className="py-0.5 pl-1.5 text-xs text-muted">No sections</li>}
                                    {c.sections.map((sec) => (
                                      <li key={sec.id} role="treeitem" aria-selected={isActive(`/sections/${sec.id}`)}>
                                        <NavLink
                                          to={`/sections/${sec.id}`}
                                          onClick={onNavigate}
                                          className={({ isActive: a }) =>
                                            cn('block truncate rounded-md px-1.5 py-0.5 text-[13px] hover:bg-surface-2', a ? 'bg-primary-soft font-medium text-primary-text' : 'text-muted')
                                          }
                                        >
                                          {sec.title}
                                        </NavLink>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TreeToggle({ open, onClick, label, className }: { open: boolean; onClick: () => void; label: string; className?: string }) {
  return (
    <button onClick={onClick} className={cn('flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1 text-left hover:bg-surface-2', className)} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}>
      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
      <span className="truncate text-[13px]">{label}</span>
    </button>
  );
}
