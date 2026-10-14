import { Menu as MenuIcon, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import type { Crumb } from '../../../shared/types.ts';
import { useSettings } from '../../lib/queries.ts';
import { cn, dialogOpen, isTypingTarget, useDocumentTitle } from '../../lib/util.ts';
import { Logo } from './Logo.tsx';
import { Sidebar } from './Sidebar.tsx';

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const settings = useSettings();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    if (!drawer) return;
    closeButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawer(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      menuButtonRef.current?.focus();
    };
  }, [drawer]);

  // "/" jumps to search (ignored while typing or in dialogs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target) && !dialogOpen()) {
        e.preventDefault();
        navigate('/search');
      }
    };
    // Capture phase: runs before Radix closes a dialog on Escape, so dialogOpen() is still accurate.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate]);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-[80] rounded-lg bg-surface px-3 py-2 shadow-pop focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>

      {/* Mobile / tablet top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button ref={menuButtonRef} className="-ml-2 inline-flex size-10 items-center justify-center rounded-lg hover:bg-surface-2" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <MenuIcon className="size-5" />
        </button>
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Logo size={24} />
          {settings.data?.appName ?? 'Recall'}
        </Link>
      </header>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="anim-fade absolute inset-0 bg-[rgb(15_17_25/0.45)]" onClick={() => setDrawer(false)} />
          <div className="anim-slide absolute inset-y-0 left-0 w-[min(300px,85vw)] border-r border-border bg-surface shadow-pop">
            <button ref={closeButtonRef} className="absolute top-4 right-3 z-10 inline-flex size-9 items-center justify-center rounded-lg hover:bg-surface-3" aria-label="Close navigation" onClick={() => setDrawer(false)}>
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 focus:outline-none lg:pl-[248px]">
        <div className="mx-auto w-full max-w-[1160px] px-4 pt-6 pb-24 sm:px-6 lg:px-12 lg:pt-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function Breadcrumbs({ crumbs, current }: { crumbs: Crumb[]; current?: string }) {
  const href = (c: Crumb) => (c.level === 'course' ? `/courses/${c.id}` : c.level === 'section' ? `/sections/${c.id}` : `/organize#${c.id}`);
  const items = current ? crumbs : crumbs.slice(0, -1);
  if (!items.length && !current) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-2 min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-muted">
        {items.map((c) => (
          <li key={c.id} className="flex min-w-0 items-center gap-1.5">
            <Link to={href(c)} className="truncate hover:text-text hover:underline">
              {c.title}
            </Link>
            <span aria-hidden>/</span>
          </li>
        ))}
        {current && (
          <li aria-current="page" className="truncate text-text-2">
            {current}
          </li>
        )}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
  icon,
  className,
  docTitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  crumbs?: ReactNode;
  icon?: ReactNode;
  className?: string;
  docTitle?: string;
}) {
  const settings = useSettings();
  useDocumentTitle(docTitle ?? (typeof title === 'string' ? title : ''), settings.data?.appName);
  return (
    <header className={cn('mb-7', className)}>
      {crumbs}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-4">
          {icon}
          <div className="min-w-0">
            <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[28px]">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em]">
        {children}
      </h2>
      {action}
    </div>
  );
}
