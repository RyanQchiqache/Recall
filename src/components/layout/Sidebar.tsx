import { BarChart3, ChevronRight, FolderTree, LayoutDashboard, Moon, Play, Plus, Search, Settings, Sun, Trash2 } from 'lucide-react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import type { TreeProgram } from '../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { queryClient, useOpenSession, useSettings, useTree } from '../../lib/queries.ts';
import { cn, courseVars, usePersistentState } from '../../lib/util.ts';
import { useHierarchy } from '../HierarchyDialogs.tsx';
import { Logo } from './Logo.tsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/study/new', label: 'Study', icon: Play },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/stats', label: 'Statistics', icon: BarChart3 },
  { to: '/organize', label: 'Organize', icon: FolderTree },
  { to: '/trash', label: 'Trash', icon: Trash2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const settings = useSettings();
  const open = useOpenSession();
  const h = useHierarchy();
  const navigate = useNavigate();
  const dark = document.documentElement.classList.contains('dark');

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <Logo />
        <span className="truncate text-[17px] font-semibold tracking-tight">{settings.data?.appName ?? 'Recall'}</span>
      </div>

      {open.data && (
        <button
          onClick={() => {
            onNavigate?.();
            navigate(`/study/${open.data!.id}`);
          }}
          className="mx-3 mb-2 flex items-center gap-3 rounded-xl bg-primary px-3 py-2.5 text-left text-on-primary shadow-soft transition hover:bg-primary-hover"
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

      <ul className="flex flex-col gap-0.5 px-3">
        {NAV.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-9 items-center gap-3 rounded-lg px-2.5 text-[15px] font-medium transition-colors duration-150',
                  isActive ? 'bg-surface text-text shadow-soft' : 'text-text-2 hover:bg-surface-3/60 hover:text-text',
                )
              }
            >
              <n.icon className="size-[18px] shrink-0" aria-hidden />
              {n.label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between px-5 pb-1">
        <span className="text-xs font-semibold tracking-wider text-muted uppercase">Library</span>
        <button
          onClick={() => h.create('course')}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-surface-3/60 hover:text-text"
          aria-label="Create course"
        >
          <Plus className="size-3.5" /> Course
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <LibraryTree onNavigate={onNavigate} />
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="text-xs text-muted">Local · offline</span>
        <button
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3/60 hover:text-text"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={async () => {
            const theme = dark ? 'light' : 'dark';
            await api.patch('/api/settings', { theme });
            queryClient.invalidateQueries({ queryKey: ['settings'] });
          }}
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
                                      cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-3/60', a ? 'bg-surface font-medium text-text shadow-soft' : 'text-text-2')
                                    }
                                  >
                                    <span className="size-2 shrink-0 rounded-full bg-[var(--course)]" aria-hidden />
                                    <span className="truncate">{c.title}</span>
                                    {c.counts.due > 0 && (
                                      <span className="ml-auto shrink-0 rounded-full bg-primary-soft px-1.5 text-[11px] font-semibold text-primary-text tabular-nums" aria-label={`${c.counts.due} due`}>
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
                                            cn('block truncate rounded-md px-1.5 py-0.5 text-[13px] hover:bg-surface-3/60', a ? 'bg-surface font-medium text-text shadow-soft' : 'text-muted')
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
    <button onClick={onClick} className={cn('flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1 text-left hover:bg-surface-3/60', className)} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}>
      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
      <span className="truncate text-[13px]">{label}</span>
    </button>
  );
}
