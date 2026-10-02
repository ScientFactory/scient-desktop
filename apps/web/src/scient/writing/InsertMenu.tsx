import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import type { ShortcutPresentation } from "../keyboard/presentation";
import { DocumentTableSizeMenu } from "./DocumentTableSizeMenu";
import { WritingCommandIcon } from "./commandIcons";
import { WRITING_COMMAND_LABELS } from "./commandNames";
import { dockButtonClass, DockCommandItem, MenuRow } from "./dockChrome";
import "./insertMenu.css";

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
 * The inside of the Insert menu, shared by the document editors: a search
 * field over every action, and the editor's own arrangement when the field is
 * empty. The bar's menu and the More menu use the same content.
 */
export function InsertMenuContent(props: {
  readonly actions: readonly InsertMenuAction[];
  readonly layout: InsertMenuLayout;
  readonly onInsertTable?: ((rows: number, columns: number) => void) | undefined;
  /** When set, nothing can be inserted and this says why. */
  readonly unavailableReason?: string | undefined;
  /** Lets the menu close before the command runs. */
  readonly onRun?: ((command: () => void) => void) | undefined;
  /** False where the content is one section of a larger menu. Default: true. */
  readonly searchTakesFocus?: boolean | undefined;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const searchTakesFocus = props.searchTakesFocus ?? true;
  useEffect(() => {
    if (searchTakesFocus) input.current?.focus();
  }, [searchTakesFocus]);
  const run = (command: () => void) => (props.onRun ? props.onRun(command) : command());
  const actionById = new Map(props.actions.map((action) => [action.id, action]));
  // In the flat list of search results, rows without an icon keep its column,
  // so every name starts at the same place.
  const anyIcon = props.actions.some((action) => action.icon);
  const renderAction = (id: string, keepIconColumn = false) => {
    const action = actionById.get(id);
    if (!action) return null;
    const icon =
      action.icon ??
      (keepIconColumn && anyIcon ? (
        <span className="-mx-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : null);
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
        <MenuRow icon={icon} label={action.label} shortcut={action.shortcut} />
      </DockCommandItem>
    );
  };
  const needle = query.trim().toLowerCase();
  const filtered = props.actions.filter((action) =>
    `${action.label} ${action.description ?? ""} ${action.group ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
  const onInsertTable = props.onInsertTable;
  const tableMatches = onInsertTable !== undefined && "table grid rows columns".includes(needle);
  const table =
    onInsertTable === undefined ? null : props.unavailableReason ? (
      <DockCommandItem disabled title={props.unavailableReason}>
        Table
      </DockCommandItem>
    ) : (
      <DocumentTableSizeMenu
        onInsert={({ rows, columns }) => run(() => onInsertTable(rows, columns))}
      />
    );
  return (
    <div ref={content}>
      <div className="scient-insert-search">
        <input
          ref={input}
          aria-label="Search insert options"
          placeholder="Search insert options…"
          // As one section of a larger menu it is a pointer convenience: the
          // menu opens on its first item and the keyboard walks the items.
          tabIndex={searchTakesFocus ? undefined : -1}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") return;
            event.stopPropagation();
            // Enter that confirms composed text (IME) is not a command.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const items = content.current?.querySelectorAll<HTMLElement>(
              '[role="menuitem"]:not([aria-disabled="true"]):not([data-disabled])',
            );
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              items?.item(event.key === "ArrowUp" ? items.length - 1 : 0)?.focus();
            } else if (event.key === "Enter") {
              event.preventDefault();
              items?.item(0)?.click();
            }
          }}
        />
      </div>
      {props.unavailableReason && <p className="scient-insert-empty">{props.unavailableReason}</p>}
      <div className="scient-insert-items">
        {needle ? (
          <>
            {tableMatches && table}
            {filtered.map((action) => renderAction(action.id, true))}
            {!filtered.length && !tableMatches && (
              <p className="scient-insert-empty">No matching elements.</p>
            )}
          </>
        ) : (
          props.layout((id) => renderAction(id), table)
        )}
      </div>
    </div>
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
        className="w-72"
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
