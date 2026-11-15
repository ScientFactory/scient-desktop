// Seeded editing gestures over many paragraph kinds: an edit is refused only for the known family
// left refused on purpose (a delimiter touching a size or font tag inside a word). Strike, inline
// code and formulas are not exercised.
import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";
import { runScientMarkdownCommand, type ScientMarkdownCommand } from "./commands";
import { ScientProseMirrorSession } from "./session";

const DOCUMENTS: Readonly<Record<string, string>> = {
  plain: "aa bb cc dd ee\n",
  twoParagraphs: "aa bb cc\n\ndd ee ff\n",
  lineBreak: "aa bb  \ncc dd ee\n",
  boldItalic: "**aa bb** cc *dd ee* ff\n",
  underscores: "__aa bb__ cc _dd ee_ ff\n",
  link: "aa [bb cc](https://x.example) dd ee\n",
  heading: "# aa bb cc dd ee\n",
  bulletList: "- aa bb cc dd ee\n",
  orderedList: "1. aa bb cc dd\n",
  quote: "> aa bb cc dd ee\n",
  table: "| aa bb cc | dd |\n| --- | --- |\n| ee | ff |\n",
  footnote: "aa bb[^1] cc dd\n\n[^1]: note\n",
  hebrew: "שלום עולם טוב מאוד\n",
  punctuation: "aa, bb. cc! (dd) ee?\n",
  sizeSpan: 'aa <span style="font-size:14pt">bb cc</span> dd ee\n',
  familySpan: "aa <span style=\"font-family:'Arial'\">bb cc</span> dd ee\n",
};

const COMMANDS: readonly ScientMarkdownCommand[] = [
  "font-size-14",
  "font-size-20",
  "font-size-default",
  "font-family-Arial",
  "font-family-Georgia",
  "font-family-default",
  "bold",
  "italic",
];

const SEQUENCES_PER_DOCUMENT = 120;
const MAX_KNOWN_REFUSALS_PER_DOCUMENT = 5;

/** A delimiter touching a span tag inside a word (or three delimiters in a row after one). */
const KNOWN_REFUSAL = /[\p{L}\p{N}](?:\*{1,3}|~~)<span|<\/span>(?:\*{1,3}|~~)[\p{L}\p{N}]/u;

function firstTextblock(session: ScientProseMirrorSession) {
  let found: { start: number; size: number } | null = null;
  session.state.doc.descendants((node, position) => {
    if (found === null && node.isTextblock)
      found = { start: position + 1, size: node.content.size };
    return found === null;
  });
  if (found === null) throw new Error("The test document has no text block.");
  return found as { start: number; size: number };
}

describe("round trip of editing gestures", () => {
  it.each(Object.entries(DOCUMENTS))(
    "refuses nothing but the known family in: %s",
    (name, source) => {
      // A fixed seed per document keeps the sequences identical on every run.
      let seed = 1000 + name.length * 7919;
      const random = (limit: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % limit;
      };
      const refused: string[] = [];
      for (let sequence = 0; sequence < SEQUENCES_PER_DOCUMENT; sequence += 1) {
        const session = new ScientProseMirrorSession({ source, revision: "r0" });
        for (let step = 0; step < 1 + random(5); step += 1) {
          const { start, size } = firstTextblock(session);
          const text = session.state.doc.textBetween(start, start + size, undefined, "￼");
          const words = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map(
            (m) => [m.index, m.index + m[0].length] as const,
          );
          const word = words[random(words.length)] ?? ([0, size] as const);
          const gesture = random(100);
          const select = (from: number, to: number) =>
            session.applyTransaction(
              session.state.tr.setSelection(
                TextSelection.create(session.state.doc, start + from, start + to),
              ),
              "user",
            );
          const apply = () => {
            const command = COMMANDS[random(COMMANDS.length)]!;
            runScientMarkdownCommand(command, session.state, (tr) =>
              session.applyTransaction(tr, "user"),
            );
          };
          if (gesture < 30) {
            select(word[0], word[1]);
            apply();
          } else if (gesture < 55) {
            const next =
              words[Math.min(words.length - 1, words.indexOf(word) + 1 + random(2))] ?? word;
            select(word[0], Math.max(word[1], next[1]));
            apply();
          } else if (gesture < 65) {
            const a = random(size + 1);
            const b = random(size + 1);
            select(Math.min(a, b), Math.max(a, b));
            apply();
          } else if (gesture < 75) {
            const caret = word[0] + random(word[1] - word[0] + 1);
            select(caret, caret);
            apply();
          } else if (gesture < 90) {
            session.applyTransaction(
              session.state.tr.insertText(random(2) === 0 ? " " : "xé", start + random(size + 1)),
              "user",
            );
          } else if (size > 4) {
            const from = random(size);
            session.applyTransaction(
              session.state.tr.delete(start + from, start + Math.min(size, from + 1 + random(3))),
              "user",
            );
          }
          if (session.pendingWriteback) {
            refused.push(JSON.stringify(session.pendingWriteback.proposedSource));
            break;
          }
        }
      }
      expect(refused.filter((source) => !KNOWN_REFUSAL.test(source))).toEqual([]);
      expect(refused.length).toBeLessThanOrEqual(MAX_KNOWN_REFUSALS_PER_DOCUMENT);
    },
  );
});
