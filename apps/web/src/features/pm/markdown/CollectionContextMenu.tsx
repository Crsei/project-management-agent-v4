import { Fragment, useState, type ReactElement } from 'react';
import type { ContextMenuAction, ContextMenuRenderer } from '@pm-views';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** Freeze the clicked source and callbacks until this menu closes. */
export function CollectionContextMenu({ trigger, actions }: { trigger: ReactElement; actions: ContextMenuAction[] }) {
  const [snapshot, setSnapshot] = useState<ContextMenuAction[] | null>(null);
  return <ContextMenu onOpenChange={open => setSnapshot(open ? actions : null)}>
    <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
    <ContextMenuContent>{(snapshot ?? actions).map(action => <Fragment key={action.id}>
      {action.separatorBefore && <ContextMenuSeparator className="my-1 border-t border-border" />}
      <ContextMenuItem disabled={action.disabled} title={action.reason} className={action.destructive ? 'text-destructive' : undefined} onSelect={() => { if (!action.disabled) action.onSelect(); }}>
        <span className="flex flex-col"><span>{action.label}</span>{action.reason && <small className="max-w-72 text-xs text-muted-foreground">{action.reason}</small>}</span>
      </ContextMenuItem>
    </Fragment>)}</ContextMenuContent>
  </ContextMenu>;
}

/** Ellipsis and context surfaces consume the exact same action descriptors. */
export function CollectionActionMenu({ trigger, actions }: { trigger: ReactElement; actions: ContextMenuAction[] }) {
  const [snapshot, setSnapshot] = useState<ContextMenuAction[] | null>(null);
  return <DropdownMenu onOpenChange={open => setSnapshot(open ? actions : null)}>
    <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent align="end">{(snapshot ?? actions).map(action => <Fragment key={action.id}>
      {action.separatorBefore && <DropdownMenuSeparator className="my-1 border-t border-border" />}
      <DropdownMenuItem disabled={action.disabled} title={action.reason} className={action.destructive ? 'text-destructive' : undefined} onSelect={() => { if (!action.disabled) action.onSelect(); }}>
        <span className="flex flex-col"><span>{action.label}</span>{action.reason && <small className="max-w-72 text-xs text-muted-foreground">{action.reason}</small>}</span>
      </DropdownMenuItem>
    </Fragment>)}</DropdownMenuContent>
  </DropdownMenu>;
}

export const renderCollectionContextMenu: ContextMenuRenderer = (trigger, actions) => <CollectionContextMenu trigger={trigger} actions={actions} />;
