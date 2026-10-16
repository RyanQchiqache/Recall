import { useToast } from '../components/ui/Toast.tsx';
import { api, errorMessage } from './api.ts';
import { plural } from './format.ts';
import { invalidateContent } from './queries.ts';

export interface CardActionResult {
  affected: number;
  undoId?: string;
}

export function useCardActionUndo() {
  const toast = useToast();
  return (result: CardActionResult, message: string, undoneMessage = 'Action undone') => {
    toast.success(
      message,
      result.undoId
        ? {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  const undone = await api.post<{ affected: number }>(`/api/cards/actions/${result.undoId}/undo`);
                  invalidateContent();
                  toast.success(`${undoneMessage} · ${plural(undone.affected, 'card')}`);
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              })();
            },
          }
        : undefined,
    );
  };
}
