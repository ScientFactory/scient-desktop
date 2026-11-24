import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import type { Mark } from "prosemirror-model";
import { history } from "prosemirror-history";
import {
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  type InputRule,
} from "prosemirror-inputrules";
import { keymap, keydownHandler } from "prosemirror-keymap";
import { getKeyboardPreferences } from "../../keyboard/preferences";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { Plugin, PluginKey, type Command } from "prosemirror-state";
import { goToNextCell, tableEditing } from "prosemirror-tables";

import { scientMarkdownDirectionPresentationPlugin } from "./directionPresentation";
import { scientMarkdownDocumentFontPlugin } from "./documentFontPresentation";
import { runScientMarkdownCommand } from "./commands";
import { scientMarkdownSchema, unstyleBoundaryWhitespace } from "./schema";
import { imageUploadPlugin } from "./imageUploads";
import { imageFigurePlugin } from "./imageFigures";
import { scientMarkdownOutlinePlugin } from "./outline";
import { scientMarkdownSearchPlugin } from "./search";
import { inlineTableArrow, inlineTableEnter } from "./tableNavigation";
import { markdownTablePlugin } from "./tables";
import {
  SCIENT_MARKDOWN_COMMAND_SHORTCUTS,
  scientMarkdownKeymapNames,
  type ScientMarkdownShortcutId,
} from "../shortcuts";
import { scientMarkdownResultsPlugin } from "./results";

export type ScientMarkdownTransactionOrigin = "user" | "external" | "system";

export const scientMarkdownTransactionOriginKey = new PluginKey<ScientMarkdownTransactionOrigin>(
  "scientMarkdownTransactionOrigin",
);

const sourceIdentityPluginKey = new PluginKey("scientMarkdownSourceIdentity");

function requiredNodeType(name: string) {
  const type = scientMarkdownSchema.nodes[name];
  if (!type) throw new Error(`Scient Markdown schema is missing '${name}'.`);
  return type;
}

function buildInputRules(): ReadonlyArray<InputRule> {
  const heading = requiredNodeType("heading");
  const blockquote = requiredNodeType("blockquote");
  const bulletList = requiredNodeType("bullet_list");
  const orderedList = requiredNodeType("ordered_list");
  return [
    textblockTypeInputRule(/^(#{1,6})\s$/u, heading, (match) => ({
      level: match[1]?.length ?? 1,
    })),
    wrappingInputRule(/^\s*>\s$/u, blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/u, bulletList),
    wrappingInputRule(/^(\d+)\.\s$/u, orderedList, (match) => ({
      order: Number(match[1] ?? "1"),
    })),
  ];
}

function buildKeyBindings(): Readonly<Record<string, Command>> {
  const listItem = requiredNodeType("list_item");
  const bindings: Record<string, Command> = {
    ArrowLeft: inlineTableArrow("left"),
    ArrowRight: inlineTableArrow("right"),
    ArrowUp: inlineTableArrow("up"),
    ArrowDown: inlineTableArrow("down"),
    "Shift-ArrowLeft": inlineTableArrow("left", true),
    "Shift-ArrowRight": inlineTableArrow("right", true),
    "Shift-ArrowUp": inlineTableArrow("up", true),
    "Shift-ArrowDown": inlineTableArrow("down", true),
    Enter: chainCommands(
      inlineTableEnter,
      splitListItem(listItem),
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlock,
    ),
    Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(listItem)),
  };

  const bind = (id: ScientMarkdownShortcutId, command: Command) => {
    for (const key of scientMarkdownKeymapNames(id)) bindings[key] = command;
  };
  for (const [id, command] of SCIENT_MARKDOWN_COMMAND_SHORTCUTS) {
    bind(id, (state, dispatch) => runScientMarkdownCommand(command, state, dispatch));
  }
  return bindings;
}

function sourceIdentityPlugin(): Plugin {
  let nextIdentity = 1;
  return new Plugin({
    key: sourceIdentityPluginKey,
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const seen = new Set<string>();
      let transaction = newState.tr;
      let changed = false;
      newState.doc.forEach((node, offset) => {
        const current = node.attrs.sourceId;
        if (typeof current === "string" && current.length > 0 && !seen.has(current)) {
          seen.add(current);
          return;
        }
        let sourceId = `local-${nextIdentity}`;
        nextIdentity += 1;
        while (seen.has(sourceId)) {
          sourceId = `local-${nextIdentity}`;
          nextIdentity += 1;
        }
        seen.add(sourceId);
        transaction = transaction.setNodeMarkup(offset, undefined, { ...node.attrs, sourceId });
        changed = true;
      });
      if (!changed) return null;
      return transaction.setMeta("addToHistory", false);
    },
  });
}

// Apply the same mark changes to the live view and its undo history as to saved Markdown.
function boundaryWhitespacePlugin(): Plugin {
  // Once typing continues, an unstyled trailing space can become internal to the mark.
  let ordinarySpace = false;
  let typing:
    | { from: number; to: number; marks: readonly Mark[]; browserSpace: boolean }
    | undefined;
  return new Plugin({
    props: {
      handleDOMEvents: {
        beforeinput(_view, event) {
          ordinarySpace = event.inputType === "insertText" && event.data === " ";
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, state) {
      const previous = typing;
      const spaceInput = ordinarySpace;
      ordinarySpace = false;
      typing = undefined;
      if (
        !transactions.some((tr) => {
          const origin = tr.getMeta(scientMarkdownTransactionOriginKey);
          return tr.docChanged && origin !== "external" && origin !== "system";
        })
      )
        return null;
      const from = oldState.doc.content.findDiffStart(state.doc.content);
      const end = oldState.doc.content.findDiffEnd(state.doc.content);
      if (from === null || !end) return null;
      const tr = state.tr;
      const caret = state.selection.empty ? state.selection.from : -1;
      if (
        previous &&
        oldState.selection.empty &&
        oldState.selection.from === previous.to &&
        from === previous.to &&
        caret > from &&
        end.a === from &&
        end.b === caret &&
        state.doc.resolve(caret).parent === state.doc.resolve(from).parent
      ) {
        if (
          previous.browserSpace &&
          tr.doc.textBetween(previous.to - 1, previous.to) === "\u00a0"
        ) {
          tr.insertText(" ", previous.to - 1, previous.to);
        }
        for (const mark of previous.marks) tr.addMark(previous.from, previous.to, mark);
      }
      tr.doc.nodesBetween(
        previous ? Math.min(previous.from, from) : from,
        Math.max(from, end.b),
        (node, pos) => {
          if (!["paragraph", "heading", "table_cell", "table_header"].includes(node.type.name))
            return true;
          const content = unstyleBoundaryWhitespace(node);
          const start = node.content.findDiffStart(content);
          const stop = node.content.findDiffEnd(content);
          if (start !== null && stop) {
            tr.replaceWith(pos + 1 + start, pos + 1 + stop.a, content.cut(start, stop.b));
          }
          return false;
        },
      );
      if (!tr.docChanged) return null;
      tr.setSelection(state.selection.getBookmark().resolve(tr.doc));
      const before = caret >= 0 ? state.doc.resolve(caret).nodeBefore : null;
      const space = before?.isText ? /\s+$/u.exec(before.text!)?.[0] : null;
      const marks = state.storedMarks ?? state.selection.$from.marks();
      if (
        space &&
        before &&
        marks.length &&
        end.b === caret &&
        from <= caret &&
        marks.some((mark) => !mark.isInSet(tr.doc.resolve(caret).marks()))
      ) {
        typing = {
          from: previous?.to === from ? previous.from : caret - space.length,
          to: caret,
          marks,
          browserSpace: spaceInput,
        };
        tr.setStoredMarks(marks);
      } else if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
      return tr;
    },
  });
}

export function buildScientMarkdownPlugins(): ReadonlyArray<Plugin> {
  return [
    sourceIdentityPlugin(),
    boundaryWhitespacePlugin(),
    scientMarkdownDirectionPresentationPlugin(),
    scientMarkdownDocumentFontPlugin(),
    imageUploadPlugin(),
    scientMarkdownSearchPlugin(),
    scientMarkdownOutlinePlugin(),
    imageFigurePlugin(),
    scientMarkdownResultsPlugin(),
    inputRules({ rules: [...buildInputRules()] }),
    (() => {
      let snapshot = getKeyboardPreferences();
      let handler = keydownHandler(buildKeyBindings());
      return new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (snapshot !== getKeyboardPreferences()) {
              snapshot = getKeyboardPreferences();
              handler = keydownHandler(buildKeyBindings());
            }
            return handler(view, event);
          },
        },
      });
    })(),
    keymap(baseKeymap),
    history(),
    markdownTablePlugin(),
    tableEditing(),
    gapCursor(),
    dropCursor(),
  ];
}
