import { countWords } from "../writing/documentCounts";

const SILENT_ARGUMENT_COMMANDS =
  "label|ref|eqref|pageref|autoref|cref|Cref|cite[a-zA-Z]*|nocite|includegraphics|input|include|bibliography|bibliographystyle|usepackage|documentclass|url|hypersetup|newcommand|renewcommand|newtheorem|theoremstyle|setlength|vspace|hspace";
/** Environments whose body is not prose: mathematics and literal code. */
const SKIPPED_ENVIRONMENT =
  /^(?:equation|align|gather|multline|eqnarray|displaymath|math|alignat|flalign|verbatim|Verbatim|lstlisting|minted)\*?$/u;
/** Environments whose `\begin` is followed by a braced argument that is not prose. */
const ARGUMENT_ENVIRONMENTS =
  "tabular|tabularx|tabulary|longtable|array|minipage|thebibliography|multicols|wrapfigure|subfigure";

/** Commands whose first argument is an address, where `%` is not a comment. */
const ADDRESS_COMMANDS = ["\\url{", "\\href{", "\\path{", "\\nolinkurl{"];
/** Literal code and addresses stay on one line; longer than this is not one. */
const INLINE_LITERAL_LIMIT = 2000;

/**
 * One pass over the text that drops what a reader does not read as words:
 * comments, mathematics and literal code. Each closing delimiter is searched
 * for at most once after it is known to be missing, so many unmatched openers
 * cannot make the scan slow.
 */
function stripNonProse(text: string): string {
  const missing = new Set<string>();
  const closerAfter = (closer: string, from: number): number => {
    if (missing.has(closer)) return -1;
    const at = text.indexOf(closer, from);
    if (at === -1) missing.add(closer);
    return at;
  };
  // The end of an inline literal that opens at `from` and closes with `closer`
  // on the same line, or -1. The search is bounded, so many unclosed ones stay cheap.
  const inlineEnd = (closer: string, from: number): number => {
    const limit = Math.min(text.length, from + INLINE_LITERAL_LIMIT);
    for (let at = from; at < limit; at += 1) {
      const character = text[at];
      if (character === "\n") return -1;
      if (character === closer) return at;
    }
    return -1;
  };
  let out = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\") {
      const next = text[index + 1];
      if (next === "[" || next === "(") {
        const at = closerAfter(next === "[" ? "\\]" : "\\)", index + 2);
        if (at !== -1) {
          out += " ";
          index = at + 2;
          continue;
        }
      }
      if (text.startsWith("\\verb", index) && !/[a-zA-Z]/u.test(text[index + 5] ?? "a")) {
        const delimiterAt = text[index + 5] === "*" ? index + 6 : index + 5;
        const delimiter = text[delimiterAt];
        const at =
          delimiter === undefined || delimiter === "\n"
            ? -1
            : inlineEnd(delimiter, delimiterAt + 1);
        if (at !== -1) {
          // Literal code reads as one item.
          out += " x ";
          index = at + 1;
          continue;
        }
      }
      const address = ADDRESS_COMMANDS.find((command) => text.startsWith(command, index));
      if (address) {
        const at = inlineEnd("}", index + address.length);
        if (at !== -1) {
          // An address is not prose; a link's visible text follows and is kept.
          out += " ";
          index = at + 1;
          continue;
        }
      }
      if (text.startsWith("\\begin{", index)) {
        const nameEnd = text.indexOf("}", index + 7);
        const name = nameEnd === -1 ? "" : text.slice(index + 7, nameEnd);
        if (SKIPPED_ENVIRONMENT.test(name)) {
          const closer = `\\end{${name}}`;
          const at = closerAfter(closer, nameEnd + 1);
          if (at !== -1) {
            out += " ";
            index = at + closer.length;
            continue;
          }
        }
      }
      // An escaped character, such as \% or \$, is kept for the later steps.
      out += character + (next ?? "");
      index += 2;
      continue;
    }
    if (character === "%") {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? text.length : lineEnd;
      continue;
    }
    if (character === "$") {
      const display = text[index + 1] === "$";
      const closer = display ? "$$" : "$";
      if (!missing.has(closer)) {
        let at = index + closer.length;
        while (at < text.length) {
          if (text[at] === "\\") at += 2;
          else if (text[at] === "$" && (!display || text[at + 1] === "$")) break;
          else at += 1;
        }
        if (at < text.length) {
          out += " ";
          index = at + closer.length;
          continue;
        }
        missing.add(closer);
      }
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * An approximate count of the words a reader would see in a LaTeX file: the
 * preamble, comments, mathematics, literal code, commands and reference keys
 * are left out; headings, captions, table cells and theorem text are counted.
 * It is a writing aid for the footer, not a submission-grade count.
 */
export function countLatexWords(source: string): number {
  const opening = "\\begin{document}";
  const begin = source.indexOf(opening);
  const end = source.lastIndexOf("\\end{document}");
  const body =
    begin === -1 ? source : source.slice(begin + opening.length, end > begin ? end : undefined);
  const text = stripNonProse(body)
    // Keys and file names are not words.
    .replace(
      new RegExp(
        `\\\\(?:${SILENT_ARGUMENT_COMMANDS})\\*?(?:\\[[^\\]\\[]*\\])*(?:\\{[^{}]*\\})*`,
        "gu",
      ),
      " ",
    )
    // A link keeps its visible text only.
    .replace(/\\href\{[^{}]*\}/gu, " ")
    .replace(
      new RegExp(
        `\\\\begin\\{(?:${ARGUMENT_ENVIRONMENTS})\\*?\\}(?:\\[[^\\]\\[]*\\])?\\{[^{}]*\\}`,
        "gu",
      ),
      " ",
    )
    .replace(/\\(?:begin|end)\{[^{}]*\}(?:\[[^\]\[]*\])?/gu, " ")
    // An accent belongs to its letter: caf\'e is one word.
    .replace(/\\['"`^~=.]\s*\{?\\?([a-zA-Z])\}?/gu, "$1")
    .replace(/\\[cHbdruvtk](?![a-zA-Z])\s*\{?([a-zA-Z])\}?/gu, "$1")
    // Column separators, ties and line breaks separate words.
    .replace(/\\\\/gu, " ")
    .replace(/(^|[^\\])[&~]/gu, "$1 ")
    // An escaped special character is the character itself.
    .replace(/\\([%&$#_])/gu, "$1")
    .replace(/\\[{}]/gu, "")
    // Any other command: drop its name and optional arguments, keep its text.
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]\[]*\])*/gu, " ")
    .replace(/\\./gu, " ")
    // Grouping braces do not split a word: co{oper}ate is one word.
    .replace(/[{}]/gu, "");
  // What is left may still hold bare punctuation; a word has a letter or digit.
  return countWords(text.replace(/(^|\s)[^\p{L}\p{N}\s]+(?=\s|$)/gu, "$1"));
}
