import { MarkdownParser } from "prosemirror-markdown";
import type { Node as ProseMirrorNode, NodeType } from "prosemirror-model";

interface ParseState {
  addNode(type: NodeType, attrs: unknown, content: unknown): ProseMirrorNode | null;
}

type TokenHandler = (state: ParseState, ...rest: ReadonlyArray<unknown>) => void;

/**
 * Returns a parse function that refuses instead of losing content.
 *
 * prosemirror-markdown builds each node with `createAndFill`. When a node's
 * content does not fit the schema (math inside a heading whose content allows
 * only text), the library drops that node and everything in it, and returns a
 * document that looks valid. The returned function reports such a parse as
 * `null`, so callers can keep the source as an editable island instead of
 * showing an empty or partial block.
 */
export function makeFaithfulMarkdownParse(
  parser: MarkdownParser,
): (source: string, environment: object) => ProseMirrorNode | null {
  // A private copy, so the shared parser's handlers stay untouched.
  const detecting = new MarkdownParser(parser.schema, parser.tokenizer, parser.tokens);
  const handlers = (detecting as unknown as { tokenHandlers?: Record<string, TokenHandler> })
    .tokenHandlers;
  if (!handlers) {
    throw new Error(
      "prosemirror-markdown no longer exposes token handlers; drops are undetectable.",
    );
  }

  let dropped = false;
  const watched = new WeakSet<ParseState>();
  const watch = (state: ParseState) => {
    if (watched.has(state)) return;
    watched.add(state);
    const addNode = state.addNode;
    state.addNode = (type, attrs, content) => {
      const node = addNode.call(state, type, attrs, content);
      if (!node) dropped = true;
      return node;
    };
  };
  for (const [type, handler] of Object.entries(handlers)) {
    handlers[type] = (state, ...rest) => {
      watch(state);
      handler(state, ...rest);
    };
  }

  return (source, environment) => {
    // A parse may run inside another (from a token's attribute callback);
    // each keeps its own answer.
    const outer = dropped;
    dropped = false;
    try {
      const document = detecting.parse(source, environment);
      return dropped ? null : document;
    } finally {
      dropped = outer;
    }
  };
}
