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
import { history } from "prosemirror-history";
import {
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  type InputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { Plugin, PluginKey, type Command } from "prosemirror-state";
import { goToNextCell, tableEditing } from "prosemirror-tables";

import { scientMarkdownDirectionPresentationPlugin } from "./directionPresentation";
import { runScientMarkdownCommand } from "./commands";
import { scientMarkdownSchema } from "./schema";
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

export function buildScientMarkdownPlugins(): ReadonlyArray<Plugin> {
  return [
    sourceIdentityPlugin(),
    scientMarkdownDirectionPresentationPlugin(),
    imageUploadPlugin(),
    scientMarkdownSearchPlugin(),
    scientMarkdownOutlinePlugin(),
    imageFigurePlugin(),
    inputRules({ rules: [...buildInputRules()] }),
    keymap(buildKeyBindings()),
    keymap(baseKeymap),
    history(),
    markdownTablePlugin(),
    tableEditing(),
    gapCursor(),
    dropCursor(),
  ];
}
