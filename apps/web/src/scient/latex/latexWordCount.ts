import { countWords } from "../writing/documentCounts";

const SILENT_ARGUMENT_COMMANDS =
  "label|ref|eqref|pageref|autoref|cref|Cref|cite[a-zA-Z]*|nocite|includegraphics|input|include|bibliography|bibliographystyle|usepackage|documentclass|url|hypersetup|newcommand|renewcommand|newtheorem|theoremstyle|setlength|vspace|hspace";
const MATH_ENVIRONMENTS =
  "equation|align|gather|multline|eqnarray|displaymath|math|alignat|flalign";

/**
 * An approximate count of the words a reader would see in a LaTeX file: the
 * preamble, comments, mathematics, commands and reference keys are left out;
 * headings, captions, table cells and theorem text are counted. It is a
 * writing aid for the footer, not a submission-grade count.
 */
export function countLatexWords(source: string): number {
  const begin = source.indexOf("\\begin{document}");
  const end = source.lastIndexOf("\\end{document}");
  let text = begin === -1 ? source : source.slice(begin, end === -1 ? undefined : end);
  text = text
    // Comments: an unescaped % to the end of the line.
    .replace(/(^|[^\\])%.*$/gmu, "$1")
    // Mathematics is not prose.
    .replace(
      new RegExp(`\\\\begin\\{(${MATH_ENVIRONMENTS})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, "gu"),
      " ",
    )
    .replace(/\\\[[\s\S]*?\\\]/gu, " ")
    .replace(/\\\([\s\S]*?\\\)/gu, " ")
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/(^|[^\\])\$[^$]*\$/gu, "$1 ")
    // Keys and file names are not words.
    .replace(
      new RegExp(
        `\\\\(?:${SILENT_ARGUMENT_COMMANDS})\\*?(?:\\[[^\\]]*\\])*(?:\\{[^{}]*\\})*`,
        "gu",
      ),
      " ",
    )
    // A link keeps its visible text only.
    .replace(/\\href\{[^{}]*\}/gu, " ")
    .replace(/\\(?:begin|end)\{[^{}]*\}(?:\[[^\]]*\])?(?:\{[^{}]*\})?/gu, " ")
    // Any other command: drop its name and optional arguments, keep its text.
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])*/gu, " ")
    .replace(/\\./gu, " ")
    .replace(/[{}&~^_]/gu, " ");
  // What is left may still hold bare punctuation; a word has a letter or digit.
  return countWords(text.replace(/(^|\s)[^\p{L}\p{N}\s]+(?=\s|$)/gu, "$1"));
}
