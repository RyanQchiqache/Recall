import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/util.ts';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function Menu({ items, label = 'More actions', trigger, align = 'end' }: { items: (MenuItem | false | null | undefined)[]; label?: string; trigger?: ReactNode; align?: 'start' | 'end' }) {
  const list = items.filter(Boolean) as MenuItem[];
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <button aria-label={label} className="inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2">
            <MoreHorizontal className="size-5" />
          </button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={6} className="anim-pop z-50 min-w-52 rounded-xl border border-border bg-surface p-1.5 shadow-pop">
          {list.map((item, i) => (
            <div key={`${item.label}-${i}`}>
              {item.separatorBefore && i > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
              <DropdownMenu.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2',
                  item.danger ? 'text-danger' : 'text-text',
                )}
              >
                <span className="flex size-4 items-center justify-center [&_svg]:size-4">{item.icon}</span>
                {item.label}
              </DropdownMenu.Item>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
