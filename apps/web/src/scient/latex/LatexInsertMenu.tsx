import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
} from "~/components/ui/menu";
import { DocumentTableSizeMenu } from "../writing/DocumentTableSizeMenu";
import { dockButtonClass } from "../markdownEditor/ui/dockChrome";

export interface LatexInsertAction {
  id: string;
  label: string;
  description: string;
  group: string;
  run: () => void;
  disabled?: boolean;
}

/** All insertion routes share these commands and return focus to their destination. */
export function LatexInsertMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly LatexInsertAction[];
  disabled: boolean;
  mathOnly?: boolean;
  onInsertTable: (rows: number, columns: number) => void;
  onReturnFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pendingCommand = useRef<(() => void) | null>(null);
  const commandOwnsFocus = useRef(false);
  useEffect(() => {
    if (props.open) commandOwnsFocus.current = false;
  }, [props.open]);
  const choices = props.actions.filter((action) =>
    `${action.label} ${action.description} ${action.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const groups = [...new Set(choices.map((action) => action.group))];
  const run = (command: () => void) => {
    pendingCommand.current = command;
    commandOwnsFocus.current = true;
    props.onOpenChange(false);
  };
  return (
    <Menu
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          setQuery("");
          commandOwnsFocus.current = false;
        }
        props.onOpenChange(open);
      }}
      onOpenChangeComplete={(open) => {
        if (open) {
          input.current?.focus();
          return;
        }
        const command = pendingCommand.current;
        pendingCommand.current = null;
        setQuery("");
        command?.();
      }}
    >
      <ScientTooltip content="Insert">
        <MenuTrigger
          disabled={props.disabled}
          render={
            <button type="button" aria-label="Insert" className={dockButtonClass()}>
              <Plus aria-hidden="true" />
              <span className="scient-latex-insert-label scient-latex-tool-label">Insert</span>
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
        <div ref={content}>
          <div className="scient-latex-insert-search">
            <input
              ref={input}
              aria-label="Search insert actions"
              placeholder="Find an element…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") return;
                event.stopPropagation();
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const items = content.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
                  const item =
                    event.key === "ArrowUp"
                      ? items?.item((items?.length ?? 1) - 1)
                      : items?.item(0);
                  item?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  content.current?.querySelector<HTMLElement>('[role="menuitem"]')?.click();
                }
              }}
            />
          </div>
          <div className="scient-latex-insert-items">
            {!query || "table grid rows columns".includes(query.toLowerCase()) ? (
              props.mathOnly ? (
                <MenuItem disabled>Table</MenuItem>
              ) : (
                <DocumentTableSizeMenu
                  onInsert={({ rows, columns }) => run(() => props.onInsertTable(rows, columns))}
                />
              )
            ) : null}
            {groups.map((group) => (
              <MenuGroup key={group}>
                <MenuGroupLabel>{group}</MenuGroupLabel>
                {choices
                  .filter((action) => action.group === group)
                  .map((action) => (
                    <MenuItem
                      key={action.id}
                      size="compact"
                      disabled={action.disabled}
                      aria-description={action.description}
                      onClick={() => run(action.run)}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
              </MenuGroup>
            ))}
            {choices.length === 0 &&
            query &&
            (props.mathOnly || !"table grid rows columns".includes(query.toLowerCase())) ? (
              <p className="scient-latex-empty-menu">No matching elements.</p>
            ) : null}
          </div>
        </div>
      </MenuPopup>
    </Menu>
  );
}
