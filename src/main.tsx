import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, useParams, useRouteError } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { HierarchyDialogs } from './components/HierarchyDialogs.tsx';
import { AppShell } from './components/layout/AppShell.tsx';
import { Button, LinkButton } from './components/ui/Button.tsx';
import { EmptyState } from './components/ui/Feedback.tsx';
import { ToastProvider } from './components/ui/Toast.tsx';
import { TooltipProvider } from './components/ui/Tooltip.tsx';
import { queryClient, useSettings } from './lib/queries.ts';
import { applyTheme, cachedPreference, rememberPreference } from './lib/theme.ts';
import { CardEditor } from './pages/CardEditor.tsx';
import { CoursePage } from './pages/CoursePage.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { HelpPage } from './pages/HelpPage.tsx';
import { Organizer } from './pages/Organizer.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { SectionPage } from './pages/SectionPage.tsx';
import { SessionBuilder } from './pages/SessionBuilder.tsx';
import { SessionResultsPage } from './pages/SessionResults.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { StatsPage } from './pages/StatsPage.tsx';
import { StudyScreen } from './pages/StudyScreen.tsx';
import { TrashPage } from './pages/TrashPage.tsx';

// Apply the cached preference before first paint to avoid a flash.
applyTheme(cachedPreference());

function ThemeSync() {
  const settings = useSettings();
  const pref = settings.data?.theme ?? cachedPreference();
  useEffect(() => {
    applyTheme(pref);
    rememberPreference(pref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(pref);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return null;
}

/** Remount a page when its :id changes, so selections, filters and searches never leak between items. */
function KeyedById({ page: Page }: { page: ComponentType }) {
  const { id } = useParams();
  return <Page key={id} />;
}

function Root() {
  return (
    <HierarchyDialogs>
      <ThemeSync />
      <Outlet />
    </HierarchyDialogs>
  );
}

function RouteError() {
  const error = useRouteError() as Error | undefined;
  return (
    <div className="mx-auto max-w-xl px-4 py-20">
      <EmptyState
        title="This page hit an error"
        action={
          <>
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <LinkButton to="/" variant="primary">
              Go to dashboard
            </LinkButton>
          </>
        }
      >
        {error?.message ?? 'Unknown error'}. Your data is stored safely in the local database.
      </EmptyState>
    </div>
  );
}

function NotFound() {
  return (
    <EmptyState title="Page not found" action={<LinkButton to="/">Back to dashboard</LinkButton>}>
      This page doesn’t exist, or the item was deleted.
    </EmptyState>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { path: '/study/:id', element: <KeyedById page={StudyScreen} /> },
      {
        element: <AppShell />,
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <Dashboard /> },
          { path: '/organize', element: <Organizer /> },
          { path: '/courses/:id', element: <KeyedById page={CoursePage} /> },
          { path: '/sections/:id', element: <KeyedById page={SectionPage} /> },
          { path: '/cards/new', element: <CardEditor /> },
          { path: '/cards/:id/edit', element: <CardEditor /> },
          { path: '/study/new', element: <SessionBuilder /> },
          { path: '/study/:id/results', element: <KeyedById page={SessionResultsPage} /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/stats', element: <StatsPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '/help', element: <HelpPage /> },
          { path: '/trash', element: <TrashPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
