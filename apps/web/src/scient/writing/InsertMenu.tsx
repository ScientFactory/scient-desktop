import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, Table as TableIcon } from "lucide-react";

import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import type { ShortcutPresentation } from "../keyboard/presentation";
import { DocumentTableSizeMenu } from "./DocumentTableSizeMenu";
import { WritingCommandIcon } from "./commandIcons";
import { WRITING_COMMAND_LABELS } from "./commandNames";
import { dockButtonClass, DockCommandItem, MenuRow } from "./dockChrome";

/** One thing a document editor can insert. Each editor lists only what it can save. */
export interface InsertMenuAction {
  readonly id: string;
  readonly label: string;
  /** Read by assistive technology and searched together with the label. */
  readonly description?: string | undefined;
  readonly group?: string | undefined;
  readonly icon?: ReactNode;
  readonly shortcut?: ShortcutPresentation | undefined;
  readonly run: () => void;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
}

/**
 * How an editor arranges its items when nothing is searched: `item` draws one
 * action by id, `table` is the table size picker (null when the editor passes
 * no `onInsertTable`).
 */
export type InsertMenuLayout = (item: (id: string) => ReactNode, table: ReactNode) => ReactNode;

/**
 * The inside of the Insert menu, shared by the document editors: each editor's
 * own arrangement of its actions. The bar's menu and the More menu use the same
 * content.
 */
export function InsertMenuContent(props: {
  readonly actions: readonly InsertMenuAction[];
  readonly layout: InsertMenuLayout;
  readonly onInsertTable?: ((rows: number, columns: number) => void) | undefined;
  /** When set, nothing can be inserted and this says why. */
  readonly unavailableReason?: string | undefined;
  /** Lets the menu close before the command runs. */
  readonly onRun?: ((command: () => void) => void) | undefined;
}) {
  const run = (command: () => void) => (props.onRun ? props.onRun(command) : command());
  const actionById = new Map(props.actions.map((action) => [action.id, action]));
  const renderAction = (id: string) => {
    const action = actionById.get(id);
    if (!action) return null;
    const reason = props.unavailableReason ?? action.disabledReason;
    return (
      <DockCommandItem
        key={id}
        disabled={Boolean(reason) || action.disabled}
        aria-description={reason ?? action.description}
        aria-keyshortcuts={action.shortcut?.ariaKeyShortcuts}
        title={reason}
        onClick={() => run(action.run)}
      >
        <MenuRow icon={action.icon} label={action.label} shortcut={action.shortcut} />
      </DockCommandItem>
    );
  };
  const onInsertTable = props.onInsertTable;
  const table =
    onInsertTable === undefined ? null : props.unavailableReason ? (
      <DockCommandItem disabled title={props.unavailableReason}>
        <MenuRow icon={<TableIcon className="size-4 text-muted-foreground" />} label="Table" />
      </DockCommandItem>
    ) : (
      <DocumentTableSizeMenu
        onInsert={({ rows, columns }) => run(() => onInsertTable(rows, columns))}
      />
    );
  return (
    <>
      {props.unavailableReason && <p className="scient-menu-note">{props.unavailableReason}</p>}
      {props.layout((id) => renderAction(id), table)}
    </>
  );
}

/** The Insert button and its menu, shared by the document editors. */
export function InsertMenu(props: {
  readonly actions: readonly InsertMenuAction[];
  readonly layout: InsertMenuLayout;
  readonly disabled?: boolean | undefined;
  readonly unavailableReason?: string | undefined;
  readonly onInsertTable?: ((rows: number, columns: number) => void) | undefined;
  /** Controlled when an editor opens the menu from the keyboard. */
  readonly open?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** Where focus goes when the menu closes without a command. Default: the button. */
  readonly onReturnFocus?: (() => void) | undefined;
  /** Attributes an editor needs on the popup, for example to scope its shortcuts. */
  readonly popupAttributes?: Readonly<Record<`data-${string}`, string>> | undefined;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setOwnOpen(next);
    props.onOpenChange?.(next);
  };
  const pendingCommand = useRef<(() => void) | null>(null);
  const commandOwnsFocus = useRef(false);
  const run = (command: () => void) => {
    pendingCommand.current = command;
    commandOwnsFocus.current = true;
    setOpen(false);
  };
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (next) commandOwnsFocus.current = false;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const command = pendingCommand.current;
        pendingCommand.current = null;
        command?.();
      }}
    >
      <ScientTooltip content={WRITING_COMMAND_LABELS.insert}>
        <MenuTrigger
          disabled={props.disabled}
          render={
            <button
              type="button"
              aria-label={WRITING_COMMAND_LABELS.insert}
              className={dockButtonClass()}
            >
              <WritingCommandIcon command="insert" />
              <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          }
        />
      </ScientTooltip>
      <MenuPopup
        align="start"
        // As wide as its longest item.
        className="w-max [&_[role=menuitem]]:whitespace-nowrap"
        finalFocus={() => {
          // A command places focus itself (the editor, a dialog, a picker).
          if (commandOwnsFocus.current) return false;
          if (!props.onReturnFocus) return true;
          props.onReturnFocus();
          return false;
        }}
        data-keybinding-capture=""
        {...props.popupAttributes}
      >
        <InsertMenuContent
          actions={props.actions}
          layout={props.layout}
          onInsertTable={props.onInsertTable}
          unavailableReason={props.unavailableReason}
          onRun={run}
        />
      </MenuPopup>
    </Menu>
  );
}
