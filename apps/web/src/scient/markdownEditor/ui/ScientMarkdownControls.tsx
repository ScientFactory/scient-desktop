import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  filterScientMarkdownSlashCommands,
  SCIENT_MARKDOWN_SLASH_COMMANDS,
  type ScientMarkdownCommand,
} from "../prosemirror/commands";
import type { ScientMarkdownEditorView } from "../prosemirror/view";

function CommandButton(props: {
  readonly active?: boolean;
  readonly command: ScientMarkdownCommand;
  readonly controller: ScientMarkdownEditorView;
  readonly label: string;
  readonly text: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="scient-markdown-command-button"
            aria-label={props.label}
            aria-pressed={props.active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.controller.execute(props.command)}
          />
        }
      >
        {props.text}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function LinkEditor({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [href, setHref] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (controller.setLink(href)) {
      setHref("");
      detailsRef.current?.removeAttribute("open");
    }
  };
  return (
    <details ref={detailsRef} className="scient-markdown-link-control">
      <summary className="scient-markdown-command-button" aria-label="Add or edit link">
        ↗
      </summary>
      <form className="scient-markdown-link-popover" onSubmit={submit}>
        <label>
          <span>Link destination</span>
          <input
            type="text"
            value={href}
            inputMode="url"
            placeholder="https:// or relative path"
            onChange={(event) => setHref(event.target.value)}
          />
        </label>
        <span className="scient-markdown-link-actions">
          <button type="submit">Apply</button>
          <button type="button" onClick={() => controller.removeLink()}>
            Remove
          </button>
        </span>
      </form>
    </details>
  );
}

function InsertMenu({ controller }: { readonly controller: ScientMarkdownEditorView }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const execute = (command: ScientMarkdownCommand) => {
    controller.execute(command);
    detailsRef.current?.removeAttribute("open");
  };
  return (
    <details ref={detailsRef} className="scient-markdown-insert-control">
      <summary className="scient-markdown-command-button" aria-label="Insert block">
        +
      </summary>
      <div className="scient-markdown-insert-menu" role="menu" aria-label="Insert Markdown block">
        {SCIENT_MARKDOWN_SLASH_COMMANDS.map((item) => (
          <button
            key={item.command}
            type="button"
            role="menuitem"
            onClick={() => execute(item.command)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}

export function ScientMarkdownControls({
  controller,
}: {
  readonly controller: ScientMarkdownEditorView;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!snapshot.editable) return null;
  const active = new Set(snapshot.activeMarks);
  const slashItems =
    snapshot.slashQuery === null ? [] : filterScientMarkdownSlashCommands(snapshot.slashQuery);
  return (
    <>
      <div className="scient-markdown-editor-dock" role="toolbar" aria-label="Document actions">
        <InsertMenu controller={controller} />
        <CommandButton controller={controller} command="undo" label="Undo" text="↶" />
        <CommandButton controller={controller} command="redo" label="Redo" text="↷" />
      </div>
      {!snapshot.selectionEmpty ? (
        <div
          className="scient-markdown-selection-toolbar"
          role="toolbar"
          aria-label="Text formatting"
        >
          <CommandButton
            controller={controller}
            command="bold"
            label="Bold"
            text="B"
            active={active.has("strong")}
          />
          <CommandButton
            controller={controller}
            command="italic"
            label="Italic"
            text="I"
            active={active.has("em")}
          />
          <CommandButton
            controller={controller}
            command="strike"
            label="Strikethrough"
            text="S"
            active={active.has("strike")}
          />
          <CommandButton
            controller={controller}
            command="inline-code"
            label="Inline code"
            text="&lt;/&gt;"
            active={active.has("code")}
          />
          <LinkEditor controller={controller} />
        </div>
      ) : null}
      {snapshot.inTable ? (
        <div className="scient-markdown-table-toolbar" role="toolbar" aria-label="Table actions">
          <CommandButton
            controller={controller}
            command="add-row-after"
            label="Add row below"
            text="+ Row"
          />
          <CommandButton
            controller={controller}
            command="add-column-after"
            label="Add column after"
            text="+ Column"
          />
          <CommandButton
            controller={controller}
            command="delete-row"
            label="Delete row"
            text="− Row"
          />
          <CommandButton
            controller={controller}
            command="delete-column"
            label="Delete column"
            text="− Column"
          />
        </div>
      ) : null}
      {snapshot.slashQuery !== null && slashItems.length > 0 ? (
        <div className="scient-markdown-slash-menu" role="listbox" aria-label="Insert block">
          {slashItems.map((item, index) => (
            <button
              key={item.command}
              type="button"
              role="option"
              aria-selected={index === snapshot.slashActiveIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.executeSlashCommand(item.command)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
