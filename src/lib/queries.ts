import { QueryClient, useQuery } from '@tanstack/react-query';
import type { AppSettings } from '../../shared/settings.ts';
import type {
  Note,
  NoteTemplate,
  Card,
  CardListResponse,
  Course,
  Crumb,
  DashboardData,
  Program,
  Section,
  Semester,
  SessionResults,
  SessionState,
  SessionSummary,
  SnapshotInfo,
  StatsData,
  SystemInfo,
  TrashItem,
  TreeProgram,
} from '../../shared/types.ts';
import { api, qs } from './api.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 },
    mutations: { retry: 0 },
  },
});

/** Refresh everything that depends on cards / hierarchy. */
export function invalidateContent() {
  for (const key of ['tree', 'dashboard', 'course', 'section', 'cards', 'card', 'stats', 'trash', 'tags', 'preview', 'openSession', 'session', 'results', 'templates', 'template']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export interface ItemResponse<T> {
  item: T;
  breadcrumbs: Crumb[];
  state: { inTrash: boolean; inArchive: boolean };
}

export const useTree = (includeArchived = false) =>
  useQuery({ queryKey: ['tree', includeArchived], queryFn: () => api.get<TreeProgram[]>(`/api/tree${qs({ includeArchived })}`) });

export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard') });

export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/api/settings'), staleTime: 60_000 });

export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system') });

export const useProgram = (id?: string) =>
  useQuery({ queryKey: ['program', id], queryFn: () => api.get<ItemResponse<Program>>(`/api/programs/${id}`), enabled: !!id });
export const useSemester = (id?: string) =>
  useQuery({ queryKey: ['semester', id], queryFn: () => api.get<ItemResponse<Semester>>(`/api/semesters/${id}`), enabled: !!id });
export const useCourse = (id?: string) =>
  useQuery({ queryKey: ['course', id], queryFn: () => api.get<ItemResponse<Course>>(`/api/courses/${id}`), enabled: !!id });
export const useSection = (id?: string) =>
  useQuery({ queryKey: ['section', id], queryFn: () => api.get<ItemResponse<Section>>(`/api/sections/${id}`), enabled: !!id });

export interface CardQuery {
  sectionId?: string;
  courseId?: string;
  semesterId?: string;
  programId?: string;
  q?: string;
  filter?: string;
  tag?: string;
  sort?: string;
  includeArchived?: boolean;
  limit?: number;
}
export const useCards = (params: CardQuery, enabled = true) =>
  useQuery({
    queryKey: ['cards', params],
    queryFn: () => api.get<CardListResponse>(`/api/cards${qs({ ...params })}`),
    enabled,
    placeholderData: (prev) => prev,
  });

export const useCard = (id?: string) =>
  useQuery({
    queryKey: ['card', id],
    queryFn: () => api.get<{ card: Card; note: Note; breadcrumbs: Crumb[] }>(`/api/cards/${id}`),
    enabled: !!id,
    staleTime: 0,
  });

export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => api.get<{ name: string; count: number }[]>('/api/tags') });

export const useOpenSession = () =>
  useQuery({ queryKey: ['openSession'], queryFn: () => api.get<SessionSummary | null>('/api/sessions/open') });

export const useSession = (id?: string) =>
  useQuery({
    queryKey: ['session', id],
    queryFn: () => api.get<SessionState>(`/api/sessions/${id}`),
    enabled: !!id,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

export const useSessionResults = (id?: string) =>
  useQuery({ queryKey: ['results', id], queryFn: () => api.get<SessionResults>(`/api/sessions/${id}/results`), enabled: !!id });

export const useStats = (params: Record<string, string | undefined>) =>
  useQuery({ queryKey: ['stats', params], queryFn: () => api.get<StatsData>(`/api/stats${qs(params)}`), placeholderData: (p) => p });

export const useTrash = () => useQuery({ queryKey: ['trash'], queryFn: () => api.get<TrashItem[]>('/api/trash') });

export const useSnapshots = () => useQuery({ queryKey: ['snapshots'], queryFn: () => api.get<SnapshotInfo[]>('/api/snapshots') });

export const useTemplates = (includeArchived = false) =>
  useQuery({ queryKey: ['templates', includeArchived], queryFn: () => api.get<NoteTemplate[]>(`/api/templates${qs({ includeArchived })}`) });

export const useTemplate = (id?: string) =>
  useQuery({ queryKey: ['template', id], queryFn: () => api.get<NoteTemplate>(`/api/templates/${id}`), enabled: !!id, staleTime: 0 });
