import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  exitCode,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
  toggleMark,
} from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import {
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  type InputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { Plugin, PluginKey, type Command } from "prosemirror-state";
import { columnResizing, goToNextCell, tableEditing } from "prosemirror-tables";

import { scientMarkdownSchema } from "./schema";
import { imageUploadPlugin } from "./imageUploads";
import { scientMarkdownOutlinePlugin } from "./outline";
import { scientMarkdownSearchPlugin } from "./search";

const sourceIdentityPluginKey = new PluginKey("scientMarkdownSourceIdentity");

function requiredNodeType(name: string) {
  const type = scientMarkdownSchema.nodes[name];
  if (!type) throw new Error(`Scient Markdown schema is missing '${name}'.`);
  return type;
}

function requiredMarkType(name: string) {
  const type = scientMarkdownSchema.marks[name];
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
  const hardBreak = requiredNodeType("hard_break");
  // Shift-Enter moves down one line (a Markdown hard break, `\` in the
  // file); plain Enter moves down one paragraph (a blank line in the file).
  const insertHardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
    return true;
  });
  return {
    "Shift-Enter": insertHardBreak,
    "Mod-Enter": insertHardBreak,
    "Mod-b": toggleMark(requiredMarkType("strong")),
    "Mod-i": toggleMark(requiredMarkType("em")),
    "Mod-y": redo,
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    Enter: chainCommands(
      splitListItem(listItem),
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlock,
    ),
    Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(listItem)),
  };
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

export function buildScientMarkdownPlugins(): ReadonlyArray<Plugin> {
  return [
    sourceIdentityPlugin(),
    imageUploadPlugin(),
    scientMarkdownSearchPlugin(),
    scientMarkdownOutlinePlugin(),
    inputRules({ rules: [...buildInputRules()] }),
    keymap(buildKeyBindings()),
    keymap(baseKeymap),
    history(),
    columnResizing(),
    tableEditing(),
    gapCursor(),
    dropCursor(),
  ];
}

export const scientMarkdownCommands = {
  liftListItem: liftListItem(requiredNodeType("list_item")),
  sinkListItem: sinkListItem(requiredNodeType("list_item")),
  splitListItem: splitListItem(requiredNodeType("list_item")),
  wrapBulletList: wrapInList(requiredNodeType("bullet_list")),
  wrapOrderedList: wrapInList(requiredNodeType("ordered_list")),
} as const;
