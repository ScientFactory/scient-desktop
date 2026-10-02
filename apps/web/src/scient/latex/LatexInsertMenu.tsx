import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "~/components/ui/menu";
import { DocumentTableSizeMenu } from "../writing/DocumentTableSizeMenu";
import { WritingCommandIcon } from "../writing/commandIcons";
import { WRITING_COMMAND_LABELS } from "../writing/commandNames";
import { dockButtonClass, DockCommandItem } from "../writing/dockChrome";

export interface LatexInsertAction {
  id: string;
  label: string;
  description: string;
  group: string;
  run: () => void;
  disabled?: boolean;
  disabledReason?: string | undefined;
}

const STATEMENTS = [
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "claim",
  "definition",
  "example",
  "remark",
  "proof",
];
const MORE = ["code", "pagebreak", "abstract", "contents", "bibliography"];
const PRIMARY = ["figure", "citation", "reference", "footnote", "link"];

/** The regular and overflow menus share the same categories and command availability. */
export function LatexInsertMenuContent(props: {
  actions: readonly LatexInsertAction[];
  onInsertTable: (rows: number, columns: number) => void;
  unavailableReason?: string | undefined;
  onRun?: (command: () => void) => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const run = (command: () => void) => (props.onRun ? props.onRun(command) : command());
  const actionById = new Map(props.actions.map((action) => [action.id, action]));
  const renderAction = (id: string) => {
    const action = actionById.get(id);
    if (!action) return null;
    const reason = props.unavailableReason ?? action.disabledReason;
    return (
      <DockCommandItem
        key={id}
        size="compact"
        disabled={Boolean(reason) || action.disabled}
        aria-description={reason ?? action.description}
        title={reason}
        onClick={() => run(action.run)}
      >
        {action.label}
      </DockCommandItem>
    );
  };
  const extra = props.actions.filter(
    (action) => ![...PRIMARY, ...STATEMENTS, ...MORE].includes(action.id),
  );
  const filtered = props.actions.filter((action) =>
    `${action.label} ${action.description} ${action.group}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const tableMatches = "table grid rows columns".includes(query.trim().toLowerCase());
  const table = props.unavailableReason ? (
    <DockCommandItem disabled title={props.unavailableReason}>
      Table
    </DockCommandItem>
  ) : (
    <DocumentTableSizeMenu
      onInsert={({ rows, columns }) => run(() => props.onInsertTable(rows, columns))}
    />
  );
  return (
    <div ref={content}>
      <div className="scient-latex-insert-search">
        <input
          ref={input}
          aria-label="Search insert options"
          placeholder="Search insert options…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") return;
            event.stopPropagation();
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
      {props.unavailableReason && (
        <p className="scient-latex-empty-menu">{props.unavailableReason}</p>
      )}
      <div className="scient-latex-insert-items">
        {query.trim() ? (
          <>
            {tableMatches && table}
            {filtered.map((action) => renderAction(action.id))}
            {!filtered.length && !tableMatches && (
              <p className="scient-latex-empty-menu">No matching elements.</p>
            )}
          </>
        ) : (
          <>
            {renderAction("figure")}
            {table}
            <MenuSeparator />
            {["citation", "reference", "footnote", "link"].map(renderAction)}
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>Theorems &amp; proofs</MenuSubTrigger>
              <MenuSubPopup data-latex-insert-menu="" data-dock-command-scope="latex">
                {STATEMENTS.slice(0, 5).map(renderAction)}
                <MenuSeparator />
                {STATEMENTS.slice(5, 8).map(renderAction)}
                <MenuSeparator />
                {renderAction("proof")}
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>More</MenuSubTrigger>
              <MenuSubPopup data-latex-insert-menu="" data-dock-command-scope="latex">
                {MORE.map(renderAction)}
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger>Other blocks</MenuSubTrigger>
                  <MenuSubPopup data-latex-insert-menu="" data-dock-command-scope="latex">
                    {extra.map((action) => renderAction(action.id))}
                  </MenuSubPopup>
                </MenuSub>
              </MenuSubPopup>
            </MenuSub>
          </>
        )}
      </div>
    </div>
  );
}

export function LatexInsertMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly LatexInsertAction[];
  disabled: boolean;
  unavailableReason?: string | undefined;
  onInsertTable: (rows: number, columns: number) => void;
  onReturnFocus: () => void;
}) {
  const pendingCommand = useRef<(() => void) | null>(null);
  const commandOwnsFocus = useRef(false);
  const run = (command: () => void) => {
    pendingCommand.current = command;
    commandOwnsFocus.current = true;
    props.onOpenChange(false);
  };
  return (
    <Menu
      open={props.open}
      onOpenChange={(open) => {
        if (open) commandOwnsFocus.current = false;
        props.onOpenChange(open);
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
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
          if (!commandOwnsFocus.current) props.onReturnFocus();
          return false;
        }}
        data-keybinding-capture=""
        data-latex-insert-menu=""
      >
        <LatexInsertMenuContent
          actions={props.actions}
          onInsertTable={props.onInsertTable}
          unavailableReason={props.unavailableReason}
          onRun={run}
        />
      </MenuPopup>
    </Menu>
  );
}
