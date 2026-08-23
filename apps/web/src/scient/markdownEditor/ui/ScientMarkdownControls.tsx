import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  filterScientMarkdownSlashCommands,
  SCIENT_MARKDOWN_SLASH_COMMANDS,
  type ScientMarkdownCommand,
} from "../prosemirror/commands";
import type { ScientMarkdownBlockAction } from "../prosemirror/blocks";
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

function BlockCommandButton(props: {
  readonly action: ScientMarkdownBlockAction;
  readonly controller: ScientMarkdownEditorView;
  readonly disabled: boolean;
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
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.controller.executeBlock(props.action)}
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

function OutlineControl({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ReturnType<ScientMarkdownEditorView["getSnapshot"]>;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={detailsRef} className="scient-markdown-outline-control">
      <summary className="scient-markdown-command-button" aria-label="Document outline">
        ☷
      </summary>
      <nav className="scient-markdown-outline-popover" aria-label="Document outline">
        <strong>Outline</strong>
        {snapshot.outlineItems.length === 0 ? (
          <p>No headings yet</p>
        ) : (
          <ol>
            {snapshot.outlineItems.map((item, index) => (
              <li key={`${item.position}-${item.level}-${item.text}`}>
                <button
                  type="button"
                  className={`is-level-${Math.min(6, Math.max(1, item.level))}`}
                  aria-current={index === snapshot.outlineActiveIndex ? "location" : undefined}
                  aria-label={`Heading level ${item.level}: ${item.text || "Untitled heading"}`}
                  onClick={() => {
                    controller.navigateToOutline(item.position);
                    detailsRef.current?.removeAttribute("open");
                  }}
                >
                  {item.text || "Untitled heading"}
                </button>
              </li>
            ))}
          </ol>
        )}
      </nav>
    </details>
  );
}

function FindControl({
  controller,
  snapshot,
}: {
  readonly controller: ScientMarkdownEditorView;
  readonly snapshot: ReturnType<ScientMarkdownEditorView["getSnapshot"]>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [replacement, setReplacement] = useState("");
  useEffect(() => {
    if (snapshot.findOpen) inputRef.current?.focus();
  }, [snapshot.findFocusRequest, snapshot.findOpen]);
  const configure = (input: {
    readonly query?: string;
    readonly caseSensitive?: boolean;
    readonly wholeWord?: boolean;
  }) => {
    controller.configureFind({
      query: input.query ?? snapshot.findQuery,
      caseSensitive: input.caseSensitive ?? snapshot.findCaseSensitive,
      wholeWord: input.wholeWord ?? snapshot.findWholeWord,
    });
  };
  return (
    <details
      className="scient-markdown-find-control"
      open={snapshot.findOpen}
      onToggle={(event) => controller.setFindOpen(event.currentTarget.open)}
    >
      <summary className="scient-markdown-command-button" aria-label="Find in document">
        ⌕
      </summary>
      <div className="scient-markdown-find-popover" role="search" aria-label="Find and replace">
        <div className="scient-markdown-find-row">
          <input
            ref={inputRef}
            type="search"
            aria-label="Find text"
            placeholder="Find"
            value={snapshot.findQuery}
            onChange={(event) => configure({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.navigateFind(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                controller.setFindOpen(false);
                controller.view?.focus();
              }
            }}
          />
          <span aria-live="polite" className="scient-markdown-find-count">
            {snapshot.findMatchCount === 0
              ? "0"
              : `${snapshot.findActiveIndex + 1}/${snapshot.findMatchCount}`}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={snapshot.findMatchCount === 0}
            onClick={() => controller.navigateFind(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={snapshot.findMatchCount === 0}
            onClick={() => controller.navigateFind(1)}
          >
            ↓
          </button>
        </div>
        <div className="scient-markdown-find-row">
          <button
            type="button"
            className={snapshot.findCaseSensitive ? "is-active" : undefined}
            aria-label="Match case"
            aria-pressed={snapshot.findCaseSensitive}
            onClick={() => configure({ caseSensitive: !snapshot.findCaseSensitive })}
          >
            Aa
          </button>
          <button
            type="button"
            className={snapshot.findWholeWord ? "is-active" : undefined}
            aria-label="Match whole word"
            aria-pressed={snapshot.findWholeWord}
            onClick={() => configure({ wholeWord: !snapshot.findWholeWord })}
          >
            W
          </button>
          {snapshot.editable ? (
            <input
              type="text"
              aria-label="Replacement text"
              placeholder="Replace"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  controller.replaceFind(replacement, false);
                }
              }}
            />
          ) : null}
        </div>
        {snapshot.editable ? (
          <div className="scient-markdown-find-actions">
            <button
              type="button"
              disabled={snapshot.findMatchCount === 0}
              onClick={() => controller.replaceFind(replacement, false)}
            >
              Replace
            </button>
            <button
              type="button"
              disabled={snapshot.findMatchCount === 0}
              onClick={() => controller.replaceFind(replacement, true)}
            >
              Replace all
            </button>
          </div>
        ) : null}
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
  const active = new Set(snapshot.activeMarks);
  const slashItems =
    snapshot.slashQuery === null ? [] : filterScientMarkdownSlashCommands(snapshot.slashQuery);
  return (
    <>
      <div className="scient-markdown-editor-dock" role="toolbar" aria-label="Document actions">
        {snapshot.editable ? <InsertMenu controller={controller} /> : null}
        {snapshot.editable ? (
          <CommandButton controller={controller} command="undo" label="Undo" text="↶" />
        ) : null}
        {snapshot.editable ? (
          <CommandButton controller={controller} command="redo" label="Redo" text="↷" />
        ) : null}
        <OutlineControl controller={controller} snapshot={snapshot} />
        <FindControl controller={controller} snapshot={snapshot} />
        {snapshot.editable ? <span className="scient-markdown-command-divider" /> : null}
        {snapshot.editable ? (
          <BlockCommandButton
            controller={controller}
            action="move-up"
            label="Move block up (Option+Up)"
            text="↑"
            disabled={!snapshot.canMoveBlockUp}
          />
        ) : null}
        {snapshot.editable ? (
          <BlockCommandButton
            controller={controller}
            action="move-down"
            label="Move block down (Option+Down)"
            text="↓"
            disabled={!snapshot.canMoveBlockDown}
          />
        ) : null}
        {snapshot.editable ? (
          <BlockCommandButton
            controller={controller}
            action="duplicate"
            label="Duplicate block (Shift+Option+Down)"
            text="⧉"
            disabled={!snapshot.canDuplicateBlock}
          />
        ) : null}
        {snapshot.editable ? (
          <BlockCommandButton
            controller={controller}
            action="delete"
            label="Delete block"
            text="×"
            disabled={!snapshot.canDeleteBlock}
          />
        ) : null}
      </div>
      {snapshot.editable && !snapshot.selectionEmpty ? (
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
      {snapshot.editable && snapshot.inTable ? (
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
      {snapshot.editable && snapshot.slashQuery !== null && slashItems.length > 0 ? (
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
