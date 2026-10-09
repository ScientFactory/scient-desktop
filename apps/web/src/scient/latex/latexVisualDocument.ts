import type { JSONContent } from "@tiptap/core";
import { latexDirectionMark } from "./latexLanguage";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { setLatexEnvironmentOption } from "./latexObjectProperties";
import { latexTableColumns } from "./latexTableAuthoring";
import { isLatexTikz, latexTikzEnd } from "./latexTikz";
import { parseLatexAlgorithm, algorithmLineSource } from "./latexAlgorithm";
import {
  expandLatexDocumentLoop,
  documentLoopSourceRange,
  type DocumentLoopExpansion,
} from "./latexDocumentLoops";
import {
  latexDocumentColors,
  latexColorCss,
  latexInlineColor,
  latexColorMarkSource,
  latexColorBoxOpening,
  latexColorBoxSplit,
  expandColorBoxLoop,
} from "./latexColorBoxes";
import { latexBasicBoxOpening } from "./latexBasicBoxes";
import {
  latexCounterLabel,
  latexDocumentCommand,
  latexTitleDeclarations,
} from "./latexDocumentStructure";
import { latexDocumentMathSetup } from "./latexDocumentMacros";
import { latexEnvironmentDeclarations } from "./latexEnvironmentDeclarations";
import { latexListOptionsSource, parseLatexListOptions } from "./latexListOptions";
import {
  latexPageLayoutOpening,
  latexLayoutSpacing,
  latexMinipageSeparator,
} from "./latexPageLayouts";
import {
  expandLongTableRows,
  longTableSections,
  longTableVisibleBody,
  physicalLongTablePatches,
} from "./latexLongTable";
import {
  activeLatexSource,
  inlineLatexLiteral,
  inlineLatexLiteralSource,
  latexLiteralBlock,
  latexListingPresentation,
} from "./latexLiteral";
import {
  LATEX_INLINE_MARKS,
  LATEX_TEXT_DECLARATIONS,
  latexTextMarkSource,
  withLatexTextMark,
} from "./latexTextFormatting";
import {
  patchNumberedMathSource,
  projectMathNumbering,
  singleMathReferenceLabel,
  withMathReferenceLabel,
  withMathNumbering,
} from "./latexMathNumbering";
import { MATH_SYMBOLS, newMathSymbolPackages } from "./mathSymbols";
import {
  ensureLatexPackages,
  ensureLatexMenuColors,
  latexPackageInventory,
  newLatexCommandPackages,
  latexCommands,
  latexWithoutComments,
} from "./latexPackages";
import {
  latexLengthInches,
  latexVisualLayoutProfile,
  LATEX_PAPER_SIZES,
  type LatexVisualLayoutProfile,
} from "./latexVisualLayout";

export { latexVisualLayoutProfile, type LatexVisualLayoutProfile } from "./latexVisualLayout";

export interface LatexVisualSourceBlock {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly node: JSONContent;
  readonly source: string;
  readonly editable: boolean;
}

export interface LatexVisualDocument {
  readonly source: string;
  readonly content: JSONContent;
  readonly blocks: readonly LatexVisualSourceBlock[];
  readonly supportedBlocks: number;
  readonly rawBlocks: number;
  readonly setup?: LatexVisualSetup;
  readonly generated?: {
    readonly expansion: DocumentLoopExpansion;
    readonly virtual: LatexVisualDocument;
  };
  readonly generatedOrigins?: readonly Pick<DocumentLoopExpansion, "raw" | "expanded">[];
}

interface LatexVisualSetup {
  readonly colors: Record<string, string>;
  readonly math: ReturnType<typeof latexDocumentMathSetup>;
  readonly declarations: ReturnType<typeof latexEnvironmentDeclarations>;
}

function visualSetup(source: string): LatexVisualSetup {
  return {
    colors: latexDocumentColors(source),
    math: latexDocumentMathSetup(source),
    declarations: latexEnvironmentDeclarations(source),
  };
}

export interface LatexRootUpdate {
  readonly expected: string;
  readonly next: string;
}

export const LATEX_HEADING_STYLES = [
  { level: 6, command: "chapter", label: "Chapter" },
  { level: 1, command: "section", label: "Section" },
  { level: 2, command: "subsection", label: "Subsection" },
  { level: 3, command: "subsubsection", label: "Subsubsection" },
  { level: 4, command: "paragraph", label: "Paragraph heading" },
  { level: 5, command: "subparagraph", label: "Subparagraph heading" },
] as const;

export interface LatexVisualLayoutUpdate {
  readonly documentClass?: string;
  readonly paper: LatexVisualLayoutProfile["paper"];
  readonly baseFontPt: 10 | 11 | 12;
  readonly margin: string;
  readonly orientation?: "portrait" | "landscape";
  readonly margins?: Partial<Record<"top" | "right" | "bottom" | "left", string>>;
  readonly paragraphStyle: "indented" | "spaced";
}

function replaceOrInsertPreambleLine(
  source: string,
  pattern: RegExp,
  value: string,
  insertionAt: number,
  eol: string,
): string {
  const match = pattern.exec(source.slice(0, insertionAt));
  if (match)
    return source.slice(0, match.index) + value + source.slice(match.index + match[0].length);
  const boundary = insertionAt > 0 && !/[\r\n]/u.test(source[insertionAt - 1]!) ? eol : "";
  return source.slice(0, insertionAt) + boundary + value + eol + source.slice(insertionAt);
}

export function updateLatexVisualLayoutSource(
  source: string,
  update: Partial<LatexVisualLayoutUpdate>,
): string | null {
  const classAt = findDelimiter(source, "\\documentclass", 0);
  const documentClass = /^\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/u.exec(
    source.slice(classAt),
  );
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (classAt < 0 || !documentClass || begin < 0 || classAt > begin) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const targetClass = update.documentClass ?? documentClass[2];
  if (targetClass !== documentClass[2]) {
    if (
      !["article", "report", "book"].includes(targetClass ?? "") ||
      !["article", "report", "book"].includes(documentClass[2] ?? "")
    )
      return null;
    if (targetClass === "article" && /\\(?:chapter|part)\b/u.test(source.slice(begin))) return null;
    if (
      targetClass !== "book" &&
      /\\(?:frontmatter|mainmatter|backmatter)\b/u.test(source.slice(begin))
    )
      return null;
  }
  let changed = source;
  if (
    update.baseFontPt !== undefined ||
    update.paper !== undefined ||
    update.documentClass !== undefined ||
    update.orientation !== undefined
  ) {
    const options = (documentClass[1] ?? "")
      .split(",")
      .filter(
        (option) =>
          !(update.baseFontPt !== undefined && /^(?:10|11|12)pt$/u.test(option.trim())) &&
          !(update.orientation !== undefined && /^(?:landscape|portrait)$/u.test(option.trim())) &&
          !(
            update.paper !== undefined &&
            /^(?:a4|a5|b5|letter|legal|executive)paper$/u.test(option.trim())
          ),
      );
    if (update.baseFontPt !== undefined) options.push(`${update.baseFontPt}pt`);
    if (update.paper !== undefined) options.push(`${update.paper}paper`);
    if (update.orientation === "landscape") options.push("landscape");
    const value = options.filter(Boolean).join(",");
    changed =
      source.slice(0, classAt) +
      `\\documentclass${value ? `[${value}]` : ""}{${targetClass}}` +
      source.slice(classAt + documentClass[0].length);
  }
  const margins =
    update.margins ??
    (update.margin === undefined
      ? undefined
      : { top: update.margin, right: update.margin, bottom: update.margin, left: update.margin });
  if (margins !== undefined || update.paper !== undefined || update.orientation !== undefined) {
    if (margins !== undefined) {
      const values = Object.values(margins).map((value) => latexLengthInches(value));
      const profile = latexVisualLayoutProfile(source);
      const paper = LATEX_PAPER_SIZES[update.paper ?? profile.paper];
      const landscape = update.orientation
        ? update.orientation === "landscape"
        : profile.paperWidthIn > profile.paperHeightIn;
      const width = landscape ? paper.height : paper.width;
      const height = landscape ? paper.width : paper.height;
      if (
        Object.values(margins).some(
          (value) => !/^(?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt)$/u.test(value.trim()),
        ) ||
        values.some((value) => value === null || value <= 0) ||
        (latexLengthInches(margins.left ?? "") ?? profile.marginLeftIn) +
          (latexLengthInches(margins.right ?? "") ?? profile.marginRightIn) >=
          width ||
        (latexLengthInches(margins.top ?? "") ?? profile.marginTopIn) +
          (latexLengthInches(margins.bottom ?? "") ?? profile.marginBottomIn) >=
          height
      )
        return null;
    }
    const options = (value: string) =>
      [
        ...value
          .split(/,(?![^{}]*\})/u)
          .filter(
            (option) =>
              !(
                update.margin !== undefined &&
                /^(?:margin|hmargin|vmargin|top|right|bottom|left|inner|outer|textwidth|textheight|width|height|total|scale|hscale|vscale)\s*=/u.test(
                  option.trim(),
                )
              ) &&
              !(
                update.margins &&
                Object.keys(update.margins).some((side) =>
                  new RegExp(`^${side}\\s*=`).test(option.trim()),
                )
              ) &&
              !(
                update.orientation !== undefined &&
                /^(?:landscape|portrait)(?:\s*=|$)/u.test(option.trim())
              ) &&
              !(
                update.paper !== undefined &&
                /^(?:(?:a4|a5|b5|letter|legal|executive)paper\b|(?:paper|paperwidth|paperheight)\s*=)/u.test(
                  option.trim(),
                )
              ),
          ),
        ...(update.margins
          ? Object.entries(update.margins).map(
              ([side, value]) => `${side}=${value.replace(/\s+/gu, "")}`,
            )
          : update.margin !== undefined
            ? [`margin=${update.margin.replace(/\s+/gu, "")}`]
            : []),
        ...(update.paper !== undefined ? [`${update.paper}paper`] : []),
        ...(update.orientation !== undefined ? [update.orientation] : []),
      ]
        .filter(Boolean)
        .join(",");
    const at = findDelimiter(changed, "\\begin{document}", 0);
    const preamble = changed.slice(0, at);
    const geometry = /\\usepackage(?:\[([^\]]*)\])?\{geometry\}/u;
    const configure = /\\geometry\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu;
    if (
      geometry.test(preamble) ||
      /\\usepackage(?:\[[^\]]*\])?\{[^{}]*\bgeometry\b[^{}]*\}/u.test(preamble)
    ) {
      let updated = preamble.replace(
        geometry,
        (_match, value: string | undefined) => `\\usepackage[${options(value ?? "")}]{geometry}`,
      );
      if (configure.test(preamble))
        updated = updated.replace(
          configure,
          (_match, value: string) => `\\geometry{${options(value)}}`,
        );
      else if (updated === preamble) updated += `\\geometry{${options("")}}${eol}`;
      changed = updated + changed.slice(at);
    } else if (margins !== undefined) {
      // Introducing geometry must retain the other standard-class margins.
      const profile = latexVisualLayoutProfile(source);
      if (!["article", "report", "book"].includes(profile.documentClass)) return null;
      const retained = update.margins
        ? (["top", "right", "bottom", "left"] as const)
            .filter((side) => update.margins?.[side] === undefined)
            .map((side) => {
              const values = {
                top: profile.marginTopIn,
                right: profile.marginRightIn,
                bottom: profile.marginBottomIn,
                left: profile.marginLeftIn,
              };
              return `${side}=${values[side].toFixed(6)}in`;
            })
            .join(",")
        : "";
      changed =
        preamble +
        (preamble.endsWith("\n") ? "" : eol) +
        `\\usepackage[${[retained, options("")].filter(Boolean).join(",")}]{geometry}${eol}` +
        changed.slice(at);
    }
  }
  if (update.paragraphStyle !== undefined) {
    for (const [command, value] of [
      ["parindent", update.paragraphStyle === "spaced" ? "0pt" : "1.5em"],
      ["parskip", update.paragraphStyle === "spaced" ? "0.75em" : "0pt plus 1pt"],
    ]) {
      changed = replaceOrInsertPreambleLine(
        changed,
        new RegExp(`\\\\setlength\\{\\\\${command}\\}\\{[^{}]+\\}`, "u"),
        `\\setlength{\\${command}}{${value}}`,
        findDelimiter(changed, "\\begin{document}", 0),
        eol,
      );
    }
  }
  return changed;
}

const INLINE_ATOMS = new Set([
  "columnbreak",
  "verb",
  "cite",
  "citep",
  "citet",
  "parencite",
  "textcite",
  "citeauthor",
  "citeyear",
  "ref",
  "eqref",
  "subref",
  "autoref",
  "pageref",
  "nameref",
  "label",
  "url",
  "href",
  "hyperref",
  "hyperlink",
  "hypertarget",
  "footnote",
  "index",
]);
const SOURCE_ONLY_INLINE_COMMANDS = new Set([
  "begin",
  "end",
  "input",
  "include",
  "includeonly",
  "documentclass",
  "usepackage",
  "RequirePackage",
  "write",
  "openout",
  "read",
]);
const DISPLAY_MATH_ENVIRONMENTS = /^(equation\*?|align\*?|gather\*?)$/u;
const STRUCTURED_MATH_ENVIRONMENTS = [
  "matrix",
  "bmatrix",
  "pmatrix",
  "vmatrix",
  "Vmatrix",
  "cases",
  "aligned",
] as const;
const STRUCTURED_MATH_ENVIRONMENT = new RegExp(
  `^(?:${STRUCTURED_MATH_ENVIRONMENTS.join("|")})$`,
  "u",
);
const ESCAPES: Readonly<Record<string, string>> = {
  "%": "%",
  "&": "&",
  _: "_",
  "#": "#",
  $: "$",
  "{": "{",
  "}": "}",
};

function textNode(text: string, marks: readonly string[]): JSONContent | null {
  if (!text) return null;
  return {
    type: "text",
    text,
    ...(marks.length === 0 ? {} : { marks: marks.map((type) => ({ type })) }),
  };
}

function closingBrace(source: string, opening: number): number | null {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (source[index] === "%") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) return null;
      index = newline;
    } else if (source[index] === "\\") {
      index++;
    } else if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

const TEXT_SYMBOLS: Readonly<Record<string, string>> = {
  quad: "\u2003",
  qquad: "\u2003\u2003",
  enspace: "\u2002",
  ss: "\u00df",
  SS: "\u1e9e",
  ae: "\u00e6",
  AE: "\u00c6",
  oe: "\u0153",
  OE: "\u0152",
  aa: "\u00e5",
  AA: "\u00c5",
  o: "\u00f8",
  O: "\u00d8",
  l: "\u0142",
  L: "\u0141",
  i: "\u0131",
  j: "\u0237",
  textbackslash: "\\",
  textasciitilde: "~",
  textasciicircum: "^",
  textendash: "\u2013",
  textemdash: "\u2014",
  textellipsis: "\u2026",
  dots: "\u2026",
  ldots: "\u2026",
  textquoteleft: "\u2018",
  textquoteright: "\u2019",
  textquotedblleft: "\u201c",
  textquotedblright: "\u201d",
  textquotesingle: "'",
  textasciigrave: "`",
  guillemotleft: "\u00ab",
  guillemotright: "\u00bb",
  guilsinglleft: "\u2039",
  guilsinglright: "\u203a",
  textless: "<",
  textgreater: ">",
  textbar: "|",
  textbraceleft: "{",
  textbraceright: "}",
  textunderscore: "_",
  textcopyright: "\u00a9",
  copyright: "\u00a9",
  textregistered: "\u00ae",
  texttrademark: "\u2122",
  textdegree: "\u00b0",
  textdagger: "\u2020",
  textdaggerdbl: "\u2021",
  textbullet: "\u2022",
  textsection: "\u00a7",
  textparagraph: "\u00b6",
  S: "\u00a7",
  P: "\u00b6",
  pounds: "\u00a3",
  textsterling: "\u00a3",
  textdollar: "$",
};
const textGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const TEXT_ACCENTS: Readonly<Record<string, string>> = {
  "'": "\u0301",
  '"': "\u0308",
  "`": "\u0300",
  "^": "\u0302",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
  u: "\u0306",
  v: "\u030c",
  H: "\u030b",
  c: "\u0327",
  k: "\u0328",
  r: "\u030a",
  b: "\u0331",
  d: "\u0323",
};

function textAccent(source: string): { source: string; text: string } | null {
  const command = /^\\(['"`^~=.]|[uvHckrbd](?![A-Za-z]))/u.exec(source);
  if (!command) return null;
  const argument =
    /^(?:[\t\r\n ]*\{([A-Za-z]|\\[ij])\}|[\t\r\n ]*([A-Za-z]|\\[ij](?![A-Za-z])))/u.exec(
      source.slice(command[0].length),
    );
  if (!argument) return null;
  const base = argument[1] ?? argument[2]!;
  return {
    source: command[0] + argument[0],
    text: (
      (base === "\\i" ? "i" : base === "\\j" ? "j" : base) + TEXT_ACCENTS[command[1]!]!
    ).normalize("NFC"),
  };
}

/** TeX control words consume their delimiter spaces; an empty group ends the word. */
function inlineTextToken(
  source: string,
  marks: readonly string[],
): { source: string; text: string } | null {
  const accent = textAccent(source);
  if (accent) return accent;
  const escaped = source[0] === "\\" ? ESCAPES[source[1] ?? ""] : undefined;
  if (escaped !== undefined) return { source: source.slice(0, 2), text: escaped };
  const controlSpace = /^\\(?:[ \t](?:[\t ]*)|\r?\n)/u.exec(source);
  if (controlSpace) return { source: controlSpace[0], text: " " };
  if (source.startsWith("\\,")) return { source: "\\,", text: "\u2009" };
  const symbol = /^\\([A-Za-z]+)(?:\{\}|[\t\r\n ]*)/u.exec(source);
  if (symbol && TEXT_SYMBOLS[symbol[1]!] !== undefined)
    return { source: symbol[0], text: TEXT_SYMBOLS[symbol[1]!]! };
  if (source[0] === "~") return { source: "~", text: "\u00a0" };
  const whitespace = /^[\t\r\n ]+/u.exec(source);
  if (whitespace) return { source: whitespace[0], text: " " };
  for (const [token, text] of [
    ["---", "\u2014"],
    ["--", "\u2013"],
    ["``", "\u201c"],
    ["''", "\u201d"],
    ["`", "\u2018"],
    ["'", "\u2019"],
  ] as const) {
    if (!marks.includes("code") && source.startsWith(token)) return { source: token, text };
  }
  if (/^[\\%{}&#^_$]/u.test(source)) return null;
  // Ordinary ASCII avoids allocating a grapheme iterator for every keystroke.
  if (/^[\x00-\x7f](?!\p{Mark})/u.test(source)) return { source: source[0]!, text: source[0]! };
  const text = textGraphemes.segment(source)[Symbol.iterator]().next().value?.segment;
  return text ? { source: text, text } : null;
}

interface InlineGroup {
  readonly from: number;
  readonly to: number;
  readonly end: number;
  readonly marks: readonly string[];
  readonly prefix: string;
}

function inlineGroup(source: string, at: number, marks: readonly string[]): InlineGroup | null {
  const rest = source.slice(at);
  const command = /^\\(foreignlanguage\{(?:english|hebrew)\}|[A-Za-z]+)[\t\r\n ]*\{/u.exec(rest);
  const mark = command ? LATEX_INLINE_MARKS[command[1]!] : undefined;
  if (rest[0] !== "{" && mark === undefined) return null;
  const opening = mark === undefined ? at : at + command![0].length - 1;
  const close = closingBrace(source, opening);
  if (close === null) return null;
  let from = opening + 1;
  let nextMarks =
    mark === undefined
      ? marks
      : withLatexTextMark(
          marks,
          command?.[1] === "emph" &&
            marks.some((type) => type === "italic" || type === "latexSlanted")
            ? "latexUpright"
            : mark,
        );
  // Declarations affect the rest of this group and stop at its closing brace.
  for (;;) {
    const declaration = /^\\([A-Za-z]+)(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u.exec(
      source.slice(from, close),
    );
    const declaredMark = declaration ? LATEX_TEXT_DECLARATIONS[declaration[1]!] : undefined;
    if (declaredMark === undefined) break;
    nextMarks = withLatexTextMark(nextMarks, declaredMark);
    from += declaration![0].length;
  }
  return { from, to: close, end: close + 1, marks: nextMarks, prefix: source.slice(at, from) };
}

interface InlinePiece {
  readonly end: number;
  readonly node?: JSONContent;
  readonly group?: InlineGroup;
  readonly declaration?: string;
  readonly ignored?: boolean;
}

function commentEnd(source: string, from: number): number {
  const newline = source.indexOf("\n", from);
  return newline < 0 ? source.length : newline + 1;
}

/** Comments are source trivia; percent signs in escaped or literal text are content. */
function latexCommentRanges(source: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const token of source.matchAll(/\\([A-Za-z]+|[^\r\n])|%/gu)) {
    const from = token.index;
    if (from < cursor) continue;
    if (token[0] === "%") {
      cursor = commentEnd(source, from);
      ranges.push({ from, to: cursor });
    } else if (token[1] === "verb") {
      const opening = from + token[0].length + Number(source[from + token[0].length] === "*");
      const delimiter = source[opening];
      if (delimiter && !/\s/u.test(delimiter)) {
        const closing = source.indexOf(delimiter, opening + 1);
        const newline = source.indexOf("\n", opening + 1);
        if (closing >= 0 && (newline < 0 || closing < newline)) cursor = closing + 1;
      }
    } else if (token[1] === "begin") {
      const literal = latexLiteralBlock(source, from);
      if (literal) {
        cursor = literal.end;
        continue;
      }
      const environment = /^\s*\{(verbatim\*?|Verbatim|alltt|lstlisting|tcblisting|minted)\}/u.exec(
        source.slice(from + token[0].length),
      );
      if (environment) {
        const closing = `\\end{${environment[1]}}`;
        const end = source.indexOf(closing, from + token[0].length + environment[0].length);
        cursor = end < 0 ? source.length : end + closing.length;
      }
    }
  }
  return ranges;
}

function withoutVisualComments(source: string): string {
  if (!source.includes("%")) return source;
  let result = "";
  let cursor = 0;
  for (const range of latexCommentRanges(source)) {
    result += source.slice(cursor, range.from);
    cursor = range.to;
  }
  return result + source.slice(cursor);
}

/** Retain hidden comments even when replacing or deleting their surrounding content. */
function preserveSourceComments(
  original: string,
  replacement: string,
  eol: string,
  following: string,
): string {
  if (!original.includes("%") && !replacement.includes("%")) return replacement;
  const existing = new Map<string, number>();
  const replacementRanges = latexCommentRanges(replacement);
  for (const range of replacementRanges) {
    const comment = replacement.slice(range.from, range.to).replace(/\r?\n$/u, "");
    existing.set(comment, (existing.get(comment) ?? 0) + 1);
  }
  let result = replacement;
  // A retained final comment must not swallow the following source or new text.
  if (
    replacementRanges.at(-1)?.to === replacement.length &&
    !replacement.endsWith("\n") &&
    !/^\r?\n/u.test(following)
  )
    result += eol;
  for (const range of latexCommentRanges(original)) {
    const comment = original.slice(range.from, range.to).replace(/\r?\n$/u, "");
    const count = existing.get(comment) ?? 0;
    if (count > 0) existing.set(comment, count - 1);
    else result += comment + eol;
  }
  return result;
}

/** Rendering and source mapping use the same supported inline grammar. */
function inlinePiece(
  source: string,
  at: number,
  marks: readonly string[],
  scoped = false,
): InlinePiece | null {
  const rest = source.slice(at);
  const literal = inlineLatexLiteral(source, at);
  if (literal) {
    return {
      end: literal.end,
      node: {
        type: "latexInlineCommand",
        attrs: {
          name: "verb",
          argument: literal.text,
          raw: source.slice(at, literal.end),
        },
      },
    };
  }
  if (rest[0] === "%") {
    const end = commentEnd(source, at);
    const indentation = /^[\t ]*/u.exec(source.slice(end))![0];
    return { end: end + indentation.length, ignored: true };
  }
  const group = inlineGroup(source, at, marks);
  if (group) return { end: group.end, group };
  if (scoped) {
    const declaration = /^\\([A-Za-z]+)(?![A-Za-z])(?:\{\}|[\t\r\n ]*)/u.exec(rest);
    const mark = declaration ? LATEX_TEXT_DECLARATIONS[declaration[1]!] : undefined;
    if (mark !== undefined) return { end: at + declaration![0].length, declaration: mark };
  }
  const marked = (node: JSONContent): JSONContent => ({
    ...node,
    ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
  });
  const columnBreak = /^\\columnbreak\b(?:[\t ]*\[4\])?[\t ]*(?:\r?\n[\t ]*)?/u.exec(rest);
  if (columnBreak) {
    if (/^\s*\[/u.test(rest.slice(columnBreak[0].length))) return null;
    return {
      end: at + columnBreak[0].length,
      node: marked({
        type: "latexInlineCommand",
        attrs: { name: "columnbreak", argument: "", raw: columnBreak[0] },
      }),
    };
  }
  const math = rest.startsWith("\\(")
    ? { open: "\\(", close: "\\)", wrapper: "paren" }
    : rest.startsWith("$") && !rest.startsWith("$$")
      ? { open: "$", close: "$", wrapper: "dollar" }
      : null;
  if (math) {
    const close = findDelimiter(source, math.close, at + math.open.length);
    if (close < 0) return null;
    return {
      end: close + math.close.length,
      node: marked({
        type: "latexInlineMath",
        attrs: { tex: source.slice(at + math.open.length, close), wrapper: math.wrapper },
      }),
    };
  }
  const lineBreak = /^(?:\\\\|\\newline(?![A-Za-z]))[\t ]*(?:\r?\n[\t ]*)?/u.exec(rest);
  if (lineBreak) {
    // Optional lengths and starred breaks need their own layout support.
    if (/^[*\[]/u.test(rest.slice(lineBreak[0].length))) return null;
    return { end: at + lineBreak[0].length, node: marked({ type: "hardBreak" }) };
  }
  const text = inlineTextToken(rest, marks);
  if (text) return { end: at + text.source.length, node: textNode(text.text, marks)! };
  const atomCommand = /^\\([A-Za-z]+)[\t\r\n ]*(\{|\[)/u.exec(rest);
  if (
    !atomCommand ||
    !INLINE_ATOMS.has(atomCommand[1]!) ||
    SOURCE_ONLY_INLINE_COMMANDS.has(atomCommand[1]!)
  )
    return null;
  const name = atomCommand[1]!;
  const citation = latexCitationParts(rest);
  if (citation) {
    return {
      end: at + citation.end,
      node: marked({
        type: "latexInlineCommand",
        attrs: { name, argument: citation.argument, raw: rest.slice(0, citation.end) },
      }),
    };
  }
  if ((name === "hyperref") !== (atomCommand[2] === "[")) return null;
  const opening = at + atomCommand[0].length - 1;
  const close =
    name === "hyperref" ? source.indexOf("]", opening + 1) : closingBrace(source, opening);
  if (close === null || close < 0) return null;
  const argument = source.slice(opening + 1, close);
  if (name === "hyperref" && /[{}\\%\s\[\]]/u.test(argument)) return null;
  let end = close + 1;
  let linkText: string | undefined;
  if (["href", "hyperref", "hyperlink", "hypertarget"].includes(name)) {
    const gap = /^[\t\r\n ]*/u.exec(source.slice(end))![0];
    const textOpening = end + gap.length;
    if (source[textOpening] !== "{") return null;
    const textEnd = closingBrace(source, textOpening);
    if (textEnd === null) return null;
    linkText = source.slice(textOpening + 1, textEnd);
    if (parseInline(linkText) === null) return null;
    end = textEnd + 1;
  }
  return {
    end,
    node: marked({
      type: "latexInlineCommand",
      attrs: {
        name,
        argument,
        ...(linkText === undefined ? {} : { linkText }),
        raw: source.slice(at, end),
      },
    }),
  };
}

function parseInline(
  source: string,
  marks: readonly string[] = [],
  scoped = false,
): JSONContent[] | null {
  const nodes: JSONContent[] = [];
  let currentMarks = marks;
  for (let at = 0; at < source.length;) {
    const colored = latexInlineColor(source, at);
    if (colored) {
      const content = parseInline(colored.body.value, currentMarks, scoped);
      if (!content) return null;
      nodes.push(
        ...content.map((node) => ({
          ...node,
          marks: [
            {
              type: colored.attrs.command === "textcolor" ? "latexColor" : "latexBackground",
              attrs: colored.attrs,
            },
            ...(node.marks ?? []),
          ],
        })),
      );
      at = colored.body.end;
      continue;
    }
    const piece = inlinePiece(source, at, currentMarks, scoped);
    if (!piece) return null;
    if (piece.ignored) {
      at = piece.end;
      continue;
    }
    if (piece.declaration) {
      currentMarks = withLatexTextMark(currentMarks, piece.declaration);
      at = piece.end;
      continue;
    }
    const children = piece.group
      ? parseInline(source.slice(piece.group.from, piece.group.to), piece.group.marks, true)
      : [piece.node!];
    if (!children) return null;
    for (const node of children) {
      const previous = nodes.at(-1);
      if (
        node.type === "text" &&
        previous?.type === "text" &&
        JSON.stringify(node.marks ?? []) === JSON.stringify(previous.marks ?? [])
      )
        nodes[nodes.length - 1] = { ...previous, text: previous.text! + node.text! };
      else nodes.push(node);
    }
    at = piece.end;
  }
  return nodes;
}

function sourceId(index: number): string {
  return `latex-block-${index}`;
}

function withSourceId(node: JSONContent, id: string): JSONContent {
  return { ...node, attrs: { ...node.attrs, sourceId: id } };
}

function parseHeading(source: string): JSONContent | null {
  const match = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\{/u.exec(
    source,
  );
  if (!match) return null;
  const opening = match[0].length - 1;
  const close = closingBrace(source, opening);
  if (close === null) return null;
  const tail = source.slice(close + 1).trim();
  const label = /^\\label\{([^{}\\%\s]+)\}$/u.exec(tail);
  if (tail && !label) return null;
  const content = parseInline(source.slice(opening + 1, close));
  if (content === null) return null;
  const level = LATEX_HEADING_STYLES.find((style) => style.command === match[1])!.level;
  return {
    type: "heading",
    attrs: {
      level,
      latexCommand: match[1],
      unnumbered: match[2] === "*",
      referenceLabel: label?.[1] ?? null,
    },
    content,
  };
}

function parseList(source: string, depth: number, setup: LatexVisualSetup): JSONContent | null {
  if (depth > 32) return null;
  const opening = /^\\begin\{(itemize|enumerate)\}/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  const optionRange = optionalArgumentRange(source, opening[0].length);
  const options = parseLatexListOptions(optionRange?.source ?? "");
  if (!options || (optionRange && environment !== "enumerate")) return null;
  const bodyFrom = optionRange?.end ?? opening[0].length;
  const closing = `\\end{${environment}}`;
  const close = source.lastIndexOf(closing);
  if (close < bodyFrom || source.slice(close + closing.length).trim() !== "") return null;
  const body = source.slice(bodyFrom, close);
  const matches: { index: number; length: number }[] = [];
  for (let cursor = 0; cursor < body.length; cursor++) {
    if (body[cursor] === "%") return null;
    if (body[cursor] === "{") {
      const close = closingBrace(body, cursor);
      if (close === null) return null;
      cursor = close;
    } else if (body.startsWith("\\begin{", cursor)) {
      const close = matchingEnvironmentEnd(body, cursor);
      if (close === null) return null;
      cursor = close - 1;
    } else if (body[cursor] === "\\") {
      const item = /^\\item(?![a-zA-Z])\s*/u.exec(body.slice(cursor));
      if (item) {
        if (body[cursor + item[0].length] === "[") return null;
        matches.push({ index: cursor, length: item[0].length });
        cursor += item[0].length - 1;
      } else cursor++;
    }
  }
  if (matches.length === 0) return null;
  if (body.slice(0, matches[0]!.index).trim()) return null;
  const items: JSONContent[] = [];
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index]!.index + matches[index]!.length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : body.length;
    const item = body.slice(start, end).trim();
    const projected = projectLatexVisualDocument(item, depth + 1, setup);
    if (projected.rawBlocks > 0 || projected.blocks[0]?.node.type !== "paragraph") return null;
    items.push({ type: "listItem", content: projected.content.content ?? [] });
  }
  return {
    type: environment === "itemize" ? "bulletList" : "orderedList",
    attrs: {
      ...(options.resume ? { resume: true } : {}),
      ...(options.start !== 1 ? { start: options.start } : {}),
      ...(optionRange ? { latexListOptions: optionRange.source } : {}),
    },
    content: items,
  };
}

export interface LatexVisualMathAttributes {
  readonly tex: string;
  readonly environment?: string | null;
  readonly wrapper?: "paren" | "dollar" | "bracket" | "double-dollar";
  readonly numbering?: readonly (readonly string[])[] | null;
  readonly numberingSource?: string | null;
}

export function latexVisualMathSource(
  attributes: LatexVisualMathAttributes,
  display: boolean,
): string {
  if (display && attributes.numberingSource)
    return (
      patchNumberedMathSource(attributes.numberingSource, attributes.tex) ??
      attributes.numberingSource
    );
  const tex = attributes.tex;
  if (display && attributes.environment)
    return `\\begin{${attributes.environment}}\n${tex}\n\\end{${attributes.environment}}`;
  if (display && attributes.wrapper === "double-dollar") return `$$\n${tex}\n$$`;
  if (display) return `\\[\n${tex}\n\\]`;
  if (attributes.wrapper === "dollar") return `$${tex}$`;
  return `\\(${tex}\\)`;
}

export function parseLatexVisualMathSource(
  source: string,
  display: boolean,
): LatexVisualMathAttributes | null {
  const trimmed = source.trim();
  if (/\\(?:newcommand|renewcommand|def|catcode)\b/u.test(trimmed)) return null;
  if (!display) {
    if (/\\(?:label|tag|notag|nonumber)\b/u.test(trimmed)) return null;
    if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)"))
      return { tex: trimmed.slice(2, -2), wrapper: "paren" };
    if (
      trimmed.startsWith("$") &&
      !trimmed.startsWith("$$") &&
      trimmed.endsWith("$") &&
      !trimmed.endsWith("$$")
    )
      return { tex: trimmed.slice(1, -1), wrapper: "dollar" };
    return null;
  }
  const project = (attributes: LatexVisualMathAttributes): LatexVisualMathAttributes | null => {
    if (!/\\(?:label|tag|notag|nonumber)\b/u.test(attributes.tex)) return attributes;
    const numbered = projectMathNumbering(attributes.tex);
    if (!numbered) return null;
    if (!numbered.commands.some((row) => row.length > 0)) return attributes;
    return {
      ...attributes,
      tex: numbered.tex,
      numbering: numbered.commands,
      numberingSource: trimmed,
    };
  };
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return project({ tex: trimmed.slice(2, -2).trim(), wrapper: "bracket" });
  }
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return project({ tex: trimmed.slice(2, -2).trim(), wrapper: "double-dollar" });
  }
  const environment = /^\\begin\{([^}]+)\}([\s\S]*)\\end\{\1\}$/u.exec(trimmed);
  if (!environment || !DISPLAY_MATH_ENVIRONMENTS.test(environment[1]!)) return null;
  return project({
    tex: environment[2]!.trim(),
    environment: environment[1]!,
  });
}

function serializeNumberedMath(
  attributes: LatexVisualMathAttributes,
  source: string,
): string | null {
  const original = parseLatexVisualMathSource(source, true);
  if (!original?.numberingSource) return null;
  if (
    original.environment !== (attributes.environment ?? undefined) ||
    (original.wrapper ?? "bracket") !== (attributes.wrapper ?? "bracket")
  ) {
    // The compact Numbered control may change a single equation's wrapper,
    // including one with a label. Tags and per-row metadata stay protected.
    const switched = withMathNumbering(source, attributes.environment === "equation");
    if (switched === null) return null;
    const parsed = parseLatexVisualMathSource(switched, true);
    if (
      !parsed ||
      parsed.environment !== (attributes.environment ?? undefined) ||
      (parsed.wrapper ?? "bracket") !== (attributes.wrapper ?? "bracket") ||
      JSON.stringify(parsed.numbering ?? null) !== JSON.stringify(attributes.numbering ?? null)
    )
      return null;
    return patchNumberedMathSource(switched, attributes.tex);
  }
  if (JSON.stringify(original.numbering ?? null) !== JSON.stringify(attributes.numbering ?? null)) {
    // Only the single outer reference label may change here. Row metadata and
    // all other numbering commands still have to match the original source.
    const desired = latexVisualMathSource(attributes, true);
    const label = singleMathReferenceLabel(desired);
    const relabeled = label === null ? null : withMathReferenceLabel(source, label);
    if (relabeled === null) return null;
    const parsed = parseLatexVisualMathSource(relabeled, true);
    if (
      !parsed ||
      JSON.stringify(parsed.numbering ?? null) !== JSON.stringify(attributes.numbering ?? null)
    )
      return null;
    return patchNumberedMathSource(relabeled, attributes.tex);
  }
  return patchNumberedMathSource(source, attributes.tex);
}

function parseDisplayMath(source: string): JSONContent | null {
  const attributes = parseLatexVisualMathSource(source, true);
  return attributes === null ? null : { type: "latexDisplayMath", attrs: attributes };
}

export function parseStructuredMathEnvironment(source: string): string | null {
  const trimmed = source.trim();
  const environment = /^\\begin\{([^}]+)\}([\s\S]*)\\end\{\1\}$/u.exec(trimmed);
  if (!environment || !STRUCTURED_MATH_ENVIRONMENT.test(environment[1]!)) return null;
  if (/\\(?:label|tag|newcommand|renewcommand|def|catcode)\b/u.test(trimmed)) return null;
  return trimmed;
}

function matchingEnvironmentEnd(source: string, from: number, depth = 0): number | null {
  if (depth > 64) return null;
  const opening = /^\\begin\{([^}]+)\}/u.exec(source.slice(from));
  if (!opening) return null;
  const name = opening[1]!;
  const closing = `\\end{${name}}`;
  if (["verbatim", "verbatim*", "lstlisting", "tcblisting", "minted"].includes(name)) {
    for (let cursor = from + opening[0].length; cursor < source.length;) {
      const newline = source.indexOf("\n", cursor);
      if (newline < 0) return null;
      const lineStart = newline + 1;
      const next = source.indexOf("\n", lineStart);
      const line = source.slice(lineStart, next < 0 ? source.length : next);
      if (line.trim() === closing) return lineStart + line.indexOf(closing) + closing.length;
      cursor = lineStart;
    }
    return null;
  }
  for (let cursor = from + opening[0].length; cursor < source.length; cursor++) {
    const literal = inlineLatexLiteral(source, cursor);
    if (literal) {
      cursor = literal.end - 1;
      continue;
    }
    if (source[cursor] === "%") {
      const newline = source.indexOf("\n", cursor);
      if (newline < 0) return null;
      cursor = newline;
    } else if (source.startsWith(closing, cursor)) return cursor + closing.length;
    else if (source.startsWith("\\begin{", cursor)) {
      const end = matchingEnvironmentEnd(source, cursor, depth + 1);
      if (end === null) return null;
      cursor = end - 1;
    } else if (source[cursor] === "\\") cursor++;
  }
  return null;
}

function findDelimiter(source: string, delimiter: string, from: number): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] === "%") {
      const end = source.indexOf("\n", index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (source.startsWith(delimiter, index)) return index;
    if (source[index] === "\\") index++;
  }
  return -1;
}

function nextBlockEnd(body: string, from: number): number {
  if (body[from] === "%") {
    const end = body.indexOf("\n", from);
    return end < 0 ? body.length : end;
  }
  const minipages = minipageRowRanges(body.slice(from));
  if (minipages) return from + minipages.at(-1)!.to;
  if (body.startsWith("\\begin{", from)) return matchingEnvironmentEnd(body, from) ?? body.length;
  if (body.startsWith("\\[", from)) {
    const close = findDelimiter(body, "\\]", from + 2);
    return close < 0 ? body.length : close + 2;
  }
  if (body.startsWith("$$", from)) {
    const close = findDelimiter(body, "$$", from + 2);
    return close < 0 ? body.length : close + 2;
  }
  const columnBreak = /^\\columnbreak\b(?:[\t ]*\[4\])?/u.exec(body.slice(from));
  if (columnBreak && !/^\s*\[/u.test(body.slice(from + columnBreak[0].length)))
    return from + columnBreak[0].length;
  const standalone =
    /^\\(?:maketitle|tableofcontents|listoffigures|listoftables|newpage|clearpage|par|smallskip|medskip|bigskip|vfill|hfill)\b/u.exec(
      body.slice(from),
    );
  if (standalone) return from + standalone[0].length;
  const documentCommand = latexDocumentCommand(body, from);
  if (documentCommand) return documentCommand.end;
  const bibliography = /^\\bibliography\s*\{[^{}]+\}/u.exec(body.slice(from));
  if (bibliography) return from + bibliography[0].length;
  const contentsEntry = contentsEntryRange(body, from);
  if (contentsEntry) return contentsEntry.end;
  if (
    /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/u.test(
      body.slice(from),
    )
  ) {
    const opening = body.indexOf("{", from);
    const close = closingBrace(body, opening);
    if (close === null) return body.length;
    const label = /^\s*\\label\{[^{}\\%\s]+\}/u.exec(body.slice(close + 1));
    return close + 1 + (label?.[0].length ?? 0);
  }
  let depth = 0;
  for (let index = from; index < body.length; index++) {
    const literal = inlineLatexLiteral(body, index);
    if (literal) {
      index = literal.end - 1;
      continue;
    }
    if (body[index] === "%") {
      const end = body.indexOf("\n", index);
      if (end < 0) return body.length;
      index = end - 1;
      continue;
    }
    // Inline formulas are one paragraph atom. Their environments, row breaks
    // and spacing commands must not become document-level block boundaries.
    if (
      body.startsWith("\\(", index) ||
      (body[index] === "$" && body[index - 1] !== "$" && body[index + 1] !== "$")
    ) {
      const math = inlinePiece(body, index, []);
      if (math?.node?.type === "latexInlineMath") {
        index = math.end - 1;
        continue;
      }
    }
    if (depth === 0 && index > from) {
      if (
        latexDocumentCommand(body, index) ||
        /^\\(?:listoffigures|listoftables|bibliography)\b/u.test(body.slice(index))
      )
        return index;
      if (body.startsWith("\\end{document}", index)) return index;
      if (/^\r?\n[\t ]*\r?\n/u.test(body.slice(index))) return index;
      if (
        /^\\(?:begin\{|\[|maketitle\b|tableofcontents\b|newpage\b|clearpage\b|par\b|smallskip\b|medskip\b|bigskip\b|vfill\b|hfill\b|addcontentsline\b|(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{)/u.test(
          body.slice(index),
        )
      )
        return index;
    }
    if (body[index] === "\\") index++;
    else if (body[index] === "{") depth++;
    else if (body[index] === "}") depth--;
  }
  return body.length;
}

function contentsEntryRange(source: string, from: number) {
  const command = /^\\addcontentsline(?![A-Za-z])/u.exec(source.slice(from));
  if (!command) return null;
  const arguments_: string[] = [];
  let end = from + command[0].length;
  for (let index = 0; index < 3; index++) {
    while (/\s/u.test(source[end] ?? "")) end++;
    if (source[end] !== "{") return null;
    const close = closingBrace(source, end);
    if (close === null) return null;
    arguments_.push(source.slice(end + 1, close));
    end = close + 1;
  }
  return { end, file: arguments_[0]!, kind: arguments_[1]!, title: arguments_[2]! };
}

function contentsEntry(source: string, from: number) {
  const range = contentsEntryRange(source, from);
  if (!range || range.file !== "toc") return null;
  const heading = LATEX_HEADING_STYLES.find((style) => style.command === range.kind);
  if (!heading && range.kind !== "part") return null;
  const content = parseInline(range.title);
  if (!content) return null;
  return {
    ...range,
    level: heading?.level === 6 || range.kind === "part" ? 0 : heading!.level,
    display: content
      .map((node) => node.text ?? String(node.attrs?.tex ?? node.attrs?.argument ?? ""))
      .join(""),
  };
}

/** Unsupported metadata stays visibly exact; it is never stripped into prose. */
function exactMetadataSource(source: string): string {
  return source;
}

function parseDescriptionPreview(source: string): JSONContent | null {
  const opening = /^\\begin\{description\}(?:\[([^\]]*)\])?/u.exec(source);
  const ending = source.lastIndexOf("\\end{description}");
  if (!opening || ending < opening[0].length) return null;
  const bodyFrom = opening[0].length;
  const body = source.slice(bodyFrom, ending);
  const item = /\\item\s*\[([^\]]*)\]/gu;
  const matches = [...body.matchAll(item)];
  if (matches.length === 0 || matches.length > 100) return null;
  let editable = true;
  const originalItems = matches.map((match, index) => {
    const itemFrom = match.index!;
    const itemTo = index + 1 < matches.length ? matches[index + 1]!.index! : body.length;
    const raw = body.slice(itemFrom, itemTo);
    const labelStart = match[0].indexOf("[") + 1;
    const label = editableTableCell(match[1]!, labelStart);
    const bodyStart = match[0].length;
    const itemBody = editableTableCell(raw.slice(bodyStart), bodyStart);
    if (!label || !itemBody) editable = false;
    return {
      id: `description-${index}`,
      raw,
      label: label?.display ?? exactMetadataSource(match[1]!),
      body: itemBody?.display ?? exactMetadataSource(raw.slice(bodyStart)),
      labelFrom: label?.from ?? 0,
      labelTo: label?.to ?? 0,
      bodyFrom: itemBody?.from ?? 0,
      bodyTo: itemBody?.to ?? 0,
    };
  });
  const items = originalItems.map(({ label, body: itemBody }) => ({
    label,
    body: itemBody,
  }));
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "description",
      raw: source,
      items,
      itemIds: originalItems.map((entry) => entry.id),
      caption: null,
      rows: null,
      descriptionStyle: /(?:^|,)\s*style\s*=\s*nextline(?:\s*,|$)/u.test(opening[1] ?? "")
        ? "nextline"
        : "standard",
      descriptionLeftMargin:
        /(?:^|,)\s*leftmargin\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt|em))(?:\s*,|$)/u
          .exec(opening[1] ?? "")?.[1]
          ?.replace(/\s+/gu, "") ?? null,
      editable,
      sourceMeta: {
        head: source.slice(0, bodyFrom + matches[0]!.index!),
        tail: source.slice(ending),
        originalItems,
      },
    },
  };
}

function currentDateLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

// Read metadata from earlier candidates without writing new private comments.
const HIDDEN_AUTHOR_COMMENT = /^% scient-hidden-author: (.*)(?:\r?\n|$)/mu;

function hiddenAuthor(source: string): string {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  const match = HIDDEN_AUTHOR_COMMENT.exec(begin < 0 ? source : source.slice(0, begin));
  if (!match) return "";
  try {
    const value: unknown = JSON.parse(match[1]!);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Decode editable metadata without treating escaped percent signs as comments. */
export function metadataText(value: string): string | null {
  const nodes = parseInline(value);
  if (
    !nodes ||
    nodes.some((node) => (node.type !== "text" && node.type !== "hardBreak") || node.marks?.length)
  )
    return null;
  return nodes.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("");
}

function titleMetadata(source: string) {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  const preamble = begin < 0 ? source : source.slice(0, begin);
  const declarations = latexTitleDeclarations(source);
  const title = declarations.get("title")?.value ?? null;
  const author = declarations.get("author")?.value ?? null;
  const date = declarations.get("date")?.value ?? null;
  const dateMode =
    date === null
      ? "default"
      : date.trim() === "\\today"
        ? "today"
        : date.trim() === ""
          ? "hidden"
          : "explicit";
  return {
    title: title === null ? "" : (metadataText(title) ?? exactMetadataSource(title)),
    author:
      author === null || !author.trim()
        ? hiddenAuthor(preamble)
        : (metadataText(author) ?? exactMetadataSource(author)),
    authorEnabled: author !== null && author.trim() !== "",
    date:
      dateMode === "default" || dateMode === "today"
        ? currentDateLabel()
        : (metadataText(date ?? "") ?? exactMetadataSource(date ?? "")),
    dateEnabled: dateMode !== "hidden",
    dateMode,
    sourceMeta: {
      titleEditable: title === null || metadataText(title) !== null,
      authorEditable: author === null || metadataText(author) !== null,
      dateEditable: dateMode !== "explicit" || metadataText(date ?? "") !== null,
    },
  };
}

/** Restore the printed title without replacing existing document metadata. */
function ensureLatexTitleBlock(source: string, defaultTitle: string): string | null {
  const marker = "\\begin{document}";
  const begin = findDelimiter(source, marker, 0);
  if (begin < 0) return null;
  if (/\\maketitle\b/u.test(source.slice(begin + marker.length).replace(/(?<!\\)%[^\r\n]*/gu, "")))
    return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let changed = source;
  if (commandArgument(source.slice(0, begin), "title") === null)
    changed =
      setPreambleCommandArgument(changed, "title", escapeText(defaultTitle), eol) ?? changed;
  for (const command of ["author", "date"]) {
    if (commandArgument(source.slice(0, begin), command) === null)
      changed = setPreambleCommandArgument(changed, command, "", eol) ?? changed;
  }
  const at = findDelimiter(changed, marker, 0) + marker.length;
  return changed.slice(0, at) + eol + "\\maketitle" + eol + changed.slice(at);
}

/** Explicit title creation/conversion. Imported custom title pages stay source-owned. */
export function prepareLatexDocumentTitle(
  source: string,
  paragraphIndex?: number,
): {
  source: string;
  previousTitle: string;
  title: string;
} | null {
  const projected = projectLatexVisualDocument(source);
  const printed = projected.blocks.filter((block) => block.node.attrs?.kind === "title");
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (begin < 0 || printed.length > 1) return null;
  // A custom titlepage is not evidence that a standard title block is missing.
  const uncommented = source.replace(/(?<!\\)%[^\r\n]*/gu, "");
  if (/\\begin\s*\{titlepage\}/u.test(uncommented)) return null;
  const body = source.slice(begin).replace(/(?<!\\)%[^\r\n]*/gu, "");
  if (
    /\\(?:title|author|date)\s*\{/u.test(body) ||
    (printed.length === 0 && /\\maketitle\b/u.test(body))
  )
    return null;
  const previous = titleMetadata(source);
  if (previous.sourceMeta.titleEditable === false) return null;
  let changed = source;
  let title = String(previous.title ?? "");
  if (paragraphIndex !== undefined) {
    const paragraph = projected.blocks[paragraphIndex];
    if (
      !paragraph?.editable ||
      paragraph.node.type !== "paragraph" ||
      /(?<!\\)%/u.test(paragraph.source) ||
      !paragraph.node.content?.length ||
      paragraph.node.content.some((node) => node.type !== "text" || node.marks?.length)
    )
      return null;
    title = paragraph.node.content
      .map((node) => node.text ?? "")
      .join("")
      .trim();
    if (!title) return null;
    changed = source.slice(0, paragraph.from) + source.slice(paragraph.to);
    changed =
      setPreambleCommandArgument(
        changed,
        "title",
        escapeText(title),
        source.includes("\r\n") ? "\r\n" : "\n",
      ) ?? changed;
  }
  changed = ensureLatexTitleBlock(changed, title) ?? changed;
  return { source: changed, previousTitle: String(previous.title ?? ""), title };
}

/** Validate source snapshots carried by explicit document operations and their undo steps. */
export function projectLatexTitleSourceEdit(
  source: string,
  content: JSONContent,
  rootSource?: string,
) {
  const projected = projectLatexVisualDocument(source, 0, rootSource ?? source);
  if (roundTripSignature(projected.content) !== roundTripSignature(content)) return null;
  return {
    source,
    structural: true,
    projection: adoptLatexVisualContent(source, content, projected),
  };
}

function parseDocumentFrontMatter(source: string, documentSource: string): JSONContent | null {
  const command = latexDocumentCommand(source.trim());
  if (command && command.end === source.trim().length) {
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "documentCommand",
        raw: source,
        environment: command.name,
        body: command.name === "pagenumbering" ? command.value : "",
        editable: true,
      },
    };
  }
  if (source.trim() === "\\maketitle") {
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "title",
        raw: source,
        ...titleMetadata(documentSource),
        editable: true,
      },
    };
  }
  if (/^\\(?:tableofcontents|listoffigures|listoftables)$/u.test(source.trim())) {
    return {
      type: "latexRichPreview",
      attrs: { kind: "toc", environment: source.trim().slice(1), raw: source, editable: true },
    };
  }
  if (/^\\(?:newpage|clearpage)$/u.test(source.trim())) {
    return {
      type: "latexRichPreview",
      attrs: { kind: "pagebreak", raw: source, editable: true },
    };
  }
  const opening = /^\\begin\{abstract\}/u.exec(source);
  const ending = source.lastIndexOf("\\end{abstract}");
  if (!opening || ending < opening[0].length) return null;
  const body = editableTableCell(source.slice(opening[0].length, ending), opening[0].length);
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "abstract",
      raw: source,
      body: body?.display ?? exactMetadataSource(source.slice(opening[0].length, ending)),
      editable: body !== null,
      sourceMeta: body
        ? { bodyRange: { from: body.from, to: body.to, original: body.display } }
        : null,
    },
  };
}

const SIMPLE_LAYOUT_ENVIRONMENTS = new Set([
  "quotation",
  "verse",
  "verbatim",
  "verbatim*",
  "alltt",
  "lstlisting",
  "tcblisting",
  "flushleft",
  "flushright",
]);

function parseSimpleLayout(source: string, preamble: string): JSONContent | null {
  const opening = /^\\begin\{([^}]+)\}/u.exec(source);
  const environment = opening?.[1] ?? "";
  if (!opening || !SIMPLE_LAYOUT_ENVIRONMENTS.has(environment)) return null;
  const closing = `\\end{${environment}}`;
  if (!source.endsWith(closing)) return null;
  if (["verbatim", "verbatim*", "lstlisting", "tcblisting"].includes(environment)) {
    const range = latexLiteralBlock(source);
    if (!range || range.end !== source.length) return null;
    const presentation = ["lstlisting", "tcblisting"].includes(environment)
      ? latexListingPresentation(preamble, range.options)
      : null;
    if (["lstlisting", "tcblisting"].includes(environment) && !presentation) return null;
    const boxTitle = range.boxTitle ? metadataText(range.boxTitle.value) : "";
    if (
      boxTitle === null ||
      (range.box &&
        ![range.box.layout.colback, range.box.layout.colframe, range.box.layout.coltitle].every(
          (color) => latexColorCss(color, latexDocumentColors(preamble)),
        ))
    )
      return null;
    const captionOption = range.options.get("caption");
    const caption = captionOption
      ? editableTableCell(source.slice(captionOption.from, captionOption.to), captionOption.from)
      : null;
    if (captionOption && !caption) return null;
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "simple",
        environment,
        body: source.slice(range.bodyFrom, range.bodyTo),
        title: boxTitle,
        caption: caption?.display ?? null,
        label: range.options.get("label")?.value ?? null,
        raw: source,
        editable: true,
        sourceMeta: {
          literal: true,
          boxLayout: range.box?.layout ?? null,
          listingPresentation: presentation,
          captionRange: caption
            ? { from: caption.from, to: caption.to, original: caption.display }
            : null,
        },
      },
    };
  }
  const interior = source
    .slice(opening[0].length, -closing.length)
    .replace(/^\r?\n/u, "")
    .replace(/\r?\n$/u, "");
  const code = ["verbatim", "verbatim*", "alltt", "lstlisting"].includes(environment);
  const inline = code
    ? null
    : parseInline(
        interior
          .trim()
          .replace(/\\par\b/gu, "\n\n")
          .replace(/\\\\\s*\r?\n/gu, "\n"),
      );
  const editable =
    code ||
    (inline !== null &&
      inline.every(
        (node) => (node.type === "text" || node.type === "hardBreak") && !node.marks?.length,
      ));
  const body = code
    ? interior
    : editable
      ? inline!.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("")
      : exactMetadataSource(interior);
  return {
    type: "latexRichPreview",
    attrs: { kind: "simple", environment, body, raw: source, editable },
  };
}

function parsePartPreview(source: string): JSONContent | null {
  const opening = /^\\part(\*)?\{/u.exec(source);
  if (!opening) return null;
  const close = closingBrace(source, opening[0].length - 1);
  if (close === null) return null;
  const label = /^\s*\\label\{([^{}\\%\s]+)\}$/u.exec(source.slice(close + 1).trim());
  if (source.slice(close + 1).trim() && !label) return null;
  const inline = parseInline(source.slice(opening[0].length, close));
  const editable =
    inline !== null && inline.every((node) => node.type === "text" && !node.marks?.length);
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "part",
      title: editable
        ? inline!.map((node) => node.text ?? "").join("")
        : exactMetadataSource(source),
      unnumbered: Boolean(opening[1]),
      label: label?.[1] ?? "",
      raw: source,
      editable,
    },
  };
}

export function latexRomanNumber(value: number): string {
  let remaining = value;
  let result = "";
  for (const [amount, numeral] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

function parseBibliographyPreview(source: string): JSONContent | null {
  if (/^(?:\\bibliographystyle\s*\{[^{}]+\}\s*)?\\bibliography\s*\{[^{}]+\}\s*$/u.test(source))
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "bibliography",
        raw: source,
        items: [],
        editable: true,
        sourceMeta: { externalBibliography: true },
      },
    };
  const opening = /^\\begin\{thebibliography\}\{([^{}]*)\}/u.exec(source);
  const closing = "\\end{thebibliography}";
  if (!opening || !source.endsWith(closing)) return null;
  const body = source.slice(opening[0].length, -closing.length);
  if (/%/u.test(body)) return null;
  const matches = [...body.matchAll(/\\bibitem\s*(?:\[([^\[\]]*)\]\s*)?\{([^{}\\\s]+)\}/gu)];
  if (matches.length > 100) return null;
  let editable = !body.slice(0, matches[0]?.index ?? body.length).trim();
  const items = matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? body.length;
    const raw = body.slice(match.index! + match[0].length, end).trim();
    const inline = parseInline(raw);
    if (
      !inline ||
      inline.some((node) => node.type !== "text" && node.type !== "hardBreak") ||
      (match[1] !== undefined && metadataText(match[1]) === null)
    )
      editable = false;
    return {
      label: match[2]!,
      body: raw,
    };
  });
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "bibliography",
      raw: source,
      items,
      widestLabel: opening[1],
      editable,
      sourceMeta: {
        bibliographySource: true,
        header:
          source.slice(0, opening[0].length) + body.slice(0, matches[0]?.index ?? body.length),
        entries: matches.map((match, index) => ({
          key: match[2]!,
          displayLabel: match[1] === undefined ? null : metadataText(match[1]),
          body: items[index]!.body,
          source: body.slice(match.index, matches[index + 1]?.index ?? body.length),
        })),
      },
    },
  };
}

function commandArgument(source: string, command: string): string | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  return close === null ? null : source.slice(opening + 1, close);
}

function commandArgumentRange(
  source: string,
  command: string,
): { source: string; from: number; to: number } | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  return close === null
    ? null
    : { source: source.slice(opening + 1, close), from: opening + 1, to: close };
}

interface TabularBody {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly environment: string;
  readonly openingFrom: number;
  readonly openingTo: number;
  readonly endingFrom: number;
  readonly endingTo: number;
  readonly columnSpec: string;
  readonly width: string | null;
}

function requiredArgument(
  source: string,
  cursor: number,
): { source: string; from: number; to: number; next: number } | null {
  while (/\s/u.test(source[cursor] ?? "")) cursor++;
  if (source[cursor] !== "{") return null;
  const close = closingBrace(source, cursor);
  return close === null
    ? null
    : { source: source.slice(cursor + 1, close), from: cursor + 1, to: close, next: close + 1 };
}

function tabularBody(source: string): TabularBody | null {
  const opening = /\\begin\{(tabularx|tabular|tabulary|longtable)\}/u.exec(source);
  if (!opening) return null;
  const name = opening[1]!;
  let cursor = opening.index + opening[0].length;
  let tableWidth: string | null = null;
  if (name === "tabularx" || name === "tabulary") {
    const width = requiredArgument(source, cursor);
    if (!width) return null;
    tableWidth = width.source;
    cursor = width.next;
  }
  const columnSpec = requiredArgument(source, cursor);
  if (!columnSpec) return null;
  cursor = columnSpec.next;
  const ending = `\\end{${name}}`;
  const end = source.lastIndexOf(ending);
  return end <= cursor
    ? null
    : {
        source: source.slice(cursor, end),
        from: cursor,
        to: end,
        environment: name,
        openingFrom: opening.index,
        openingTo: cursor,
        endingFrom: end,
        endingTo: end + ending.length,
        columnSpec: columnSpec.source,
        width: tableWidth,
      };
}

type TableAlignment = "left" | "center" | "right";
const TABLE_PARAGRAPH_COLUMNS = new Set(["X", "p", "m", "b"]);
const TABLE_MODIFIER_ALIGNMENTS: readonly (readonly [string, TableAlignment])[] = [
  ["\\centering", "center"],
  ["\\raggedleft", "right"],
  ["\\raggedright", "left"],
];

function tableAlignments(columnSpec: string, width: number): TableAlignment[] {
  const alignments: TableAlignment[] = [];
  let pendingAlignment: TableAlignment | null = null;
  let depth = 0;
  for (let index = 0; index < columnSpec.length && alignments.length < width; index++) {
    const character = columnSpec[index]!;
    if (depth === 0 && character === ">" && columnSpec[index + 1] === "{") {
      const close = closingBrace(columnSpec, index + 1);
      if (close !== null) {
        const modifier = columnSpec.slice(index + 2, close);
        pendingAlignment =
          TABLE_MODIFIER_ALIGNMENTS.find(([command]) => modifier.indexOf(command) >= 0)?.[1] ??
          null;
        index = close;
      }
    } else if (character === "{") depth++;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "\\") index++;
    else if (depth === 0 && character === "l") {
      alignments.push(pendingAlignment ?? "left");
      pendingAlignment = null;
    } else if (depth === 0 && character === "c") {
      alignments.push(pendingAlignment ?? "center");
      pendingAlignment = null;
    } else if (depth === 0 && character === "r") {
      alignments.push(pendingAlignment ?? "right");
      pendingAlignment = null;
    } else if (depth === 0 && TABLE_PARAGRAPH_COLUMNS.has(character)) {
      alignments.push(pendingAlignment ?? "left");
      pendingAlignment = null;
    }
  }
  return Array.from({ length: width }, (_, index) => alignments[index] ?? "left");
}

/** Live caption edits take precedence over the preserved source snapshot. */
export function latexVisualFloatHasCaption(node: JSONContent) {
  return (
    node.attrs?.captionRemoved !== true &&
    (String(node.attrs?.caption ?? "") !== "" ||
      /\\caption\b/u.test(latexWithoutComments(String(node.attrs?.raw ?? ""))))
  );
}

/** Read presentation from the preserved table source; never serialize it as edits. */
export function latexVisualTablePresentation(source: string) {
  const body = tabularBody(source);
  const prefix = body ? source.slice(0, body.openingFrom) : "";
  const size =
    [...prefix.matchAll(/\\(tiny|scriptsize|footnotesize|small|normalsize)\b/gu)].at(-1)?.[1] ??
    "normalsize";
  const columnWidths: (number | null)[] = [];
  const columnKinds: ("natural" | "fixed" | "flexible")[] = [];
  const spec = body?.columnSpec ?? "";
  for (let index = 0; index < spec.length; index++) {
    const character = spec[index]!;
    // Skip modifier groups so the letters of \\raggedright are not columns.
    if (character === "{") {
      const close = closingBrace(spec, index);
      if (close === null) break;
      index = close;
    } else if (character === "\\") index++;
    else if ("pmb".includes(character)) {
      const argument = requiredArgument(spec, index + 1);
      columnWidths.push(argument ? latexLengthInches(argument.source) : null);
      columnKinds.push("fixed");
      if (argument) index = argument.next - 1;
    } else if ("lcrX".includes(character)) {
      columnWidths.push(null);
      columnKinds.push(character === "X" ? "flexible" : "natural");
    }
  }
  const caption = commandArgumentRange(source, "caption");
  const relativeWidth =
    /^((?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(?:textwidth|linewidth|columnwidth)$/u.exec(
      body?.width?.trim() ?? "",
    );
  const absoluteWidth = body?.width ? latexLengthInches(body.width) : null;
  return {
    size,
    columnWidths,
    columnKinds,
    captionAfter: caption !== null && body !== null && caption.from > body.to,
    hasCaption: caption !== null,
    hasFloat: /\\begin\{table\*?\}/u.test(source),
    width: relativeWidth
      ? `${Number(relativeWidth[1] || "1") * 100}%`
      : absoluteWidth !== null
        ? `${absoluteWidth}in`
        : undefined,
    trimLeft: /^\s*@\{\}/u.test(spec),
    trimRight: /@\{\}\s*$/u.test(spec),
  };
}

/** A header rule establishes structure, not bold text. Keep cell formatting source-derived. */
export function latexVisualTableFormatting(node: JSONContent) {
  const rows = tableRows(node.attrs?.rows);
  if (!rows) return [];
  return preservedTableCells(node, rows).map((row) =>
    row.map((raw) => {
      const format = {
        bold: false,
        italic: false,
        monospace: false,
        smallCaps: false,
        underline: false,
      };
      for (let depth = 0; depth < 8; depth++) {
        const command =
          /^\s*\\(textbf|textit|emph|texttt|textsc|underline|mbox|multicolumn|multirow)\b/u.exec(
            raw,
          );
        if (!command) break;
        let value = requiredArgument(raw, command[0].length);
        if (command[1] === "multicolumn" || command[1] === "multirow") {
          value = value && requiredArgument(raw, value.next);
          value = value && requiredArgument(raw, value.next);
        }
        if (!value || raw.slice(value.next).trim()) break;
        if (command[1] === "textbf") format.bold = true;
        if (command[1] === "textit" || command[1] === "emph") format.italic = true;
        if (command[1] === "texttt") format.monospace = true;
        if (command[1] === "textsc") format.smallCaps = true;
        if (command[1] === "underline") format.underline = true;
        raw = value.source;
      }
      return format;
    }),
  );
}

interface TableSourceSlice {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

interface EditableTableCell {
  readonly display: string;
  readonly from: number;
  readonly to: number;
}

function splitTable(source: string, delimiter: "row" | "cell"): TableSourceSlice[] {
  const values: TableSourceSlice[] = [];
  let from = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "%") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (source[index] === "{") depth++;
    else if (source[index] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && delimiter === "cell" && source[index] === "&") {
      values.push({ source: source.slice(from, index), from, to: index });
      from = index + 1;
    } else if (
      depth === 0 &&
      delimiter === "row" &&
      source[index] === "\\" &&
      source[index + 1] === "\\"
    ) {
      values.push({ source: source.slice(from, index), from, to: index });
      index++;
      from = index + 1;
    } else if (source[index] === "\\") index++;
  }
  values.push({ source: source.slice(from), from, to: source.length });
  return values;
}

const TABLE_CELL_WRAPPER = /^(?:\\(?:textbf|textit|emph|texttt|textsc|underline|mbox))\s*\{/u;
const TABLE_RULE_PREFIX = /^(?:\\(?:toprule|midrule|bottomrule|hline)\b\s*)+/u;
const TABLE_RULE_SUFFIX = /(?:\s*\\(?:toprule|midrule|bottomrule|hline)\b)+\s*$/u;

function trimSourceRange(source: string, from: number, to: number): [number, number] {
  while (from < to && /\s/u.test(source[from]!)) from++;
  while (to > from && /\s/u.test(source[to - 1]!)) to--;
  return [from, to];
}

export function latexTableMathCell(source: string) {
  if (!(source.startsWith("$") || source.startsWith("\\("))) return null;
  const nodes = parseInline(source);
  if (nodes?.length !== 1 || nodes[0]?.type !== "latexInlineMath") return null;
  return {
    tex: String(nodes[0].attrs?.tex ?? ""),
    opening: source.startsWith("$") ? "$" : "\\(",
    closing: source.startsWith("$") ? "$" : "\\)",
  };
}

export function latexTableCellIsMath(
  node: Pick<JSONContent, "attrs">,
  row: number,
  column: number,
): boolean {
  const rowId = /^table-row-(\d+)$/u.exec(String(node.attrs?.rowIds?.[row]));
  const columnId = /^table-column-(\d+)$/u.exec(String(node.attrs?.columnIds?.[column]));
  const cell =
    rowId && columnId
      ? node.attrs?.sourceMeta?.originalCells?.[Number(rowId[1])]?.[Number(columnId[1])]
      : null;
  return (
    typeof cell?.raw === "string" && latexTableMathCell(cell.raw.slice(cell.from, cell.to)) !== null
  );
}

export function latexTableInlineContent(source: string): JSONContent[] | null {
  const content = parseInline(source);
  return content?.every((node) =>
    ["text", "latexInlineMath", "latexInlineCommand"].includes(node.type ?? ""),
  )
    ? content
    : null;
}

function serializeTableCellValue(value: string, _math = false): string {
  return latexTableInlineContent(value) ? value : escapeText(value);
}

function editableTableCell(
  source: string,
  offset: number,
  allowMath = false,
): EditableTableCell | null {
  let [from, to] = trimSourceRange(source, 0, source.length);
  // Retain whitespace after a rule when the first cell is empty. Trimming the
  // right edge before consuming it puts the insertion point inside the TeX
  // control word: typing "a" would turn \hline into \hlinea.
  const prefix = TABLE_RULE_PREFIX.exec(source.slice(from));
  if (prefix) {
    const start = from + prefix[0].length;
    [from, to] = trimSourceRange(source, start, Math.max(start, to));
  }
  const suffix = TABLE_RULE_SUFFIX.exec(source.slice(from, to));
  if (suffix) [from, to] = trimSourceRange(source, from, from + suffix.index);

  for (let depth = 0; depth < 8; depth++) {
    if (allowMath) break;
    const wrapper = TABLE_CELL_WRAPPER.exec(source.slice(from, to));
    if (!wrapper) break;
    const opening = from + wrapper[0].lastIndexOf("{");
    const close = closingBrace(source, opening);
    if (close === null || close !== to - 1) return null;
    [from, to] = trimSourceRange(source, opening + 1, close);
  }

  const core = source.slice(from, to);
  const display = allowMath ? (latexTableInlineContent(core) ? core : null) : metadataText(core);
  if (display === null || display.includes("\n")) return null;
  return {
    display: display.replace(/\s+/gu, " ").trim(),
    from: offset + from,
    to: offset + to,
  };
}

export interface LatexTableCellLayout {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  alignment: "left" | "center" | "right";
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
  background: string | null;
  ruleColor?: string;
  topColor?: string;
  bottomColor?: string;
}

export function latexTableSelectionBounds(
  layout: readonly (readonly (LatexTableCellLayout | null)[])[],
  firstRow: number,
  lastRow: number,
  firstColumn: number,
  lastColumn: number,
) {
  const owners = layout.flat().filter((cell): cell is LatexTableCellLayout => cell !== null);
  for (let pass = 0; pass <= owners.length; pass++) {
    let changed = false;
    for (const cell of owners) {
      const bottom = cell.row + cell.rowSpan - 1;
      const right = cell.column + cell.colSpan - 1;
      if (
        cell.row > lastRow ||
        bottom < firstRow ||
        cell.column > lastColumn ||
        right < firstColumn
      )
        continue;
      if (
        cell.row < firstRow ||
        bottom > lastRow ||
        cell.column < firstColumn ||
        right > lastColumn
      )
        changed = true;
      firstRow = Math.min(firstRow, cell.row);
      lastRow = Math.max(lastRow, bottom);
      firstColumn = Math.min(firstColumn, cell.column);
      lastColumn = Math.max(lastColumn, right);
    }
    if (!changed) break;
  }
  return { firstRow, lastRow, firstColumn, lastColumn };
}

/** Literal spans, colors and rules keep their source; only cell bodies are editable. */
function parseSpannedTable(body: NonNullable<ReturnType<typeof tabularBody>>) {
  const columns = latexTableColumns(body.columnSpec);
  if (!columns || body.columnSpec.includes("||")) return null;
  const width = columns.length;
  const slices = splitTable(body.source, "row");
  const count = slices.filter(
    (slice) =>
      slice.to < body.source.length ||
      slice.source
        .replace(
          /\\(?:hline|toprule|midrule|bottomrule)\b|\\cline\{\d+-\d+\}|\\arrayrulecolor\{[^{}]+\}/gu,
          "",
        )
        .trim(),
  ).length;
  if (!width || width > 20 || !count || count > 100) return null;
  const layout: (LatexTableCellLayout | null)[][] = Array.from({ length: count }, () =>
    Array.from({ length: width }, () => null),
  );
  const rows = Array.from({ length: count }, () => Array.from({ length: width }, () => ""));
  const ranges: ({ from: number; to: number; original: string } | null)[][] = rows.map((row) =>
    row.map(() => null),
  );
  const sources: ({ raw: string; display: string; from: number; to: number } | null)[][] = rows.map(
    (row) => row.map(() => null),
  );
  const rules = Array.from({ length: count + 1 }, () => Array.from({ length: width }, () => false));
  const colors: (string | null)[] = Array.from({ length: count }, () => null);
  let ruleColor = "currentColor";
  const ruleColors = Array.from({ length: count + 1 }, () => ruleColor);
  for (const [rowIndex, slice] of slices.entries()) {
    let prefix = 0;
    while (true) {
      const whitespace = /^\s*/u.exec(slice.source.slice(prefix))![0];
      prefix += whitespace.length;
      const command = /^\\(hline|toprule|midrule|bottomrule|cline|rowcolor|arrayrulecolor)\b/u.exec(
        slice.source.slice(prefix),
      );
      if (!command) break;
      if (rowIndex > count) return null;
      prefix += command[0].length;
      if (["hline", "toprule", "midrule", "bottomrule"].includes(command[1]!))
        rules[rowIndex]!.fill(true);
      else {
        const argument = requiredArgument(slice.source, prefix);
        if (!argument) return null;
        prefix = argument.next;
        if (command[1] === "cline") {
          const range = /^(\d+)-(\d+)$/u.exec(argument.source.trim());
          if (
            !range ||
            Number(range[1]) < 1 ||
            Number(range[2]) > width ||
            Number(range[1]) > Number(range[2])
          )
            return null;
          for (let column = Number(range[1]) - 1; column < Number(range[2]); column++)
            rules[rowIndex]![column] = true;
        } else if (command[1] === "arrayrulecolor") {
          const color = latexColorCss(argument.source);
          if (!color) return null;
          ruleColor = color;
        } else {
          const color = latexColorCss(argument.source);
          if (!color || rowIndex === count || colors[rowIndex]) return null;
          colors[rowIndex] = color;
        }
      }
    }
    ruleColors[rowIndex] = ruleColor;
    if (rowIndex === count) {
      if (slice.source.slice(prefix).trim()) return null;
      continue;
    }
    let column = 0;
    for (const cell of splitTable(slice.source.slice(prefix), "cell")) {
      if (column >= width) return null;
      const raw = cell.source.trim();
      const rawOffset = prefix + cell.from + cell.source.indexOf(raw);
      const occupied = layout[rowIndex]![column];
      if (occupied) {
        if (raw || occupied.row === rowIndex) return null;
        column++;
        continue;
      }
      let from = 0;
      let to = raw.length;
      let colSpan = 1;
      let rowSpan = 1;
      let alignment =
        columns[column]!.alignment === "center"
          ? "c"
          : columns[column]!.alignment === "right"
            ? "r"
            : "l";
      let left = columns[column]!.left;
      let right = columns[column]!.right;
      if (/^\\multicolumn\b/u.test(raw)) {
        const span = requiredArgument(raw, "\\multicolumn".length);
        const format = span && requiredArgument(raw, span.next);
        const content = format && requiredArgument(raw, format.next);
        if (
          !span ||
          !format ||
          !content ||
          raw.slice(content.next).trim() ||
          !/^\d+$/u.test(span.source) ||
          !/^\|?[lcr]\|?$/u.test(format.source)
        )
          return null;
        colSpan = Number(span.source);
        alignment = format.source.replace(/\|/gu, "");
        left = format.source.startsWith("|");
        right = format.source.endsWith("|");
        from = content.from;
        to = content.to;
      }
      const content = raw.slice(from, to);
      if (/^\s*\\multirow\b/u.test(content)) {
        const command = /^\s*\\multirow\b/u.exec(content)!;
        const span = requiredArgument(raw, from + command[0].length);
        const size = span && requiredArgument(raw, span.next);
        const value = size && requiredArgument(raw, size.next);
        if (
          !span ||
          !size ||
          !value ||
          raw.slice(value.next, to).trim() ||
          !/^\d+$/u.test(span.source) ||
          size.source !== "*"
        )
          return null;
        rowSpan = Number(span.source);
        from = value.from;
        to = value.to;
      }
      if (colSpan < 1 || column + colSpan > width || rowSpan < 1 || rowIndex + rowSpan > count)
        return null;
      let background =
        colors[rowIndex] ??
        (columns[column]!.background ? latexColorCss(columns[column]!.background) : null);
      const cellColor = /^\s*\\cellcolor\b/u.exec(raw.slice(from, to));
      if (cellColor) {
        const color = requiredArgument(raw, from + cellColor[0].length);
        if (!color || !latexColorCss(color.source)) return null;
        background = latexColorCss(color.source);
        from = color.next;
      }
      const editable = editableTableCell(raw.slice(from, to), from, true);
      if (!editable) return null;
      const geometry: LatexTableCellLayout = {
        row: rowIndex,
        column,
        rowSpan,
        colSpan,
        alignment: alignment === "c" ? "center" : alignment === "r" ? "right" : "left",
        top: false,
        bottom: false,
        left,
        right,
        background,
        ruleColor,
      };
      for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
        for (let c = column; c < column + colSpan; c++) {
          if (layout[r]![c]) return null;
          layout[r]![c] = geometry;
        }
      }
      rows[rowIndex]![column] = editable.display;
      const offset = body.from + slice.from + rawOffset;
      ranges[rowIndex]![column] = {
        from: offset + editable.from,
        to: offset + editable.to,
        original: editable.display,
      };
      sources[rowIndex]![column] = { raw, ...editable };
      column += colSpan;
    }
    if (column !== width) return null;
  }
  for (const [rowIndex, row] of layout.entries()) {
    for (const [column, cell] of row.entries()) {
      if (!cell) return null;
      if (cell.row !== rowIndex || cell.column !== column) continue;
      const top = rules[rowIndex]!.slice(column, column + cell.colSpan);
      const bottom = rules[rowIndex + cell.rowSpan]!.slice(column, column + cell.colSpan);
      if (
        (top.some(Boolean) && !top.every(Boolean)) ||
        (bottom.some(Boolean) && !bottom.every(Boolean))
      )
        return null;
      for (let r = rowIndex + 1; r < rowIndex + cell.rowSpan; r++)
        if (
          rules[r]!.slice(column, column + cell.colSpan).some(Boolean) ||
          colors[r] !== colors[rowIndex]
        )
          return null;
      cell.top = top.every(Boolean);
      cell.bottom = bottom.every(Boolean);
      cell.topColor = ruleColors[rowIndex]!;
      cell.bottomColor = ruleColors[rowIndex + cell.rowSpan]!;
    }
  }
  return {
    layout,
    parsedRows: rows.map((row, index) => ({
      rows: row,
      ranges: ranges[index]!,
      sources: sources[index]!,
      end: body.from + slices[index]!.to + 2,
      terminated: true,
    })),
  };
}

function parseLongTablePreview(
  source: string,
  body: TabularBody,
  setup: LatexVisualSetup,
): JSONContent | null {
  const originalParts = longTableSections(source, body.from, body.to);
  if (!originalParts) return null;
  const expanded = expandLongTableRows(source, originalParts.bodyFrom, body.to, setup.math.macros);
  if (!expanded) return null;
  const virtualBody = tabularBody(expanded.virtual);
  if (!virtualBody) return null;
  const parts = longTableSections(expanded.virtual, virtualBody.from, virtualBody.to);
  if (!parts) return null;
  const visible = longTableVisibleBody(expanded.virtual, virtualBody.from, virtualBody.to, parts);
  if (visible === null) return null;
  const table = parseTablePreview(expanded.virtual, setup, { ...virtualBody, source: visible });
  if (!table?.attrs?.editable) return null;
  const band = (key: string) => {
    const range = parts.sections.get(key);
    if (!range) return { rows: [], layout: [], rule: false, sizes: [] };
    const raw = expanded.virtual.slice(range.from, range.to);
    const sizes = splitTable(raw, "row").map(
      (row) =>
        /\\(tiny|scriptsize|footnotesize|small|normalsize)\b/u.exec(row.source)?.[1] ??
        "normalsize",
    );
    const rendered = raw
      .replace(/\\thetable\s*(?:\{\})?/gu, "SCIENTTABLENUMBER")
      .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize)\b\s*/gu, "");
    if (
      !splitTable(rendered.replace(/\\arrayrulecolor\{[^{}]+\}/gu, ""), "row").some((row) =>
        row.source.replace(TABLE_RULE_PREFIX, "").replace(TABLE_RULE_SUFFIX, "").trim(),
      )
    )
      return {
        rows: [],
        layout: [],
        rule: /\\(?:toprule|midrule|bottomrule|hline)\b/u.test(raw),
        sizes,
      };
    const preview = parseTablePreview(
      `\\begin{tabular}{${body.columnSpec}}${rendered}\\end{tabular}`,
      setup,
    );
    if (!preview?.attrs?.editable) return null;
    return {
      rows: preview.attrs.rows,
      layout: preview.attrs.sourceMeta?.tableLayout ?? [],
      rule: /\\(?:toprule|midrule|bottomrule|hline)\b/u.test(raw),
      sizes,
    };
  };
  const head = band("head"),
    foot = band("foot"),
    lastFoot = band(parts.sections.has("lastfoot") ? "lastfoot" : "foot");
  if (!head || !foot || !lastFoot) return null;
  table.attrs.raw = source;
  table.attrs.sourceMeta = {
    ...table.attrs.sourceMeta,
    preserveStructure: true,
    longtable: {
      virtualRaw: expanded.virtual,
      expansions: expanded.expansions,
      head,
      foot,
      lastFoot,
      originalAttributes: Object.fromEntries(
        ["rowIds", "columnIds", "columnAlignments", "tableStyle", "tableKind", "hasHeader"].map(
          (key) => [key, table.attrs![key]],
        ),
      ),
    },
  };
  return table;
}

function parseTablePreview(
  source: string,
  setup = visualSetup(source),
  preparedBody?: TabularBody,
): JSONContent | null {
  if (!/\\begin\{(?:table\*?|tabularx|tabular|tabulary|longtable)\}/u.test(source)) return null;
  const body = preparedBody ?? tabularBody(source);
  if (body === null || body.source.length > 100_000) return null;
  if (body.environment === "longtable" && !preparedBody)
    return parseLongTablePreview(source, body, setup);
  const needsSpans =
    /\\(?:multicolumn|multirow|rowcolor|cellcolor|cline|arrayrulecolor)\b/u.test(body.source) ||
    /\\columncolor\b/u.test(body.columnSpec);
  const spanned = needsSpans ? parseSpannedTable(body) : null;
  if (needsSpans && !spanned) return null;
  const parsedRows =
    spanned?.parsedRows ??
    splitTable(body.source, "row")
      .map((row) => {
        const cells = splitTable(row.source, "cell");
        const editableCells = cells.map((cell) =>
          editableTableCell(cell.source, body.from + row.from + cell.from, true),
        );
        return {
          rows: cells.map(
            (cell, index) => editableCells[index]?.display ?? exactMetadataSource(cell.source),
          ),
          sources: cells.map((cell) => {
            const clean = cell.source
              .trim()
              .replace(TABLE_RULE_PREFIX, "")
              .replace(TABLE_RULE_SUFFIX, "")
              .trim();
            const core = editableTableCell(clean, 0, true);
            return core ? { raw: clean, ...core } : null;
          }),
          ranges: editableCells.map((cell) =>
            cell ? { from: cell.from, to: cell.to, original: cell.display } : null,
          ),
          end: body.from + row.to + (row.to < body.source.length ? 2 : 0),
          terminated: row.to < body.source.length,
        };
      })
      .filter((row) => row.terminated || row.rows.some(Boolean));
  const rows = parsedRows.slice(0, 100).map((row) => row.rows);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0 || width > 20) return null;
  const editable =
    parsedRows.length <= 100 &&
    rows.every((row) => row.length === width) &&
    (spanned !== null || parsedRows.every((row) => row.ranges.every((cell) => cell !== null)));
  const captionArgument = commandArgumentRange(source, "caption");
  const captionCell = captionArgument
    ? editableTableCell(captionArgument.source, captionArgument.from)
    : null;
  const labelArgument = commandArgumentRange(source, "label");
  const labelCell =
    labelArgument && safeLatexLabel(labelArgument.source) !== null
      ? { display: labelArgument.source, from: labelArgument.from, to: labelArgument.to }
      : null;
  const hasFloat = /\\begin\{table\*?\}/u.test(source);
  const hasHeader =
    /\\midrule\b/u.test(body.source) ||
    Boolean(
      rows[0]?.length &&
      rows[0].every((cell) => {
        const content = latexTableInlineContent(cell);
        return (
          content?.length &&
          content.every(
            (part) => part.type === "text" && part.marks?.some((mark) => mark.type === "bold"),
          )
        );
      }),
    );
  const tableStyle = /\\(?:toprule|midrule|bottomrule)\b/u.test(body.source)
    ? "booktabs"
    : /\\hline\b/u.test(body.source) || body.columnSpec.includes("|")
      ? "grid"
      : "plain";
  const tableKind =
    body.environment === "tabularx" || body.environment === "tabulary"
      ? "stretch"
      : body.environment === "longtable"
        ? "long"
        : "fixed";
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "table",
      raw: source,
      caption:
        captionCell?.display ?? exactMetadataSource(commandArgument(source, "caption") ?? ""),
      label: labelCell?.display ?? exactMetadataSource(commandArgument(source, "label") ?? ""),
      rows,
      cellRanges: editable ? parsedRows.map((row) => row.ranges) : null,
      rowIds: rows.map((_, index) => `table-row-${index}`),
      columnIds: Array.from({ length: width }, (_, index) => `table-column-${index}`),
      columnAlignments: tableAlignments(body.columnSpec, width),
      tableStyle,
      tableKind,
      hasHeader,
      tableCanonical: false,
      sourceMeta: editable
        ? {
            preserveStructure: spanned !== null,
            tableLayout: spanned?.layout ?? null,
            originalCells: parsedRows.map((row) => row.sources),
            originalHasHeader: hasHeader,
            captionRange: captionCell
              ? { from: captionCell.from, to: captionCell.to, original: captionCell.display }
              : null,
            insertAt: parsedRows.at(-1)!.end,
            originalRowCount: rows.length,
            bodyFrom: body.from,
            bodyTo: body.to,
            openingFrom: body.openingFrom,
            openingTo: body.openingTo,
            endingFrom: body.endingFrom,
            endingTo: body.endingTo,
            hasFloat,
            outerInsertAt: body.openingFrom,
            labelRange: labelCell
              ? { from: labelCell.from, to: labelCell.to, original: labelCell.display }
              : null,
          }
        : null,
      editable,
      items: null,
    },
  };
}

const SCIENTIFIC_ENVIRONMENTS = new Set([
  "abstract",
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "claim",
  "definition",
  "example",
  "remark",
  "remarks",
  "proof",
]);

interface OptionalArgumentRange {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly end: number;
}

function optionalArgumentRange(source: string, cursor: number): OptionalArgumentRange | null {
  const value = latexSourceArgument(source, cursor, "[", "]");
  return value ? { source: value.value, from: value.from, to: value.to, end: value.end } : null;
}

function commandFullRange(
  source: string,
  command: string,
): { source: string; from: number; to: number; argument: OptionalArgumentRange } | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  if (close === null) return null;
  return {
    source: source.slice(match.index, close + 1),
    from: match.index,
    to: close + 1,
    argument: {
      source: source.slice(opening + 1, close),
      from: opening + 1,
      to: close,
      end: close + 1,
    },
  };
}

function parseScientificEnvironment(source: string): JSONContent | null {
  const opening = /^\\begin\{([A-Za-z*]+)\}/u.exec(source);
  const environment = opening?.[1] ?? "";
  if (!opening || !SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  const titleRange = optionalArgumentRange(source, opening[0].length);
  const openingTo = titleRange?.end ?? opening[0].length;
  const endingSource = `\\end{${environment}}`;
  const endingFrom = source.lastIndexOf(endingSource);
  if (endingFrom < openingTo) return null;
  const interior = source.slice(openingTo, endingFrom);
  const labelCommand = commandFullRange(interior, "label");
  const bodySource = labelCommand
    ? interior.slice(0, labelCommand.from) +
      " ".repeat(labelCommand.to - labelCommand.from) +
      interior.slice(labelCommand.to)
    : interior;
  const body = editableTableCell(bodySource, openingTo);
  const title = titleRange ? editableTableCell(titleRange.source, titleRange.from) : null;
  const label = labelCommand
    ? editableTableCell(labelCommand.argument.source, openingTo + labelCommand.argument.from)
    : null;
  const editable =
    body !== null &&
    (titleRange === null || title !== null) &&
    (labelCommand === null || label !== null) &&
    !(
      body &&
      labelCommand &&
      body.from < openingTo + labelCommand.to &&
      body.to > openingTo + labelCommand.from
    ) &&
    !/\\[A-Za-z]+/u.test(
      bodySource.replace(/\\(?:textbackslash|textasciitilde|textasciicircum)\{\}/gu, ""),
    );
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "scientific",
      raw: source,
      environment,
      title: title?.display ?? exactMetadataSource(titleRange?.source ?? ""),
      body: body?.display ?? exactMetadataSource(bodySource),
      label: label?.display ?? exactMetadataSource(labelCommand?.argument.source ?? ""),
      editable,
      sourceMeta: editable
        ? {
            originalEnvironment: environment,
            openingTo,
            endingFrom,
            titleRange: title ? { from: title.from, to: title.to, original: title.display } : null,
            bodyRange: body ? { from: body.from, to: body.to, original: body.display } : null,
            labelCommandRange: labelCommand
              ? {
                  from: openingTo + labelCommand.from,
                  to: openingTo + labelCommand.to,
                  argumentFrom: openingTo + labelCommand.argument.from,
                  argumentTo: openingTo + labelCommand.argument.to,
                  original: label?.display ?? "",
                }
              : null,
          }
        : null,
    },
  };
}

function graphicsWidth(options: string): string {
  return (
    options
      .split(",")
      .map((option) => option.trim())
      .find((option) => option.startsWith("width="))
      ?.slice("width=".length) ?? ""
  );
}

export interface LatexFigureArtwork {
  tikz?: boolean;
  frame: boolean;
  width: string | null;
  height: string | null;
  vertical: "center" | "bottom";
  angle: number;
  path: string | null;
  textRange: { from: number; to: number; original: string };
}

export interface LatexFigurePanel extends LatexFigureArtwork {
  panelWidth: string | null;
  subfigure: boolean;
  captionRange: { from: number; to: number; original: string } | null;
  labelRange: { from: number; to: number; original: string } | null;
}

function figureLength(source: string): string | null {
  const relative = /^((?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(?:linewidth|textwidth|columnwidth)$/u.exec(
    source.trim(),
  );
  if (relative) {
    const factor = Number(relative[1] || "1");
    return factor > 0 && factor <= 1 ? `${factor * 100}%` : null;
  }
  const inches = latexLengthInches(source);
  return inches !== null && inches > 0 && inches <= 30 ? `${inches}in` : null;
}

function parseFigureArtwork(
  source: string,
  from: number,
  to: number,
  setup: LatexVisualSetup,
  depth = 0,
  parameter = false,
): LatexFigureArtwork | null {
  if (depth > 8) return null;
  [from, to] = trimSourceRange(source, from, to);
  const raw = source.slice(from, to);
  if (isLatexTikz(raw))
    return {
      tikz: true,
      frame: false,
      width: null,
      height: null,
      vertical: "center",
      angle: 0,
      path: null,
      textRange: { from, to, original: raw },
    };
  const command = /^\\([A-Za-z]+)\b/u.exec(raw);
  if (command?.[1] === "rotatebox") {
    const angle = requiredArgument(source, from + command[0].length);
    const body = angle && requiredArgument(source, angle.next);
    if (
      !angle ||
      !body ||
      body.next > to ||
      source.slice(body.next, to).trim() ||
      !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(angle.source)
    )
      return null;
    const value = Number(angle.source);
    if (Math.abs(value) > 360) return null;
    const artwork = parseFigureArtwork(source, body.from, body.to, setup, depth + 1, parameter);
    return artwork ? { ...artwork, angle: artwork.angle + value } : null;
  }
  if (command?.[1] === "fbox") {
    const body = requiredArgument(source, from + command[0].length);
    if (!body || body.next > to || source.slice(body.next, to).trim()) return null;
    const artwork = parseFigureArtwork(source, body.from, body.to, setup, depth + 1, parameter);
    return artwork && !artwork.frame ? { ...artwork, frame: true } : null;
  }
  if (command?.[1] === "parbox") {
    const position = optionalArgumentRange(source, from + command[0].length);
    const height = position && optionalArgumentRange(source, position.end);
    const innerPosition = height && optionalArgumentRange(source, height.end);
    const width = innerPosition && requiredArgument(source, innerPosition.end);
    const body = width && requiredArgument(source, width.next);
    if (
      !position ||
      !height ||
      !innerPosition ||
      !width ||
      !body ||
      body.next > to ||
      position.source !== "c" ||
      innerPosition.source !== "c" ||
      source.slice(body.next, to).trim()
    )
      return null;
    const cssWidth = figureLength(width.source);
    const cssHeight = figureLength(height.source);
    if (!cssWidth || !cssHeight || cssHeight.endsWith("%")) return null;
    const centering = /^\s*\\centering\b\s*/u.exec(body.source);
    if (!centering) return null;
    const artwork = parseFigureArtwork(
      source,
      body.from + centering[0].length,
      body.to,
      setup,
      depth + 1,
      parameter,
    );
    return artwork ? { ...artwork, width: cssWidth, height: cssHeight, vertical: "center" } : null;
  }
  if (command?.[1] === "includegraphics") {
    const option = optionalArgumentRange(source, from + command[0].length);
    const path = requiredArgument(source, option?.end ?? from + command[0].length);
    const width = option ? /^\s*width\s*=\s*(.+)\s*$/u.exec(option.source)?.[1] : null;
    if (
      !path ||
      path.next > to ||
      source.slice(path.next, to).trim() ||
      (option && (!width || !figureLength(width)))
    )
      return null;
    const value = editableTableCell(path.source, path.from);
    if (!value) return null;
    return {
      frame: false,
      width: width ? figureLength(width) : null,
      height: null,
      vertical: "center",
      angle: 0,
      path: value.display,
      textRange: { from: value.from, to: value.to, original: value.display },
    };
  }
  if (command && Object.hasOwn(setup.math.macros, command[1]!)) {
    const macro = setup.math.macros[command[1]!]!;
    const argument = requiredArgument(source, from + command[0].length);
    if (
      parameter ||
      macro.args !== 1 ||
      !argument ||
      argument.next > to ||
      source.slice(argument.next, to).trim()
    )
      return null;
    const template = parseFigureArtwork(macro.def, 0, macro.def.length, setup, depth + 1, true);
    const body = editableTableCell(argument.source, argument.from);
    if (!template || template.textRange.original !== "#1" || template.path !== null || !body)
      return null;
    return { ...template, textRange: { from: body.from, to: body.to, original: body.display } };
  }
  let height: string | null = null;
  const rule = /^\\rule\s*\{\s*0(?:\.0+)?(?:pt|mm|cm|in)\s*\}\s*\{([^{}]+)\}\s*/u.exec(raw);
  if (rule) {
    height = figureLength(rule[1]!);
    if (!height || height.endsWith("%")) return null;
    from += rule[0].length;
    const ending = /\s*\\rule\s*\{\s*0(?:\.0+)?(?:pt|mm|cm|in)\s*\}\s*\{([^{}]+)\}\s*$/u.exec(
      source.slice(from, to),
    );
    if (ending) {
      if (figureLength(ending[1]!) !== height) return null;
      to = from + ending.index;
    }
  }
  const body =
    parameter && source.slice(from, to).trim() === "#1"
      ? { display: "#1", from, to }
      : editableTableCell(source.slice(from, to), from);
  if (!body) return null;
  return {
    frame: false,
    width: null,
    height,
    vertical: height ? "bottom" : "center",
    angle: 0,
    path: null,
    textRange: { from: body.from, to: body.to, original: body.display },
  };
}

/** Boxes and panels are a bounded source projection, never arbitrary TeX execution. */
function parseFigureLayout(source: string, setup: LatexVisualSetup): JSONContent | null {
  const opening = /^\\begin\{(figure\*?)\}(?:\[[^\]]*\])?/u.exec(source);
  if (!opening || source.length > 100_000) return null;
  const ending = `\\end{${opening[1]}}`;
  const end = source.lastIndexOf(ending);
  if (end < opening[0].length || source.slice(end + ending.length).trim()) return null;
  const panels: LatexFigurePanel[] = [];
  let spreadPanels = false;
  const items: { body: string; path: string; caption: string; label: string }[] = [];
  const outer: {
    captionRange: LatexFigurePanel["captionRange"];
    labelRange: LatexFigurePanel["labelRange"];
  } = { captionRange: null, labelRange: null };
  const parsePanel = (from: number, to: number, panelWidth: string | null, subfigure: boolean) => {
    let cursor = from;
    const centered = /^\s*\\centering\b\s*/u.exec(source.slice(cursor, to));
    if (centered) cursor += centered[0].length;
    const pictureEnd = latexTikzEnd(source.slice(cursor, to));
    const tailStart = pictureEnd === null ? cursor : cursor + pictureEnd;
    const captionAt = source.slice(tailStart, to).search(/\\caption\b/u);
    const labelAt = source.slice(tailStart, to).search(/\\label\b/u);
    const contentTo = Math.min(
      to,
      captionAt < 0 ? to : tailStart + captionAt,
      labelAt < 0 ? to : tailStart + labelAt,
    );
    const artwork = parseFigureArtwork(source, cursor, contentTo, setup);
    if (!artwork) return false;
    let caption: LatexFigurePanel["captionRange"] = null;
    let label: LatexFigurePanel["labelRange"] = null;
    cursor = contentTo;
    while (cursor < to) {
      cursor += /^\s*/u.exec(source.slice(cursor, to))![0].length;
      if (cursor === to) break;
      const command = /^\\(caption|label)\b/u.exec(source.slice(cursor, to));
      const argument = command && requiredArgument(source, cursor + command[0].length);
      if (!command || !argument || argument.next > to) return false;
      const value = editableTableCell(argument.source, argument.from);
      if (!value || (command[1] === "label" && safeLatexLabel(value.display) === null))
        return false;
      const range = { from: value.from, to: value.to, original: value.display };
      if (command[1] === "caption") {
        if (caption) return false;
        caption = range;
      } else {
        if (label) return false;
        label = range;
      }
      cursor = argument.next;
    }
    panels.push({
      ...artwork,
      panelWidth,
      subfigure,
      captionRange: subfigure ? caption : null,
      labelRange: subfigure ? label : null,
    });
    items.push({
      body: artwork.path === null ? artwork.textRange.original : "",
      path: artwork.path ?? "",
      caption: subfigure ? (caption?.original ?? "") : "",
      label: subfigure ? (label?.original ?? "") : "",
    });
    if (!subfigure) {
      outer.captionRange = caption;
      outer.labelRange = label;
    }
    return true;
  };
  let cursor = opening[0].length;
  cursor += /^\s*(?:\\centering\b\s*)?/u.exec(source.slice(cursor, end))![0].length;
  if (source.startsWith("\\begin{subfigure}", cursor)) {
    while (source.startsWith("\\begin{subfigure}", cursor)) {
      if (panels.length >= 26) return null;
      const width = requiredArgument(source, cursor + "\\begin{subfigure}".length);
      const closing = source.indexOf("\\end{subfigure}", width?.next ?? cursor);
      const cssWidth = width && figureLength(width.source);
      if (
        !width ||
        !cssWidth ||
        closing < width.next ||
        !parsePanel(width.next, closing, cssWidth, true)
      )
        return null;
      cursor = closing + "\\end{subfigure}".length;
      const separator = /^\s*(?:\\hfill\b\s*)?/u.exec(source.slice(cursor, end))![0];
      spreadPanels ||= separator.includes("\\hfill");
      cursor += separator.length;
    }
    const tail = source.slice(cursor, end);
    const caption = commandFullRange(tail, "caption");
    const label = commandFullRange(tail, "label");
    let residual = tail;
    for (const range of [caption, label]
      .filter((range) => range !== null)
      .sort((a, b) => b.from - a.from))
      residual = residual.slice(0, range.from) + residual.slice(range.to);
    if (residual.trim()) return null;
    for (const [name, range] of [
      ["caption", caption],
      ["label", label],
    ] as const) {
      if (!range) continue;
      const cell = editableTableCell(range.argument.source, cursor + range.argument.from);
      if (!cell || (name === "label" && safeLatexLabel(cell.display) === null)) return null;
      const value = { from: cell.from, to: cell.to, original: cell.display };
      if (name === "caption") outer.captionRange = value;
      else outer.labelRange = value;
    }
  } else {
    if (!parsePanel(cursor, end, null, false)) return null;
    // Ordinary image figures retain their existing path/width/placement controls.
    if (panels[0]!.path !== null && !panels[0]!.frame && panels[0]!.angle === 0) return null;
  }
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "figureLayout",
      raw: source,
      items,
      caption: outer.captionRange?.original ?? "",
      label: outer.labelRange?.original ?? "",
      editable: true,
      sourceMeta: { panels, spreadPanels, ...outer },
    },
  };
}

function serializeFigureLayout(node: JSONContent): string | null {
  const raw = String(node.attrs?.raw ?? "");
  const meta = node.attrs?.sourceMeta as
    | {
        panels: LatexFigurePanel[];
        captionRange: LatexFigurePanel["captionRange"];
        labelRange: LatexFigurePanel["labelRange"];
      }
    | undefined;
  const items = node.attrs?.items as
    | { body: string; path: string; caption: string; label: string }[]
    | undefined;
  if (
    !meta ||
    !Array.isArray(meta.panels) ||
    !Array.isArray(items) ||
    items.length !== meta.panels.length
  )
    return null;
  const patches: { from: number; to: number; value: string }[] = [];
  const patch = (range: LatexFigurePanel["captionRange"], value: unknown, label = false) => {
    if (typeof value !== "string" || (label && safeLatexLabel(value) === null)) return false;
    if (!range) return value === "";
    if (range.from < 0 || range.to < range.from || range.to > raw.length) return false;
    if (value !== range.original)
      patches.push({ from: range.from, to: range.to, value: label ? value : escapeText(value) });
    return true;
  };
  for (const [index, panel] of meta.panels.entries()) {
    const item = items[index]!;
    if (panel.tikz) {
      if (!item || item.body !== panel.textRange.original) return null;
      if (!patch(panel.captionRange, item.caption) || !patch(panel.labelRange, item.label, true))
        return null;
      continue;
    }
    if (
      !item ||
      !patch(panel.textRange, panel.path === null ? item.body : item.path) ||
      !patch(panel.captionRange, item.caption) ||
      !patch(panel.labelRange, item.label, true)
    )
      return null;
  }
  if (
    !patch(meta.captionRange, node.attrs?.caption) ||
    !patch(meta.labelRange, node.attrs?.label, true)
  )
    return null;
  let result = raw;
  let boundary = raw.length;
  for (const patch of patches.sort((a, b) => b.from - a.from)) {
    if (patch.to > boundary) return null;
    result = result.slice(0, patch.from) + patch.value + result.slice(patch.to);
    boundary = patch.from;
  }
  return result;
}

function parseFigurePreview(source: string): JSONContent | null {
  const opening = /^\\begin\{(figure\*?)\}(?:\[([^\]]*)\])?/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  const endingSource = `\\end{${environment}}`;
  const endingFrom = source.lastIndexOf(endingSource);
  if (endingFrom < opening[0].length) return null;
  const include = /\\includegraphics(?:\[([^\]]*)\])?\s*\{/u.exec(source);
  if (!include || source.slice(include.index + include[0].length).includes("\\includegraphics"))
    return null;
  const pathOpening = include.index + include[0].lastIndexOf("{");
  const pathClose = closingBrace(source, pathOpening);
  if (pathClose === null || pathClose > endingFrom) return null;
  const path = editableTableCell(source.slice(pathOpening + 1, pathClose), pathOpening + 1);
  const captionRange = commandArgumentRange(source, "caption");
  const labelRange = commandArgumentRange(source, "label");
  const caption = captionRange ? editableTableCell(captionRange.source, captionRange.from) : null;
  const label = labelRange ? editableTableCell(labelRange.source, labelRange.from) : null;
  const options = include[1] ?? "";
  const captionCommand = commandFullRange(source, "caption");
  const labelCommand = commandFullRange(source, "label");
  const known = [
    { from: 0, to: opening[0].length },
    { from: include.index, to: pathClose + 1 },
    ...(captionCommand ? [{ from: captionCommand.from, to: captionCommand.to }] : []),
    ...(labelCommand ? [{ from: labelCommand.from, to: labelCommand.to }] : []),
    { from: endingFrom, to: endingFrom + endingSource.length },
  ].sort((left, right) => right.from - left.from);
  let residual = source;
  for (const range of known) residual = residual.slice(0, range.from) + residual.slice(range.to);
  residual = residual.replace(/\\(?:centering|raggedleft|raggedright)\b/gu, "").trim();
  const editable =
    path !== null &&
    (captionRange === null || caption !== null) &&
    (labelRange === null || label !== null) &&
    residual === "";
  const alignment = /\\raggedleft\b/u.test(source)
    ? "right"
    : /\\raggedright\b/u.test(source)
      ? "left"
      : "center";
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "figure",
      raw: source,
      path: path?.display ?? exactMetadataSource(source.slice(pathOpening + 1, pathClose)),
      caption: caption?.display ?? exactMetadataSource(captionRange?.source ?? ""),
      label: label?.display ?? exactMetadataSource(labelRange?.source ?? ""),
      figureWidth: graphicsWidth(options),
      figureOptions: options,
      figurePlacement: opening[2] ?? "",
      figureAlignment: alignment,
      figureCaptionPosition: captionRange && captionRange.from < include.index ? "above" : "below",
      figureStarred: environment.endsWith("*"),
      editable,
      sourceMeta: editable
        ? {
            pathRange: { from: path!.from, to: path!.to, original: path!.display },
            captionRange: caption
              ? { from: caption.from, to: caption.to, original: caption.display }
              : null,
            labelRange: label ? { from: label.from, to: label.to, original: label.display } : null,
            includeFrom: include.index,
            includeTo: pathClose + 1,
            outerInsertAt: include.index,
            originalOptions: options,
            originalPlacement: opening[2] ?? "",
            openingFrom: 0,
            openingTo: opening[0].length,
          }
        : null,
    },
  };
}

export function latexVisualScientificSource(environment: string): string | null {
  if (!SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  return `\\begin{${environment}}\n\n\\end{${environment}}`;
}

export function latexVisualFigureSource(): string {
  return [
    "\\begin{figure}[htbp]",
    "\\centering",
    "\\includegraphics[width=0.8\\textwidth]{figures/image.png}",
    "\\end{figure}",
  ].join("\n");
}

function parseRichPreview(
  source: string,
  documentSource: string,
  setup = visualSetup(documentSource),
): JSONContent | null {
  return (
    parseDocumentFrontMatter(source, documentSource) ??
    parsePartPreview(source) ??
    parseSimpleLayout(source, setup.math.packages.preamble) ??
    parseBibliographyPreview(source) ??
    parseDescriptionPreview(source) ??
    parseTablePreview(source, setup) ??
    parseTikzPreview(source, setup) ??
    parseFigureLayout(source, setup) ??
    parseFigurePreview(source) ??
    parseScientificEnvironment(source)
  );
}

function parseTikzPreview(source: string, setup: LatexVisualSetup): JSONContent | null {
  if (!isLatexTikz(source)) return null;
  const artwork = parseFigureArtwork(source, 0, source.length, setup);
  if (!artwork) return null;
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "figureLayout",
      raw: source,
      items: [{ body: artwork.textRange.original, path: "", caption: "", label: "" }],
      caption: "",
      label: "",
      // Projection accepts this source-preserving adapter; the drawing has no editable fields.
      editable: true,
      sourceMeta: {
        panels: [
          { ...artwork, panelWidth: null, subfigure: false, captionRange: null, labelRange: null },
        ],
        captionRange: null,
        labelRange: null,
      },
    },
  };
}

function scientificSourceRanges(source: string, setup: LatexVisualSetup) {
  const opening = /^\\begin\{([A-Za-z*]+)\}/u.exec(source);
  const environment = opening?.[1] ?? "";
  const declaration = setup.declarations.environments.get(environment);
  if (
    !opening ||
    setup.declarations.unsupported.has(environment) ||
    (!SCIENTIFIC_ENVIRONMENTS.has(environment) && !declaration)
  )
    return null;
  const titleRange = optionalArgumentRange(source, opening[0].length);
  if (titleRange && declaration?.kind === "quote") return null;
  const titleContent = titleRange ? parseInline(titleRange.source) : null;
  const richTitle = titleContent?.every(
    (node) =>
      node.type === "text" ||
      node.type === "hardBreak" ||
      (node.type === "latexInlineCommand" && ["ref", "eqref"].includes(String(node.attrs?.name))),
  );
  const title = titleRange
    ? (editableTableCell(titleRange.source, titleRange.from) ??
      (richTitle
        ? {
            from: titleRange.from,
            to: titleRange.to,
            display: titleContent!
              .map(
                (node) =>
                  node.text ??
                  (node.type === "hardBreak" ? " " : `[${String(node.attrs?.argument)}]`),
              )
              .join(""),
          }
        : null))
    : null;
  if (titleRange && !title) return null;
  const from = titleRange?.end ?? opening[0].length;
  const to = source.lastIndexOf("\\end{" + environment + "}");
  if (to < from || source.slice(to + environment.length + 6).trim()) return null;
  return { environment, title, titleRange, openingTo: opening[0].length, from, to };
}

const scientificMathCommands = new Set([
  ...MATH_SYMBOLS.flatMap((symbol) => latexCommands(symbol.latex).map((match) => match[1]!)),
  "le",
  "ge",
  "to",
  "text",
  "textrm",
  "textsf",
  "texttt",
  "textbf",
  "textit",
  "textnormal",
  "operatorname",
  "limits",
  "nolimits",
  "displaylimits",
  "substack",
  "overset",
  "underset",
  "mathop",
  "mathbin",
  "mathrel",
  "mathord",
  "mathopen",
  "mathclose",
  "mathpunct",
  "mathinner",
  // Scoped legacy notation is adapted at the MathLive boundary; source stays intact.
  "rm",
  "bf",
  "it",
  "sf",
  "tt",
  "cal",
  "bigl",
  "bigr",
  "bigm",
  "Bigl",
  "Bigr",
  "Bigm",
  "biggl",
  "biggr",
  "biggm",
  "Biggl",
  "Biggr",
  "Biggm",
]);

function supportedScientificMath(node: JSONContent, setup: LatexVisualSetup): boolean {
  const supportedEnvironments = (tex: string) =>
    [...tex.matchAll(/\\(?:begin|end)\{([^}]+)\}/gu)].every((match) =>
      STRUCTURED_MATH_ENVIRONMENT.test(match[1]!),
    );
  const supportedCommand = (name: string, depth = 0): boolean => {
    const macro = Object.hasOwn(setup.math.macros, name) ? setup.math.macros[name] : undefined;
    if (!macro) return !setup.math.unsupported.includes(name) && scientificMathCommands.has(name);
    return (
      depth < 32 &&
      supportedEnvironments(macro.def) &&
      latexCommands(macro.def).every(
        (match) => !/^[A-Za-z]/u.test(match[1]!) || supportedCommand(match[1]!, depth + 1),
      )
    );
  };
  if (node.type === "latexInlineMath" || node.type === "latexDisplayMath") {
    const tex = String(node.attrs?.tex ?? "");
    if (
      latexCommands(tex).some(
        (match) => /^[A-Za-z]/u.test(match[1]!) && !supportedCommand(match[1]!),
      )
    )
      return false;
    if (!supportedEnvironments(tex)) return false;
  }
  return node.content?.every((child) => supportedScientificMath(child, setup)) ?? true;
}

/** Adjacent minipages share one editable row and retain their exact glue/comments. */
function minipageRowRanges(source: string) {
  if (!source.startsWith("\\begin{minipage}")) return null;
  const ranges: { from: number; to: number; gap: string }[] = [];
  let from = 0;
  let gap = "0px";
  for (let count = 0; count < 16; count++) {
    const to = matchingEnvironmentEnd(source, from);
    if (to === null) return null;
    ranges.push({ from, to, gap });
    const separator = latexMinipageSeparator(source.slice(to));
    if (!separator) break;
    gap = separator.gap;
    from = to + separator.end;
  }
  return ranges.length > 1 ? ranges : null;
}

function parsePageLayoutStructure(
  source: string,
  depth: number,
  setup: LatexVisualSetup,
): JSONContent | null {
  if (depth >= 32) return null;
  const basicBox = latexBasicBoxOpening(source);
  if (basicBox) {
    if (
      ![basicBox.layout.color, basicBox.layout.background]
        .filter(Boolean)
        .every((color) => latexColorCss(color, setup.colors))
    )
      return null;
    const body = projectLatexVisualDocument(
      source.slice(basicBox.from, basicBox.to),
      depth + 1,
      setup,
    );
    if (body.rawBlocks > 0) return null;
    return {
      type: "latexScientific",
      attrs: {
        environment: basicBox.layout.command,
        title: "",
        raw: source,
        layout: basicBox.layout,
      },
      content: body.content.content ?? [{ type: "paragraph" }],
    };
  }
  const algorithm = parseLatexAlgorithm(source);
  // TikZ marks and overlays depend on the complete algorithm's TeX layout.
  if (
    !algorithm &&
    /^\\begin\{algorithm\}(?:\[[htbpH!]+\])?/u.test(source) &&
    source.endsWith("\\end{algorithm}") &&
    source.includes("\\begin{tikzpicture}") &&
    matchingEnvironmentEnd(source, 0) === source.length
  ) {
    const commands = latexSourceCommands(source);
    const caption = commands.find((command) => command.name === "caption");
    const label = commands.find((command) => command.name === "label");
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "compiledAlgorithm",
        environment: "algorithm",
        raw: source,
        editable: false,
        items: [],
        sourceMeta: {
          captioned: caption !== undefined,
          label: label ? (latexSourceArgument(source, label.to)?.value ?? "") : "",
        },
      },
    };
  }
  if (algorithm) {
    const content = algorithmContent(algorithm);
    const title = algorithm.caption ? metadataText(algorithm.caption.value) : "";
    if (!content || title === null) return null;
    return {
      type: "latexScientific",
      attrs: {
        environment: algorithm.layout.floating === false ? "algorithmic" : "algorithm",
        title,
        raw: source,
        layout: algorithm.layout,
      },
      content,
    };
  }
  const box = latexColorBoxOpening(source);
  if (box) {
    const titleNodes = parseInline(box.title);
    if (!titleNodes || titleNodes.some((node) => !["text", "hardBreak"].includes(node.type ?? "")))
      return null;
    const title = titleNodes
      .map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? "")))
      .join("");
    if (
      ![
        box.layout.colback,
        box.layout.colframe,
        box.layout.coltitle,
        box.layout.colbacklower,
        box.layout.borderColor,
      ]
        .filter(Boolean)
        .every((color) => latexColorCss(color, setup.colors))
    )
      return null;
    const expanded = expandColorBoxLoop(source.slice(box.from, box.to));
    if (!expanded) return null;
    const split = latexColorBoxSplit(expanded.source);
    const parts = split
      ? [expanded.source.slice(0, split.from), expanded.source.slice(split.to)]
      : [expanded.source];
    const bodies = parts.map((part) => projectLatexVisualDocument(part, depth + 1, setup));
    if (bodies.some((body) => body.rawBlocks > 0)) return null;
    const content = split
      ? bodies.map((body, index) => ({
          type: "latexScientific",
          attrs: {
            environment: index ? "tcblower" : "tcbupper",
            title: "",
            raw: parts[index],
            layout: {
              kind: "boxRegion",
              background: index
                ? box.layout.colbacklower || box.layout.colback
                : box.layout.colback,
            },
          },
          content: body.content.content ?? [{ type: "paragraph" }],
        }))
      : (bodies[0]!.content.content ?? [{ type: "paragraph" }]);
    return {
      type: "latexScientific",
      attrs: {
        environment: "tcolorbox",
        title,
        titleSource: box.title,
        raw: source,
        layout: box.layout,
      },
      content,
    };
  }
  const row = minipageRowRanges(source);
  if (row && row.at(-1)!.to === source.length) {
    const content = row.map((range) => {
      const node = parsePageLayoutStructure(source.slice(range.from, range.to), depth + 1, setup);
      return node ? { ...node, attrs: { ...node.attrs, layoutGap: range.gap } } : null;
    });
    if (content.some((node) => node === null)) return null;
    return {
      type: "latexScientific",
      attrs: { environment: "minipagerow", title: "", raw: source, layout: { kind: "row" } },
      content: content as JSONContent[],
    };
  }
  const opening = latexPageLayoutOpening(source);
  if (!opening) return null;
  const end = matchingEnvironmentEnd(source, 0);
  if (end !== source.length) return null;
  const to = end - `\\end{${opening.environment}}`.length;
  const zeroSpace =
    opening.layout.kind === "minipage"
      ? /^\s*\\vspace\{0pt\}\s*/u.exec(source.slice(opening.from, to))
      : null;
  const bodyFrom = opening.from + (zeroSpace?.[0].length ?? 0);
  const body = projectLatexVisualDocument(source.slice(bodyFrom, to), depth + 1, setup);
  if (body.rawBlocks > 0) return null;
  // Minipage footnotes have independent numbering and placement, not page footnotes.
  const containsFootnote = (node: JSONContent): boolean =>
    (node.type === "latexInlineCommand" && node.attrs?.name === "footnote") ||
    (node.content?.some(containsFootnote) ?? false);
  if (opening.layout.kind === "minipage" && containsFootnote(body.content)) return null;
  return {
    type: "latexScientific",
    attrs: { environment: opening.environment, title: "", raw: source, layout: opening.layout },
    content: body.content.content ?? [{ type: "paragraph" }],
  };
}

function patchPageLayoutStructure(
  raw: string,
  next: JSONContent,
  setup: LatexVisualSetup,
  rootSource: string | null,
): string | null {
  // Property commands reproject an explicitly changed wrapper before dispatch.
  // Accept its retained source only when it represents the entire requested node.
  const proposed = String(next.attrs?.raw ?? "");
  if (proposed && proposed !== raw) {
    const parsed = classifyBlock(proposed, 0, setup);
    if (parsed && roundTripSignature(parsed) === roundTripSignature(next)) return proposed;
  }
  if (next.attrs?.layout?.kind === "algorithm") {
    const algorithm = parseLatexAlgorithm(raw);
    const original = algorithm && algorithmContent(algorithm);
    const layout = next.attrs.layout;
    if (
      !algorithm ||
      !original ||
      next.attrs.environment !==
        (algorithm.layout.floating === false ? "algorithmic" : "algorithm") ||
      layout.fontSize !== algorithm.layout.fontSize ||
      layout.floating !== algorithm.layout.floating ||
      typeof layout.captioned !== "boolean" ||
      !Number.isInteger(layout.interval) ||
      layout.interval < 0 ||
      layout.interval > 100 ||
      typeof layout.placement !== "string" ||
      !/^[htbpH!]*$/u.test(layout.placement)
    )
      return null;
    const content = next.content ?? [];
    const rows = content.map(serializeAlgorithmLine);
    if (!rows.length || rows.some((row) => row === null)) return null;
    const patches: { from: number; to: number; value: string }[] = [];
    const title = String(next.attrs.title ?? "");
    const label = safeLatexLabel(layout.label ?? "");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    if (
      label === null ||
      (!layout.captioned && (title || label)) ||
      (layout.floating === false && (layout.captioned || layout.placement))
    )
      return null;
    if (layout.interval !== algorithm.layout.interval)
      patches.push({
        from: algorithm.innerFrom + "\\begin{algorithmic}".length,
        to: algorithm.innerOpeningTo,
        value: `[${layout.interval}]`,
      });
    if (layout.placement !== algorithm.layout.placement)
      patches.push({
        from: "\\begin{algorithm}".length,
        to: algorithm.openingTo,
        value: layout.placement ? `[${layout.placement}]` : "",
      });
    if (!layout.captioned && algorithm.caption) {
      patches.push({
        from: algorithm.caption.commandFrom,
        to: algorithm.caption.end,
        value: preserveSourceComments(
          raw.slice(algorithm.caption.commandFrom, algorithm.caption.end),
          "",
          eol,
          raw.slice(algorithm.caption.end),
        ),
      });
    } else if (layout.captioned && !algorithm.caption) {
      patches.push({
        from: algorithm.openingTo,
        to: algorithm.openingTo,
        value: `${eol}\\caption{${escapeText(title)}}${label ? `\\label{${label}}` : ""}${eol}`,
      });
    } else if (algorithm.caption && title !== metadataText(algorithm.caption.value)) {
      patches.push({
        from: algorithm.caption.from,
        to: algorithm.caption.to,
        value: escapeText(title),
      });
    }
    if (algorithm.label && label !== algorithm.layout.label) {
      patches.push(
        label
          ? { from: algorithm.label.from, to: algorithm.label.to, value: label }
          : { from: algorithm.label.commandFrom, to: algorithm.label.end, value: "" },
      );
    } else if (label && !algorithm.label && algorithm.caption) {
      patches.push({
        from: algorithm.caption.end,
        to: algorithm.caption.end,
        value: `\\label{${label}}`,
      });
    }
    const originalRows = new Map<string, { indices: number[]; next: number }>();
    original.forEach((row, index) => {
      const signature = roundTripSignature(row);
      const group = originalRows.get(signature) ?? { indices: [], next: 0 };
      group.indices.push(index);
      originalRows.set(signature, group);
    });
    const retainedRows = content.map((node, index) => {
      const group = originalRows.get(roundTripSignature(node));
      const matching = group?.indices[group.next++];
      if (matching === undefined) return rows[index]!;
      return raw.slice(algorithm.rows[matching]!.from, algorithm.rows[matching]!.to);
    });
    if (content.length === original.length) {
      content.forEach((node, index) => {
        if (roundTripSignature(node) !== roundTripSignature(original[index]!))
          patches.push({
            from: algorithm.rows[index]!.from,
            to: algorithm.rows[index]!.to,
            value: retainedRows[index]!,
          });
      });
    } else
      patches.push({
        from: algorithm.from,
        to: algorithm.to,
        value: `${eol}${retainedRows.join(eol)}${eol}`,
      });
    let result = raw;
    for (const patch of patches.sort((left, right) => right.from - left.from))
      result = result.slice(0, patch.from) + patch.value + result.slice(patch.to);
    return parseLatexAlgorithm(result) ? result : null;
  }
  if (next.attrs?.layout?.kind === "colorBox") {
    const box = latexColorBoxOpening(raw);
    if (
      !box ||
      next.attrs.environment !== "tcolorbox" ||
      JSON.stringify(box.layout) !== JSON.stringify(next.attrs.layout)
    )
      return null;
    const expanded = expandColorBoxLoop(raw.slice(box.from, box.to));
    if (!expanded) return null;
    const split = latexColorBoxSplit(expanded.source);
    let body: string;
    if (split) {
      if (
        next.content?.length !== 2 ||
        next.content.some(
          (child, index) =>
            child.attrs?.layout?.kind !== "boxRegion" ||
            child.attrs.environment !== (index ? "tcblower" : "tcbupper"),
        )
      )
        return null;
      const parts = [expanded.source.slice(0, split.from), expanded.source.slice(split.to)];
      const changed = parts.map((part, index) =>
        applyLatexVisualDocumentChange(
          part,
          projectLatexVisualDocument(part, 0, setup),
          { type: "doc", content: next.content![index]!.content ?? [] },
          { rootSource, allowRootUpdates: false },
        ),
      );
      if (changed.some((part) => !part)) return null;
      body = changed[0]!.source + expanded.source.slice(split.from, split.to) + changed[1]!.source;
    } else {
      const changed = applyLatexVisualDocumentChange(
        expanded.source,
        projectLatexVisualDocument(expanded.source, 0, setup),
        { type: "doc", content: next.content ?? [] },
        { rootSource, allowRootUpdates: false },
      );
      if (!changed) return null;
      body = changed.source;
    }
    // The node's retained source also lets document undo recover a materialized loop.
    const retained = String(next.attrs.raw ?? "");
    const retainedBox = latexColorBoxOpening(retained);
    const loop =
      expanded.loop ??
      (retainedBox
        ? expandColorBoxLoop(retained.slice(retainedBox.from, retainedBox.to))?.loop
        : null);
    if (loop && body.includes(loop.expanded)) body = body.replace(loop.expanded, () => loop.raw);
    let head = raw.slice(0, box.from);
    const title = String(next.attrs.title ?? "");
    const originalTitle = parseInline(box.title)
      ?.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? "")))
      .join("");
    if (title !== originalTitle || next.attrs.titleRemoved === true) {
      const changed = setLatexEnvironmentOption(
        head,
        "tcolorbox",
        "title",
        title ? `{${escapeText(title)}}` : null,
      );
      if ("error" in changed) return null;
      head = changed.source;
    }
    return head + body + raw.slice(box.to);
  }
  if (next.attrs?.layout?.kind === "boxRegion") {
    return (
      applyLatexVisualDocumentChange(
        raw,
        projectLatexVisualDocument(raw, 0, setup),
        { type: "doc", content: next.content ?? [] },
        { rootSource, allowRootUpdates: false },
      )?.source ?? null
    );
  }
  if (next.attrs?.layout?.kind === "basicBox") {
    const box = latexBasicBoxOpening(raw);
    if (!box || JSON.stringify(box.layout) !== JSON.stringify(next.attrs.layout)) return null;
    const body = raw.slice(box.from, box.to);
    const changed = applyLatexVisualDocumentChange(
      body,
      projectLatexVisualDocument(body, 0, setup),
      { type: "doc", content: next.content ?? [] },
      { rootSource, allowRootUpdates: false },
    );
    return changed ? raw.slice(0, box.from) + changed.source + raw.slice(box.to) : null;
  }
  const row = minipageRowRanges(raw);
  if (next.attrs?.layout?.kind === "row") {
    if (!row || row.length !== next.content?.length) return null;
    let result = raw;
    for (let index = row.length - 1; index >= 0; index--) {
      const range = row[index]!;
      const value = patchPageLayoutStructure(
        raw.slice(range.from, range.to),
        next.content![index]!,
        setup,
        rootSource,
      );
      if (value === null) return null;
      result = result.slice(0, range.from) + value + result.slice(range.to);
    }
    return result;
  }
  const opening = latexPageLayoutOpening(raw);
  const replacement =
    opening?.layout.kind === "direction"
      ? latexPageLayoutOpening(String(next.attrs?.raw ?? ""))
      : null;
  const renameDirection =
    replacement?.layout.kind === "direction" &&
    next.attrs?.environment === replacement.environment &&
    JSON.stringify(next.attrs.layout) === JSON.stringify(replacement.layout);
  if (
    !opening ||
    (!renameDirection &&
      (next.attrs?.environment !== opening.environment ||
        JSON.stringify(next.attrs.layout) !== JSON.stringify(opening.layout)))
  )
    return null;
  const end = matchingEnvironmentEnd(raw, 0);
  if (end !== raw.length) return null;
  const to = end - `\\end{${opening.environment}}`.length;
  const zeroSpace =
    opening.layout.kind === "minipage"
      ? /^\s*\\vspace\{0pt\}\s*/u.exec(raw.slice(opening.from, to))
      : null;
  const from = opening.from + (zeroSpace?.[0].length ?? 0);
  const original = raw.slice(from, to);
  const changed = applyLatexVisualDocumentChange(
    original,
    projectLatexVisualDocument(original, 0, setup),
    { type: "doc", content: next.content ?? [] },
    { rootSource, allowRootUpdates: false },
  );
  if (!changed) return null;
  return renameDirection
    ? String(next.attrs!.raw).slice(0, replacement.from) +
        changed.source +
        `\\end{${replacement.environment}}`
    : raw.slice(0, from) + changed.source + raw.slice(to);
}

function parseScientificStructure(
  source: string,
  depth: number,
  setup: LatexVisualSetup,
): JSONContent | null {
  if (depth >= 32) return null;
  const ranges = scientificSourceRanges(source, setup);
  if (!ranges) return null;
  const body = projectLatexVisualDocument(source.slice(ranges.from, ranges.to), depth + 1, setup);
  if (body.rawBlocks > 0 || !supportedScientificMath(body.content, setup)) return null;
  return {
    type: "latexScientific",
    attrs: {
      environment: ranges.environment,
      title: ranges.title?.display ?? "",
      titleSource: ranges.titleRange?.source ?? null,
      raw: source,
    },
    content: body.content.content ?? [{ type: "paragraph" }],
  };
}

function classifyBlock(
  source: string,
  depth: number,
  setup = visualSetup(source),
): JSONContent | null {
  if (source.trim() === "\\par") return { type: "paragraph", content: [] };
  const spacing = latexLayoutSpacing(source);
  if (spacing)
    return {
      type: "latexRichPreview",
      attrs: { kind: "spacing", environment: spacing, raw: source, editable: true },
    };
  return (
    parsePageLayoutStructure(source, depth, setup) ??
    parseScientificStructure(source, depth, setup) ??
    parseHeading(source) ??
    parseList(source, depth, setup) ??
    (() => {
      if (depth > 32 || !source.startsWith("\\begin{quote}") || !source.endsWith("\\end{quote}"))
        return null;
      const inner = projectLatexVisualDocument(source.slice(13, -11), depth + 1, setup);
      return inner.rawBlocks === 0
        ? { type: "blockquote", content: inner.content.content ?? [] }
        : null;
    })() ??
    parseDisplayMath(source) ??
    (() => {
      const trimmed = source.trim();
      const prefix = /^\\noindent\b\s*/u.exec(trimmed);
      const content = parseInline(prefix ? trimmed.slice(prefix[0].length) : trimmed);
      return content === null
        ? null
        : { type: "paragraph", ...(prefix ? { attrs: { latexNoIndent: true } } : {}), content };
    })()
  );
}

export function projectLatexVisualDocument(
  source: string,
  depth = 0,
  root: string | LatexVisualSetup = source,
): LatexVisualDocument {
  const setup = typeof root === "string" ? visualSetup(root) : root;
  const expansion = depth === 0 ? expandLatexDocumentLoop(source, setup.math.macros) : null;
  if (expansion) {
    const expandedSource =
      source.slice(0, expansion.from) + expansion.expanded + source.slice(expansion.to);
    const virtual = projectLatexVisualDocument(expandedSource, 0, setup);
    const generatedBlocks = virtual.blocks.filter(
      (block) =>
        block.from < expansion.from + expansion.expanded.length && block.to > expansion.from,
    );
    // Do not expose a partly expanded program or writable virtual source fallbacks.
    if (
      !virtual.generated &&
      generatedBlocks.length > 0 &&
      generatedBlocks.every((block) => block.editable)
    )
      return {
        ...virtual,
        source,
        generated: { expansion, virtual },
        generatedOrigins: [{ raw: expansion.raw, expanded: expansion.expanded }],
        blocks: virtual.blocks.map((block) => {
          const range = documentLoopSourceRange(expansion, block.from, block.to);
          return { ...block, ...range, source: source.slice(range.from, range.to) };
        }),
      };
  }
  const beginMarker = "\\begin{document}";
  const endMarker = "\\end{document}";
  const begin = findDelimiter(source, beginMarker, 0);
  const bodyFrom = begin < 0 ? 0 : begin + beginMarker.length;
  const body = source.slice(bodyFrom);
  const blocks: LatexVisualSourceBlock[] = [];
  const manualContents: { from: number; level: number; number: string; title: string }[] = [];
  let dynamicSyntax = /\\catcode\b/u.test(withoutVisualComments(source.slice(0, bodyFrom)));
  let cursor = 0;
  while (cursor < body.length) {
    const whitespace = /^\s+/u.exec(body.slice(cursor));
    if (whitespace) cursor += whitespace[0].length;
    if (cursor >= body.length) break;
    if (body.startsWith(endMarker, cursor)) break;
    if (body[cursor] === "%") {
      cursor = commentEnd(body, cursor);
      continue;
    }
    // Nested structures must retain commands in their own serialization path.
    const entry = dynamicSyntax || depth > 0 ? null : contentsEntry(body, cursor);
    if (entry) {
      manualContents.push({
        from: bodyFrom + cursor,
        level: entry.level,
        number: "",
        title: entry.display,
      });
      cursor = entry.end;
      continue;
    }
    const relativeEnd = nextBlockEnd(body, cursor);
    const rawEnd = Math.max(cursor + 1, relativeEnd);
    const raw = body.slice(cursor, rawEnd).replace(/[\r\n]+$/u, "");
    const from = bodyFrom + cursor;
    const to = from + raw.length;
    // A paragraph terminator after content does not itself produce an empty
    // paragraph in TeX. Keep it in the source gap, while retaining isolated
    // empty paragraphs (including those inserted by Enter) as editable nodes.
    const previous = blocks.at(-1);
    if (
      raw.trim() === "\\par" &&
      previous &&
      previous.source.trim() !== "\\par" &&
      /^[\t ]*(?:\r?\n[\t ]*)?$/u.test(source.slice(previous.to, from))
    ) {
      cursor = rawEnd;
      continue;
    }
    const id = sourceId(blocks.length);
    dynamicSyntax ||=
      /\\(?:catcode|def|gdef|edef|xdef|let|newcommand|renewcommand|newenvironment|renewenvironment)\b/u.test(
        withoutVisualComments(activeLatexSource(raw)),
      );
    let classified = dynamicSyntax ? null : classifyBlock(raw, depth, setup);
    const supportedColors = (node: JSONContent): boolean =>
      (node.marks ?? []).every(
        (mark) =>
          !["latexColor", "latexBackground"].includes(mark.type) ||
          (latexColorCss(String(mark.attrs?.color ?? ""), setup.colors) !== null &&
            (mark.attrs?.command !== "fcolorbox" ||
              latexColorCss(String(mark.attrs?.background ?? ""), setup.colors) !== null)),
      ) && (node.content ?? []).every(supportedColors);
    if (classified && !supportedColors(classified)) classified = null;
    const environment = /^\\begin\{([A-Za-z*]+)\}/u.exec(raw)?.[1];
    const candidate =
      classified === null &&
      !dynamicSyntax &&
      !(environment && setup.declarations.unsupported.has(environment))
        ? parseRichPreview(raw, source, setup)
        : null;
    const preview = candidate?.attrs?.editable === true ? candidate : null;
    const node = withSourceId(
      classified ?? preview ?? { type: "latexRawBlock", attrs: { raw, label: "Raw LaTeX" } },
      id,
    );
    blocks.push({
      id,
      from,
      to,
      node,
      source: raw,
      editable: classified !== null || preview?.attrs?.editable === true,
    });
    cursor = rawEnd;
  }
  let section = 0;
  let subsection = 0;
  let subsubsection = 0;
  let chapter = 0;
  let part = 0;
  let appendix = false;
  const chapters =
    /\\documentclass(?:\[[^\]]*\])?\{(?:book|report|memoir|scrbook|scrreprt)\}/u.test(source);
  const numberedContents = blocks.flatMap((block) => {
    if (
      block.node.type === "latexRichPreview" &&
      block.node.attrs?.kind === "documentCommand" &&
      block.node.attrs.environment === "appendix"
    ) {
      appendix = true;
      chapter = section = subsection = subsubsection = 0;
      return [];
    }
    if (block.node.type === "latexRichPreview" && block.node.attrs?.kind === "part") {
      if (block.node.attrs.unnumbered === true) return [];
      part += 1;
      return [
        {
          from: block.from,
          level: 0,
          number: latexRomanNumber(part),
          title: String(block.node.attrs.title ?? ""),
        },
      ];
    }
    if (block.node.type !== "heading" || block.node.attrs?.unnumbered === true) return [];
    const level = Number(block.node.attrs?.level ?? 1);
    // The standard classes omit run-in headings from the contents by default.
    if (level === 4 || level === 5) return [];
    if (level === 6) {
      chapter += 1;
      section = 0;
      subsection = 0;
      subsubsection = 0;
    } else if (level === 1) {
      section += 1;
      subsection = 0;
      subsubsection = 0;
    } else if (level === 2) {
      subsection += 1;
      subsubsection = 0;
    } else subsubsection += 1;
    const sectionNumber = latexCounterLabel(section, appendix && !chapters ? "Alph" : "arabic");
    const localNumber =
      level === 1
        ? sectionNumber
        : level === 2
          ? `${sectionNumber}.${subsection}`
          : `${sectionNumber}.${subsection}.${subsubsection}`;
    const chapterNumber = latexCounterLabel(chapter, appendix ? "Alph" : "arabic");
    const number =
      level === 6 ? chapterNumber : (chapters ? `${chapterNumber}.` : "") + localNumber;
    const title = (block.node.content ?? [])
      .map((child) =>
        child.type === "text"
          ? (child.text ?? "")
          : child.type === "latexInlineMath"
            ? String(child.attrs?.tex ?? "")
            : String(child.attrs?.argument ?? ""),
      )
      .join("");
    return [{ from: block.from, level: level === 6 ? 0 : level, number, title }];
  });
  const tocEntries = [...numberedContents, ...manualContents]
    .sort((left, right) => left.from - right.from)
    .map(({ from, level, number, title }) => ({
      level,
      number,
      title,
      targetSourceId: [...blocks].reverse().find((block) => block.from <= from)?.id ?? null,
    }));
  for (const [index, block] of blocks.entries()) {
    if (
      block.node.type !== "latexRichPreview" ||
      block.node.attrs?.kind !== "toc" ||
      block.node.attrs.environment !== "tableofcontents"
    )
      continue;
    blocks[index] = {
      ...block,
      node: { ...block.node, attrs: { ...block.node.attrs, tocEntries } },
    };
  }
  if (blocks.length === 0) {
    const id = sourceId(0);
    blocks.push({
      id,
      from: bodyFrom + cursor,
      to: bodyFrom + cursor,
      source: "",
      editable: true,
      node: { type: "paragraph", attrs: { sourceId: id }, content: [] },
    });
  }
  return {
    source,
    setup,
    content: { type: "doc", content: blocks.map((block) => block.node) },
    blocks,
    supportedBlocks: blocks.filter((block) => block.editable).length,
    rawBlocks: blocks.filter((block) => !block.editable).length,
  };
}

export function escapeText(text: string): string {
  const escapes: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "%": "\\%",
    "&": "\\&",
    _: "\\_",
    "#": "\\#",
    $: "\\$",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
    "\u00a0": "~",
    "\u2009": "\\,",
    "\u2002": "\\enspace{}",
    "\u2003": "\\quad{}",
    "'": "\\textquotesingle{}",
    "`": "\\textasciigrave{}",
  };
  const escaped = text.replace(
    /[\\%&_#${}~^'`\u00a0\u2002\u2003\u2009]/gu,
    (character) => escapes[character]!,
  );
  // TeX engines need accent commands for graphemes without a precomposed letter.
  return escaped.replace(
    /([A-Za-z])([\u0300-\u036f])/gu,
    (grapheme, base: string, accent: string) => {
      const command = Object.entries(TEXT_ACCENTS).find(([, mark]) => mark === accent)?.[0];
      return command ? `\\${command}{${base}}` : grapheme;
    },
  );
}

/** Bounded citation syntax; retain notes verbatim when editing the citation keys. */
export function latexCitationParts(source: string) {
  const command = /^\\(cite|citep|citet|parencite|textcite|citeauthor|citeyear)\b\s*/u.exec(source);
  if (!command) return null;
  let cursor = command[0].length;
  const notes: string[] = [];
  while (source[cursor] === "[") {
    if (notes.length >= (command[1] === "cite" ? 1 : 2)) return null;
    const optional = optionalArgumentRange(source, cursor);
    if (!optional || metadataText(optional.source) === null) return null;
    notes.push(optional.source);
    cursor = optional.end;
    cursor += /^[\t\r\n ]*/u.exec(source.slice(cursor))![0].length;
  }
  const argument = requiredArgument(source, cursor);
  if (!argument || /[{}\\%]/u.test(argument.source)) return null;
  return {
    name: command[1]!,
    argument: argument.source,
    notes,
    prefix: source.slice(0, argument.from - 1),
    end: argument.next,
  };
}

export function latexInlineCommandSource(
  name: string,
  argument: string,
  linkText = "",
  raw = "",
): string {
  if (name === "columnbreak")
    return /^\\columnbreak\b(?:[\t ]*\[4\])?\s*$/u.test(raw) ? raw : "\\columnbreak";
  if (name === "verb") return inlineLatexLiteralSource(argument, raw) ?? raw;
  const citation = latexCitationParts(raw);
  if (citation?.name === name) {
    if (citation.argument === argument) return raw.slice(0, citation.end);
    return `${citation.prefix}{${argument}}`;
  }
  const first = name === "hyperref" ? `[${argument}]` : `{${argument}}`;
  return `\\${name}${first}${["href", "hyperref", "hyperlink", "hypertarget"].includes(name) ? `{${linkText}}` : ""}`;
}

function serializeInline(nodes: readonly JSONContent[] | undefined): string {
  // A bilingual phrase must remain one bidi isolate even when it contains bold text or math.
  const direction = nodes
    ?.flatMap((node) => node.marks ?? [])
    .find((mark) => latexDirectionMark(mark.type));
  if (nodes && direction) {
    let result = "";
    for (let at = 0; at < nodes.length;) {
      const marked = nodes[at]!.marks?.some((mark) => mark.type === direction.type) ?? false;
      let end = at + 1;
      while (
        end < nodes.length &&
        (nodes[end]!.marks?.some((mark) => mark.type === direction.type) ?? false) === marked
      )
        end++;
      const content = nodes.slice(at, end).map((node) => ({
        ...node,
        marks: (node.marks ?? []).filter((mark) => mark.type !== direction.type),
      }));
      const inner = serializeInline(content);
      result += marked ? latexTextMarkSource(direction.type, inner) : inner;
      at = end;
    }
    return result;
  }
  // One color box must stay one TeX box when its text contains multiple marks.
  const colorType = ["latexColor", "latexBackground"].find((type) =>
    nodes?.some((node) => node.marks?.some((mark) => mark.type === type)),
  );
  if (colorType && nodes) {
    let result = "";
    for (let at = 0; at < nodes.length;) {
      const color = nodes[at]!.marks?.find((mark) => mark.type === colorType);
      const signature = JSON.stringify(color);
      let end = at + 1;
      while (
        end < nodes.length &&
        JSON.stringify(nodes[end]!.marks?.find((mark) => mark.type === colorType)) === signature
      )
        end++;
      const content = nodes.slice(at, end).map((node) => {
        if (!color) return node;
        const index = node.marks!.findIndex((mark) => mark.type === colorType);
        return { ...node, marks: node.marks!.filter((_, at) => at !== index) };
      });
      const inner = serializeInline(content);
      result += color ? (latexColorMarkSource(color.attrs, inner) ?? "") : inner;
      at = end;
    }
    return result;
  }
  const merged: JSONContent[] = [];
  for (const node of nodes ?? []) {
    const previous = merged.at(-1);
    if (
      node.type === "text" &&
      previous?.type === "text" &&
      JSON.stringify(node.marks ?? []) === JSON.stringify(previous.marks ?? [])
    )
      merged[merged.length - 1] = { ...previous, text: (previous.text ?? "") + (node.text ?? "") };
    else merged.push(node);
  }
  return merged
    .map((node) => {
      let value: string;
      if (node.type === "latexInlineMath") {
        value = latexVisualMathSource(
          {
            tex: String(node.attrs?.tex ?? ""),
            wrapper: node.attrs?.wrapper === "dollar" ? "dollar" : "paren",
          },
          false,
        );
      } else if (node.type === "latexInlineCommand") {
        const name = String(node.attrs?.name ?? "");
        if (!INLINE_ATOMS.has(name) || SOURCE_ONLY_INLINE_COMMANDS.has(name)) return "";
        value = latexInlineCommandSource(
          name,
          String(node.attrs?.argument ?? ""),
          String(node.attrs?.linkText ?? ""),
          String(node.attrs?.raw ?? ""),
        );
      } else if (node.type === "hardBreak") {
        value = "\\\\\n";
      } else if (node.type === "text") {
        value = escapeText(node.text ?? "");
      } else return "";
      for (const mark of (node.marks ?? []).toReversed())
        value = ["latexColor", "latexBackground"].includes(mark.type)
          ? (latexColorMarkSource(mark.attrs, value) ?? "")
          : latexTextMarkSource(mark.type, value);
      return value;
    })
    .join("");
}

function algorithmContent(
  algorithm: NonNullable<ReturnType<typeof parseLatexAlgorithm>>,
): JSONContent[] | null {
  const rows: JSONContent[] = [];
  for (const row of algorithm.rows) {
    const content = parseInline(row.body);
    const comment = row.comment === null ? null : parseInline(row.comment);
    if (!content || (row.comment !== null && !comment)) return null;
    if (comment) content.push({ type: "latexAlgorithmComment", content: comment });
    rows.push({ type: "latexAlgorithmLine", attrs: { command: row.command }, content });
  }
  return rows;
}

function serializeAlgorithmLine(node: JSONContent): string | null {
  if (node.type !== "latexAlgorithmLine") return null;
  const content = node.content ?? [];
  const comments = content.filter((child) => child.type === "latexAlgorithmComment");
  if (comments.length > 1 || (comments.length && content.at(-1) !== comments[0])) return null;
  return algorithmLineSource(
    String(node.attrs?.command),
    serializeInline(content.filter((child) => child.type !== "latexAlgorithmComment")),
    comments[0] ? serializeInline(comments[0].content) : null,
  );
}

function canonicalTableColumnSpec(
  alignments: readonly TableAlignment[],
  kind: string,
  style: string,
): string {
  const columns = alignments.map((alignment) => {
    if (kind !== "stretch") return alignment === "center" ? "c" : alignment === "right" ? "r" : "l";
    if (alignment === "center") return ">{\\centering\\arraybackslash}X";
    if (alignment === "right") return ">{\\raggedleft\\arraybackslash}X";
    return ">{\\raggedright\\arraybackslash}X";
  });
  return style === "grid" ? `|${columns.join("|")}|` : columns.join(" ");
}

function canonicalTableBody(
  rows: readonly (readonly string[])[],
  style: string,
  hasHeader: boolean,
  eol: string,
  sourceCells?: readonly (readonly string[])[],
): string {
  const serializedRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      if (sourceCells) return sourceCells[rowIndex]![columnIndex]!;
      const value = serializeTableCellValue(cell);
      return hasHeader && rowIndex === 0 ? `\\textbf{${value}}` : value;
    });
    return `${cells.join(" & ")} \\\\`;
  });
  if (style === "booktabs") {
    const lines = ["\\toprule"];
    serializedRows.forEach((row, index) => {
      lines.push(row);
      if (hasHeader && index === 0) lines.push("\\midrule");
    });
    lines.push("\\bottomrule");
    return `${eol}${lines.join(eol)}${eol}`;
  }
  if (style === "grid") {
    const lines = ["\\hline"];
    for (const row of serializedRows) lines.push(row, "\\hline");
    return `${eol}${lines.join(eol)}${eol}`;
  }
  return `${eol}${serializedRows.join(eol)}${eol}`;
}

export type LatexVisualTablePreset = "plain" | "booktabs" | "grid" | "stretch";

export function latexVisualTableSource(
  rowCount: number,
  columnCount: number,
  preset: LatexVisualTablePreset,
): string {
  const safeRows = Math.max(1, Math.min(20, Math.trunc(rowCount)));
  const safeColumns = Math.max(1, Math.min(12, Math.trunc(columnCount)));
  const rows = Array.from({ length: safeRows }, () =>
    Array.from({ length: safeColumns }, () => ""),
  );
  const kind = preset === "stretch" ? "stretch" : "fixed";
  const style = preset === "stretch" ? "booktabs" : preset;
  const alignments = Array.from({ length: safeColumns }, () => "left" as const);
  const columnSpec = canonicalTableColumnSpec(alignments, kind, style);
  const environment = kind === "stretch" ? "tabularx" : "tabular";
  const opening =
    kind === "stretch"
      ? `\\begin{${environment}}{\\textwidth}{${columnSpec}}`
      : `\\begin{${environment}}{${columnSpec}}`;
  return [
    "\\begin{table}[htbp]",
    "\\centering",
    opening,
    canonicalTableBody(rows, style, true, "\n").trim(),
    `\\end{${environment}}`,
    "\\end{table}",
  ].join("\n");
}

export function latexVisualTableCellsClipboard(
  node: JSONContent,
  firstRow: number,
  lastRow: number,
  firstColumn: number,
  lastColumn: number,
): string | null {
  const rows = tableRows(node.attrs?.rows);
  if (
    !rows ||
    firstRow < 0 ||
    firstColumn < 0 ||
    lastRow >= rows.length ||
    lastColumn >= rows[0]!.length ||
    lastRow < firstRow ||
    lastColumn < firstColumn
  )
    return null;
  if (node.attrs?.sourceMeta?.tableLayout) {
    const bounds = latexTableSelectionBounds(
      node.attrs.sourceMeta.tableLayout,
      firstRow,
      lastRow,
      firstColumn,
      lastColumn,
    );
    firstRow = bounds.firstRow;
    lastRow = bounds.lastRow;
    firstColumn = bounds.firstColumn;
    lastColumn = bounds.lastColumn;
  }
  const cells = preservedTableCells(node, rows)
    .slice(firstRow, lastRow + 1)
    .map((row, index) =>
      row.slice(firstColumn, lastColumn + 1).filter((_cell, column) => {
        const layout = node.attrs?.sourceMeta?.tableLayout?.[firstRow + index]?.[
          firstColumn + column
        ] as LatexTableCellLayout | undefined;
        if (!layout) return true;
        if (
          layout.row < firstRow ||
          layout.column < firstColumn ||
          layout.row + layout.rowSpan - 1 > lastRow ||
          layout.column + layout.colSpan - 1 > lastColumn
        )
          return false;
        return layout.row !== firstRow + index || layout.column === firstColumn + column;
      }),
    );
  const alignments = Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => {
    const alignment = node.attrs?.columnAlignments?.[firstColumn + index];
    return alignment === "center" ? "c" : alignment === "right" ? "r" : "l";
  }).join(" ");
  return `\\begin{tabular}{${alignments}}\n${cells.map((row) => `${row.join(" & ")} \\\\`).join("\n")}\n\\end{tabular}`;
}

/** Edit metadata against its original ranges without rebuilding the table grid. */
function tableMetadataPatches(node: JSONContent, source: string) {
  const meta = node.attrs?.sourceMeta;
  const caption = node.attrs?.caption;
  const label = safeLatexLabel(node.attrs?.label ?? "");
  if (!meta || typeof caption !== "string" || label === null) return null;
  const removeCaption = node.attrs?.captionRemoved === true;
  const patches: { from: number; to: number; value: string; outsideExpansion?: boolean }[] = [];
  const commandRange = (name: string, range: { from: number; to: number }) => {
    for (const command of latexSourceCommands(source)) {
      if (command.name !== name) continue;
      const argument = latexSourceArgument(source, command.to);
      if (argument?.from === range.from && argument.to === range.to)
        return { from: command.from, to: argument.end };
    }
    return null;
  };
  let removedCaption: { from: number; to: number } | null = null;
  let removedLabel: { from: number; to: number } | null = null;
  for (const [name, range, value] of [
    ["caption", meta.captionRange, caption],
    ["label", meta.labelRange, label],
  ] as const) {
    if (range === null) continue;
    if (
      !range ||
      !Number.isInteger(range.from) ||
      !Number.isInteger(range.to) ||
      range.from < 0 ||
      range.to < range.from ||
      range.to > source.length ||
      typeof range.original !== "string"
    )
      return null;
    if (removeCaption || (name === "label" && value === "" && range.original !== "")) {
      const command = commandRange(name, range);
      if (!command) return null;
      patches.push({ ...command, value: "", outsideExpansion: true });
      if (name === "caption") removedCaption = command;
      else removedLabel = command;
    } else if (value !== range.original) {
      patches.push({
        from: range.from,
        to: range.to,
        value: name === "caption" ? escapeText(value) : value,
      });
    }
  }
  if (removedCaption && meta.longtable) {
    // A longtable caption owns a row terminator; removing only its text leaves
    // an empty row in the first-page header.
    let after = removedCaption.to;
    if (
      removedLabel &&
      removedLabel.from >= after &&
      /^(?:\s|%[^\r\n]*(?:\r?\n|$))*$/u.test(source.slice(after, removedLabel.from))
    )
      after = removedLabel.to;
    const trivia = /^(?:\s|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(after))![0];
    const from = after + trivia.length;
    const separator = /^(?:\\\\\*?|\\tabularnewline\b)/u.exec(source.slice(from));
    if (separator) {
      const option = latexSourceArgument(source, from + separator[0].length, "[", "]");
      patches.push({
        from,
        to: option?.end ?? from + separator[0].length,
        value: "",
        outsideExpansion: true,
      });
    }
  }
  if (removeCaption) return patches;
  const addCaption =
    meta.captionRange === null && caption !== "" && !commandArgumentRange(source, "caption");
  const addLabel =
    meta.labelRange === null && label !== "" && !commandArgumentRange(source, "label");
  if (!addCaption && !addLabel) return patches;
  if (!meta.hasFloat && !meta.longtable) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (addCaption) {
    const at = meta.longtable ? meta.bodyFrom : meta.outerInsertAt;
    if (!Number.isInteger(at) || at < 0 || at > source.length) return null;
    const reference = addLabel ? `\\label{${label}}` : "";
    patches.push({
      from: at,
      to: at,
      value: `${eol}\\caption{${escapeText(caption)}}${reference}${meta.longtable ? "\\\\" : ""}${eol}`,
      outsideExpansion: true,
    });
  } else if (addLabel) {
    const at = meta.captionRange?.to + 1;
    if (!Number.isInteger(at) || at < 0 || at > source.length) return null;
    patches.push({ from: at, to: at, value: `\\label{${label}}`, outsideExpansion: true });
  }
  return patches;
}

function preservedTableCells(node: JSONContent, rows: string[][]): string[][] {
  const originals = node.attrs?.sourceMeta?.originalCells;
  return rows.map((row, rowIndex) =>
    row.map((text, columnIndex) => {
      const rowId = /^table-row-(\d+)$/u.exec(String(node.attrs?.rowIds?.[rowIndex]));
      const columnId = /^table-column-(\d+)$/u.exec(String(node.attrs?.columnIds?.[columnIndex]));
      const cell = rowId && columnId ? originals?.[Number(rowId[1])]?.[Number(columnId[1])] : null;
      if (
        !cell ||
        typeof cell.raw !== "string" ||
        typeof cell.from !== "number" ||
        typeof cell.to !== "number"
      ) {
        const value = serializeTableCellValue(text);
        return node.attrs?.hasHeader && rowIndex === 0 ? `\\textbf{${value}}` : value;
      }
      let value =
        text === cell.display
          ? cell.raw
          : cell.raw.slice(0, cell.from) +
            serializeTableCellValue(text, latexTableCellIsMath(node, rowIndex, columnIndex)) +
            cell.raw.slice(cell.to);
      if (
        rowIndex === 0 &&
        (node.attrs?.hasHeader !== node.attrs?.sourceMeta?.originalHasHeader ||
          (node.attrs?.hasHeader && rowId?.[1] !== "0"))
      ) {
        if (node.attrs?.hasHeader) value = `\\textbf{${value}}`;
        else if (/^\\textbf\{[\s\S]*\}$/u.test(value)) value = value.slice(8, -1);
      }
      return value;
    }),
  );
}

function tableRows(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.map((row) => (Array.isArray(row) ? row : null));
  const width = rows[0]?.length ?? 0;
  if (
    width === 0 ||
    rows.some(
      (row) => row === null || row.length !== width || row.some((cell) => typeof cell !== "string"),
    )
  )
    return null;
  return rows as string[][];
}

function safeLatexArgument(value: unknown): string | null {
  if (typeof value !== "string" || /[{}%\r\n]/u.test(value)) return null;
  return value.trim();
}

function safeLatexLabel(value: unknown): string | null {
  const argument = safeLatexArgument(value);
  return argument !== null && !/[\s\\]/u.test(argument) ? argument : null;
}

function safeGraphicsWidth(value: unknown): string | null {
  const argument = safeLatexArgument(value);
  return argument !== null &&
    argument.indexOf(",") < 0 &&
    argument.indexOf("[") < 0 &&
    argument.indexOf("]") < 0
    ? argument
    : null;
}

function figureOptionsWithWidth(options: string, width: string): string {
  const retained = options
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option && !option.startsWith("width="));
  if (width) retained.unshift(`width=${width}`);
  return retained.join(",");
}

function serializeScientificPreview(node: JSONContent): string | null {
  const environment = safeLatexArgument(node.attrs?.environment);
  if (!environment || !SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
  const body = typeof node.attrs?.body === "string" ? node.attrs.body : null;
  const label = safeLatexLabel(node.attrs?.label ?? "");
  if (body === null || label === null) return null;
  const eol = String(node.attrs?.raw ?? "").includes("\r\n") ? "\r\n" : "\n";
  return [
    `\\begin{${environment}}${title ? `[${escapeText(title)}]` : ""}`,
    ...(label ? [`\\label{${label}}`] : []),
    escapeText(body),
    `\\end{${environment}}`,
  ].join(eol);
}

function serializeFigurePreview(node: JSONContent): string | null {
  const path = safeLatexArgument(node.attrs?.path);
  const width = safeGraphicsWidth(node.attrs?.figureWidth ?? "");
  const placement = safeLatexArgument(node.attrs?.figurePlacement ?? "");
  const label = safeLatexLabel(node.attrs?.label ?? "");
  const caption = typeof node.attrs?.caption === "string" ? node.attrs.caption : "";
  const originalOptions =
    typeof node.attrs?.figureOptions === "string" ? node.attrs.figureOptions : "";
  if (
    path === null ||
    width === null ||
    placement === null ||
    label === null ||
    !/^[htbpH!]*$/u.test(placement)
  )
    return null;
  const environment = node.attrs?.figureStarred === true ? "figure*" : "figure";
  const alignment =
    node.attrs?.figureAlignment === "left"
      ? "\\raggedright"
      : node.attrs?.figureAlignment === "right"
        ? "\\raggedleft"
        : "\\centering";
  const options = figureOptionsWithWidth(originalOptions, width);
  const eol = String(node.attrs?.raw ?? "").includes("\r\n") ? "\r\n" : "\n";
  const metadata = [
    ...(latexVisualFloatHasCaption(node) ? [`\\caption{${escapeText(caption)}}`] : []),
    ...(node.attrs?.captionRemoved !== true && label ? [`\\label{${label}}`] : []),
  ];
  return [
    `\\begin{${environment}}${placement ? `[${placement}]` : ""}`,
    alignment,
    ...(node.attrs?.figureCaptionPosition === "above" ? metadata : []),
    `\\includegraphics${options ? `[${options}]` : ""}{${path}}`,
    ...(node.attrs?.figureCaptionPosition !== "above" ? metadata : []),
    `\\end{${environment}}`,
  ].join(eol);
}

export function serializeLatexVisualBlock(node: JSONContent): string | null {
  if (node.type === "latexAlgorithmLine") return serializeAlgorithmLine(node);
  if (node.type === "latexScientific") {
    if (node.attrs?.layout)
      return patchPageLayoutStructure(
        String(node.attrs.raw ?? ""),
        node,
        visualSetup(String(node.attrs.raw ?? "")),
        null,
      );
    const environment = safeLatexArgument(node.attrs?.environment);
    // Custom names are accepted only when reprojection finds a supported root declaration.
    if (!environment || !/^[A-Za-z]+\*?$/u.test(environment)) return null;
    const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
    if (!node.attrs?.titleSource && /[\[\]]/u.test(title)) return null;
    const blocks = (node.content ?? []).map(serializeLatexVisualBlock);
    if (blocks.some((block) => block === null)) return null;
    const eol = String(node.attrs?.raw ?? "").includes("\r\n") ? "\r\n" : "\n";
    return (
      "\\begin{" +
      environment +
      "}" +
      (title
        ? "[" +
          (typeof node.attrs?.titleSource === "string"
            ? node.attrs.titleSource
            : escapeText(title)) +
          "]"
        : "") +
      eol +
      blocks.join(eol + eol) +
      eol +
      "\\end{" +
      environment +
      "}"
    );
  }
  if (node.type === "paragraph")
    return (
      (node.attrs?.latexNoIndent ? "\\noindent " : "") + (serializeInline(node.content) || "\\par")
    );
  if (node.type === "heading") {
    const command =
      LATEX_HEADING_STYLES.find((style) => style.level === node.attrs?.level)?.command ?? "section";
    const star = node.attrs?.unnumbered === true ? "*" : "";
    const label = node.attrs?.referenceLabel;
    if (label && (typeof label !== "string" || /[{}\\%\s#$&~^]/u.test(label))) return null;
    return `\\${command}${star}{${serializeInline(node.content)}}${label ? `\\label{${label}}` : ""}`;
  }
  if (node.type === "blockquote") {
    const blocks = (node.content ?? []).map(serializeLatexVisualBlock);
    if (blocks.some((block) => block === null)) return null;
    return `\\begin{quote}\n${blocks.join("\n\n")}\n\\end{quote}`;
  }
  if (node.type === "latexDisplayMath") {
    if (typeof node.attrs?.numberingSource === "string")
      return serializeNumberedMath(
        { ...node.attrs, tex: String(node.attrs.tex ?? "") },
        node.attrs.numberingSource,
      );
    return latexVisualMathSource(
      {
        tex: String(node.attrs?.tex ?? ""),
        environment: node.attrs?.environment ? String(node.attrs.environment) : null,
        wrapper: node.attrs?.wrapper === "double-dollar" ? "double-dollar" : "bracket",
      },
      true,
    );
  }
  if (node.type === "latexRawBlock") return String(node.attrs?.raw ?? "");
  if (node.type === "latexRichPreview") {
    const raw = String(node.attrs?.raw ?? "");
    if (node.attrs?.editable !== true) return raw;
    if (node.attrs.kind === "bibliography" && node.attrs.sourceMeta?.externalBibliography)
      return raw;
    if (
      ["title", "toc", "pagebreak", "spacing", "documentCommand"].includes(String(node.attrs.kind))
    )
      return raw;
    if (node.attrs.kind === "part") {
      const title = typeof node.attrs.title === "string" ? node.attrs.title : null;
      const label = safeLatexLabel(node.attrs.label ?? "");
      if (title === null || label === null) return null;
      return `\\part${node.attrs.unnumbered === true ? "*" : ""}{${escapeText(title)}}${label ? `\\label{${label}}` : ""}`;
    }
    if (node.attrs.kind === "simple") {
      const environment = String(node.attrs.environment ?? "");
      const body = typeof node.attrs.body === "string" ? node.attrs.body : null;
      if (!SIMPLE_LAYOUT_ENVIRONMENTS.has(environment) || body === null) return null;
      if (["verbatim", "verbatim*", "lstlisting", "tcblisting"].includes(environment)) {
        const range = latexLiteralBlock(raw);
        if (!range || range.environment !== environment) return null;
        if (body.split(/\r?\n/u).some((line) => line.trim() === `\\end{${environment}}`))
          return null;
        const captionOption = range.options.get("caption");
        const patches = [
          {
            from: range.bodyFrom,
            to: range.bodyTo,
            value:
              body === raw.slice(range.bodyFrom, range.bodyTo)
                ? body
                : body.replace(/\r?\n/gu, raw.includes("\r\n") ? "\r\n" : "\n"),
          },
        ];
        if (environment === "tcblisting") {
          const originalTitle = range.boxTitle ? metadataText(range.boxTitle.value) : "";
          if ((node.attrs.title ?? "") !== originalTitle) {
            if (!range.boxTitle || typeof node.attrs.title !== "string") return null;
            patches.push({
              from: range.boxTitle.from,
              to: range.boxTitle.to,
              value: escapeText(node.attrs.title),
            });
          }
        }
        const originalCaption = captionOption
          ? editableTableCell(raw.slice(captionOption.from, captionOption.to), captionOption.from)
          : null;
        if ((node.attrs.caption ?? null) !== (originalCaption?.display ?? null)) {
          if (originalCaption && typeof node.attrs.caption === "string") {
            const original = raw.slice(originalCaption.from, originalCaption.to);
            const content = parseInline(original);
            if (!content) return null;
            const value = minimallyPatchedBlock(
              {
                id: "caption",
                from: 0,
                to: original.length,
                source: original,
                editable: true,
                node: { type: "paragraph", content },
              },
              {
                type: "paragraph",
                content: node.attrs.caption ? [{ type: "text", text: node.attrs.caption }] : [],
              },
            );
            if (value === null) return null;
            patches.push({ from: originalCaption.from, to: originalCaption.to, value });
          }
        }
        let result = raw;
        for (const patch of patches.sort((a, b) => b.from - a.from))
          result = result.slice(0, patch.from) + patch.value + result.slice(patch.to);
        if (environment === "lstlisting") {
          const changedCaption =
            (node.attrs.caption ?? null) !== (originalCaption?.display ?? null);
          if (changedCaption && (!originalCaption || node.attrs.caption === null)) {
            if (node.attrs.caption !== null && typeof node.attrs.caption !== "string") return null;
            const changed = setLatexEnvironmentOption(
              result,
              environment,
              "caption",
              node.attrs.caption === null ? null : `{${escapeText(node.attrs.caption)}}`,
            );
            if ("error" in changed) return null;
            result = changed.source;
          }
          const originalLabel = range.options.get("label")?.value ?? null;
          if ((node.attrs.label ?? null) !== originalLabel) {
            const label = safeLatexLabel(node.attrs.label ?? "");
            if (label === null) return null;
            const changed = setLatexEnvironmentOption(
              result,
              environment,
              "label",
              label ? `{${label}}` : null,
            );
            if ("error" in changed) return null;
            result = changed.source;
          }
        }
        return result;
      }
      const code = ["verbatim", "verbatim*", "alltt", "lstlisting"].includes(environment);
      const text = code
        ? body
        : environment === "verse"
          ? body.split("\n").map(escapeText).join(" \\\\\n")
          : escapeText(body);
      return `\\begin{${environment}}\n${text}\n\\end{${environment}}`;
    }
    if (node.attrs.kind === "bibliography") {
      const items = Array.isArray(node.attrs.items) ? node.attrs.items : null;
      const widestLabel = safeLatexArgument(node.attrs.widestLabel ?? "99");
      if (!items || widestLabel === null) return null;
      if (node.attrs.sourceMeta?.bibliographySource === true) {
        const original = parseBibliographyPreview(raw)?.attrs;
        if (!original?.editable) return null;
        const retained = original.sourceMeta.entries as {
          key: string;
          body: string;
          source: string;
        }[];
        const keys = new Set<string>();
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const entries: string[] = [];
        for (const item of items) {
          const key = safeLatexLabel(item?.label);
          if (!key || keys.has(key) || typeof item.body !== "string") return null;
          keys.add(key);
          const entry = retained.find((candidate) => candidate.key === key);
          if (entry) {
            if (entry.body === item.body) entries.push(entry.source);
            else {
              const inline = parseInline(item.body);
              const command = /^\\bibitem\s*(?:\[[^\[\]]*\]\s*)?\{[^{}]+\}/u.exec(entry.source);
              if (
                !command ||
                !inline?.every((part) => part.type === "text" || part.type === "hardBreak")
              )
                return null;
              entries.push(`${command[0]} ${item.body}${eol}`);
            }
          } else {
            // Entry contents remain source-owned until their editing interaction is designed.
            if (item.body !== "") return null;
            entries.push(`\\bibitem{${key}} ${eol}`);
          }
        }
        return (
          original.sourceMeta.header +
          entries.map((entry) => (entry.endsWith("\n") ? entry : entry + eol)).join("") +
          "\\end{thebibliography}"
        );
      }
      const entries: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || !("label" in item) || !("body" in item))
          return null;
        const key = safeLatexLabel(item.label);
        if (!key || typeof item.body !== "string") return null;
        entries.push(`\\bibitem{${key}} ${escapeText(item.body)}`);
      }
      return `\\begin{thebibliography}{${widestLabel}}\n${entries.join("\n")}\n\\end{thebibliography}`;
    }
    if (node.attrs.kind === "abstract") {
      if (typeof node.attrs.body !== "string") return null;
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      return `\\begin{abstract}${eol}${escapeText(node.attrs.body)}${eol}\\end{abstract}`;
    }
    if (node.attrs.kind === "scientific") return serializeScientificPreview(node);
    if (node.attrs.kind === "figureLayout") return serializeFigureLayout(node);
    if (node.attrs.kind === "figure") return serializeFigurePreview(node);
    if (node.attrs.kind === "description") {
      const items = Array.isArray(node.attrs.items) ? node.attrs.items : null;
      const itemIds = Array.isArray(node.attrs.itemIds) ? node.attrs.itemIds : null;
      const sourceMeta = node.attrs.sourceMeta;
      if (
        !items ||
        !itemIds ||
        items.length === 0 ||
        items.length !== itemIds.length ||
        !sourceMeta ||
        typeof sourceMeta !== "object" ||
        !("head" in sourceMeta) ||
        !("tail" in sourceMeta) ||
        !("originalItems" in sourceMeta) ||
        typeof sourceMeta.head !== "string" ||
        typeof sourceMeta.tail !== "string" ||
        !Array.isArray(sourceMeta.originalItems)
      )
        return null;
      const originals = new Map<string, Record<string, unknown>>();
      for (const candidate of sourceMeta.originalItems as unknown[]) {
        if (
          candidate &&
          typeof candidate === "object" &&
          "id" in candidate &&
          typeof candidate.id === "string"
        )
          originals.set(candidate.id, candidate as Record<string, unknown>);
      }
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const chunks: string[] = [];
      for (const [index, item] of items.entries()) {
        const id = itemIds[index];
        if (
          !item ||
          typeof item !== "object" ||
          !("label" in item) ||
          !("body" in item) ||
          typeof item.label !== "string" ||
          typeof item.body !== "string" ||
          typeof id !== "string"
        )
          return null;
        const original = originals.get(id);
        if (!original) {
          chunks.push(`\\item[${escapeText(item.label)}] ${escapeText(item.body)}${eol}`);
          continue;
        }
        if (
          !("raw" in original) ||
          !("label" in original) ||
          !("body" in original) ||
          !("labelFrom" in original) ||
          !("labelTo" in original) ||
          !("bodyFrom" in original) ||
          !("bodyTo" in original) ||
          typeof original.raw !== "string" ||
          typeof original.label !== "string" ||
          typeof original.body !== "string" ||
          typeof original.labelFrom !== "number" ||
          typeof original.labelTo !== "number" ||
          typeof original.bodyFrom !== "number" ||
          typeof original.bodyTo !== "number"
        )
          return null;
        const replacements = [
          ...(item.label === original.label
            ? []
            : [{ from: original.labelFrom, to: original.labelTo, value: escapeText(item.label) }]),
          ...(item.body === original.body
            ? []
            : [{ from: original.bodyFrom, to: original.bodyTo, value: escapeText(item.body) }]),
        ].sort((left, right) => right.from - left.from);
        let chunk = original.raw;
        for (const replacement of replacements) {
          if (
            replacement.from < 0 ||
            replacement.to < replacement.from ||
            replacement.to > chunk.length
          )
            return null;
          chunk =
            chunk.slice(0, replacement.from) + replacement.value + chunk.slice(replacement.to);
        }
        chunks.push(chunk);
      }
      return sourceMeta.head + chunks.join("") + sourceMeta.tail;
    }
    if (node.attrs.kind !== "table") return raw;
    const rows = tableRows(node.attrs.rows);
    const ranges = Array.isArray(node.attrs.cellRanges) ? node.attrs.cellRanges : null;
    const sourceMeta = node.attrs.sourceMeta;
    if (!rows) return null;
    if (sourceMeta?.longtable) {
      const meta = sourceMeta.longtable;
      if (
        !ranges ||
        rows.length !== ranges.length ||
        node.attrs.tableCanonical ||
        typeof meta.virtualRaw !== "string" ||
        !Array.isArray(meta.expansions)
      )
        return null;
      for (const [key, value] of Object.entries(meta.originalAttributes ?? {}))
        if (JSON.stringify(node.attrs[key]) !== JSON.stringify(value)) return null;
      const patches = tableMetadataPatches(node, meta.virtualRaw);
      if (patches === null) return null;
      for (const [rowIndex, row] of rows.entries()) {
        if (row.length !== ranges[rowIndex]?.length) return null;
        for (const [cellIndex, value] of row.entries()) {
          const range = ranges[rowIndex][cellIndex];
          if (range === null && value === "") continue;
          if (
            !range ||
            typeof range.from !== "number" ||
            typeof range.to !== "number" ||
            typeof range.original !== "string"
          )
            return null;
          if (value !== range.original)
            patches.push({
              from: range.from,
              to: range.to,
              value: serializeTableCellValue(
                value,
                latexTableCellIsMath(node, rowIndex, cellIndex),
              ),
            });
        }
      }
      return physicalLongTablePatches(raw, meta.virtualRaw, meta.expansions, patches);
    }
    if (sourceMeta?.preserveStructure === true) {
      const original = parseTablePreview(raw)?.attrs;
      if (!original || node.attrs.tableCanonical === true || rows.length !== original.rows.length)
        return null;
      for (const key of [
        "rowIds",
        "columnIds",
        "columnAlignments",
        "tableStyle",
        "tableKind",
        "hasHeader",
      ])
        if (JSON.stringify(node.attrs[key]) !== JSON.stringify(original[key])) return null;
      if (
        JSON.stringify(sourceMeta.tableLayout) !== JSON.stringify(original.sourceMeta.tableLayout)
      )
        return null;
    }
    if (node.attrs.tableCanonical === true) {
      if (
        !sourceMeta ||
        typeof sourceMeta !== "object" ||
        !("bodyFrom" in sourceMeta) ||
        !("bodyTo" in sourceMeta) ||
        !("openingFrom" in sourceMeta) ||
        !("openingTo" in sourceMeta) ||
        !("endingFrom" in sourceMeta) ||
        !("endingTo" in sourceMeta) ||
        !("captionRange" in sourceMeta) ||
        !("labelRange" in sourceMeta) ||
        !("hasFloat" in sourceMeta) ||
        typeof sourceMeta.bodyFrom !== "number" ||
        typeof sourceMeta.bodyTo !== "number" ||
        typeof sourceMeta.openingFrom !== "number" ||
        typeof sourceMeta.openingTo !== "number" ||
        typeof sourceMeta.endingFrom !== "number" ||
        typeof sourceMeta.endingTo !== "number" ||
        typeof sourceMeta.hasFloat !== "boolean"
      )
        return null;
      const style = ["plain", "booktabs", "grid"].includes(String(node.attrs.tableStyle))
        ? String(node.attrs.tableStyle)
        : "plain";
      const kind = ["fixed", "stretch", "long"].includes(String(node.attrs.tableKind))
        ? String(node.attrs.tableKind)
        : "fixed";
      const alignments = Array.isArray(node.attrs.columnAlignments)
        ? node.attrs.columnAlignments.map((alignment) =>
            alignment === "center" || alignment === "right" ? alignment : "left",
          )
        : [];
      if (alignments.length !== rows[0]!.length) return null;
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const environment =
        kind === "stretch" ? "tabularx" : kind === "long" ? "longtable" : "tabular";
      const columnSpec = canonicalTableColumnSpec(alignments, kind, style);
      const opening =
        kind === "stretch"
          ? `\\begin{${environment}}{\\textwidth}{${columnSpec}}`
          : `\\begin{${environment}}{${columnSpec}}`;
      const metadata = tableMetadataPatches(node, raw);
      if (metadata === null) return null;
      const replacements: { from: number; to: number; value: string }[] = [
        ...metadata,
        { from: sourceMeta.openingFrom, to: sourceMeta.openingTo, value: opening },
        {
          from: sourceMeta.bodyFrom,
          to: sourceMeta.bodyTo,
          value: canonicalTableBody(
            rows,
            style,
            node.attrs.hasHeader === true,
            eol,
            preservedTableCells(node, rows),
          ),
        },
        {
          from: sourceMeta.endingFrom,
          to: sourceMeta.endingTo,
          value: `\\end{${environment}}`,
        },
      ];
      replacements.sort((left, right) => right.from - left.from || right.to - left.to);
      let serialized = raw;
      for (const replacement of replacements) {
        if (
          replacement.from < 0 ||
          replacement.to < replacement.from ||
          replacement.to > raw.length
        )
          return null;
        serialized =
          serialized.slice(0, replacement.from) +
          replacement.value +
          serialized.slice(replacement.to);
      }
      return serialized;
    }
    if (
      !ranges ||
      rows.length < ranges.length ||
      !sourceMeta ||
      typeof sourceMeta !== "object" ||
      !("originalRowCount" in sourceMeta) ||
      !("insertAt" in sourceMeta) ||
      !("captionRange" in sourceMeta) ||
      typeof sourceMeta.originalRowCount !== "number" ||
      typeof sourceMeta.insertAt !== "number" ||
      sourceMeta.originalRowCount !== ranges.length ||
      sourceMeta.insertAt < 0 ||
      sourceMeta.insertAt > raw.length
    )
      return null;
    const replacements = tableMetadataPatches(node, raw);
    if (replacements === null) return null;
    for (const [rowIndex, row] of rows.slice(0, ranges.length).entries()) {
      const rowRanges = ranges[rowIndex];
      if (!Array.isArray(row) || !Array.isArray(rowRanges) || row.length !== rowRanges.length)
        return null;
      for (const [cellIndex, value] of row.entries()) {
        const range = rowRanges[cellIndex];
        if (range === null && sourceMeta.preserveStructure === true && value === "") continue;
        if (
          !range ||
          typeof range !== "object" ||
          !("from" in range) ||
          !("to" in range) ||
          !("original" in range) ||
          typeof range.from !== "number" ||
          typeof range.to !== "number" ||
          typeof range.original !== "string" ||
          range.from < 0 ||
          range.to < range.from ||
          range.to > raw.length ||
          typeof value !== "string"
        )
          return null;
        if (value === range.original) continue;
        const escaped = serializeTableCellValue(
          value,
          latexTableCellIsMath(node, rowIndex, cellIndex),
        );
        const needsRuleSeparator =
          range.from === range.to &&
          /\\(?:toprule|midrule|bottomrule|hline)$/u.test(raw.slice(0, range.from));
        replacements.push({
          from: range.from,
          to: range.to,
          value: needsRuleSeparator && escaped ? ` ${escaped}` : escaped,
        });
      }
    }
    const width = Array.isArray(rows[0]) ? rows[0].length : 0;
    const addedRows = rows.slice(ranges.length);
    if (width === 0) return null;
    if (addedRows.length > 0) {
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const lines: string[] = [];
      for (const row of addedRows) {
        if (
          !Array.isArray(row) ||
          row.length !== width ||
          row.some((cell) => typeof cell !== "string")
        )
          return null;
        lines.push(`${row.map((cell) => serializeTableCellValue(cell)).join(" & ")} \\\\`);
      }
      replacements.push({
        from: sourceMeta.insertAt,
        to: sourceMeta.insertAt,
        value: `${eol}${lines.join(eol)}`,
      });
    }
    replacements.sort((left, right) => right.from - left.from);
    let serialized = raw;
    for (const replacement of replacements)
      serialized =
        serialized.slice(0, replacement.from) +
        replacement.value +
        serialized.slice(replacement.to);
    return serialized;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const environment = node.type === "bulletList" ? "itemize" : "enumerate";
    const items = (node.content ?? []).map((item) => {
      const children = (item.content ?? []).map(serializeLatexVisualBlock);
      if (children.some((child) => child === null)) return null;
      return `\\item ${children.join("\n\n")}`;
    });
    if (items.some((item) => item === null)) return null;
    const start = Number(node.attrs?.start ?? 1);
    if (!Number.isSafeInteger(start) || start < 1) return null;
    const options =
      environment !== "enumerate"
        ? ""
        : latexListOptionsSource(node.attrs?.latexListOptions, start, node.attrs?.resume === true);
    if (options === null) return null;
    return `\\begin{${environment}}${options}\n${items.join("\n")}\n\\end{${environment}}`;
  }
  return null;
}

interface ComparableVisualNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly ComparableVisualNode[];
  readonly content?: readonly ComparableVisualNode[];
}

function comparableNode(node: JSONContent): ComparableVisualNode {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {})
      .map(
        ([key, value]) =>
          [
            key,
            key === "latexListOptions"
              ? (parseLatexListOptions(String(value ?? ""))?.label ?? null)
              : value,
          ] as const,
      )
      .filter(([key, value]) => {
        if (
          key === "sourceId" ||
          (node.type === "latexInlineCommand" && key === "raw") ||
          (node.type === "latexScientific" && (key === "raw" || key === "titleSource")) ||
          (node.type === "latexDisplayMath" && key === "numberingSource") ||
          key === "latexCommand" ||
          (node.type === "latexRichPreview" &&
            (key === "raw" ||
              key === "cellRanges" ||
              key === "editable" ||
              key === "sourceMeta" ||
              key === "tocEntries" ||
              key === "itemIds" ||
              key === "rowIds" ||
              key === "columnIds" ||
              key === "tableCanonical" ||
              (node.attrs?.kind === "table" && key === "hasHeader") ||
              (node.attrs?.kind === "figure" && key === "figureOptions") ||
              (node.attrs?.kind !== "figure" &&
                (key === "path" ||
                  key === "figureWidth" ||
                  key === "figureOptions" ||
                  key === "figurePlacement" ||
                  key === "figureAlignment" ||
                  key === "figureCaptionPosition" ||
                  key === "figureStarred")) ||
              (!["scientific", "simple", "spacing", "toc", "documentCommand"].includes(
                String(node.attrs?.kind),
              ) &&
                key === "environment") ||
              (!["scientific", "title", "part"].includes(String(node.attrs?.kind)) &&
                !(node.attrs?.kind === "simple" && node.attrs?.environment === "tcblisting") &&
                key === "title") ||
              (!["scientific", "abstract", "simple", "documentCommand"].includes(
                String(node.attrs?.kind),
              ) &&
                key === "body") ||
              (node.attrs?.kind !== "bibliography" && key === "widestLabel") ||
              (node.attrs?.kind !== "title" &&
                ["author", "authorEnabled", "date", "dateEnabled", "dateMode"].includes(key)) ||
              (node.attrs?.kind !== "description" &&
                ["descriptionStyle", "descriptionLeftMargin"].includes(key)) ||
              (node.attrs?.kind !== "table" &&
                (key === "columnAlignments" ||
                  key === "tableStyle" ||
                  key === "tableKind" ||
                  key === "hasHeader")))) ||
          value === null ||
          value === undefined
        )
          return false;
        if (
          (key === "unnumbered" ||
            key === "resume" ||
            key === "latexNoIndent" ||
            key === "captionRemoved" ||
            key === "titleRemoved") &&
          value === false
        )
          return false;
        if (key === "referenceLabel" && value === "") return false;
        if (key === "start" && value === 1) return false;
        if (key === "wrapper" && (value === "paren" || value === "bracket")) return false;
        return true;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const content: ComparableVisualNode[] = [];
  for (const child of node.content ?? []) {
    const item = comparableNode(child);
    const last = content.at(-1);
    if (
      last?.type === "text" &&
      item.type === "text" &&
      JSON.stringify(last.marks) === JSON.stringify(item.marks)
    ) {
      content[content.length - 1] = { ...last, text: (last.text ?? "") + (item.text ?? "") };
    } else content.push(item);
  }
  const marks =
    node.marks?.map(comparableNode).sort((a, b) => (a.type ?? "").localeCompare(b.type ?? "")) ??
    [];
  return {
    ...(node.type === undefined ? {} : { type: node.type }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(Object.keys(attrs).length === 0 ? {} : { attrs }),
    ...(marks.length === 0 ? {} : { marks }),
    ...(content.length === 0 ? {} : { content }),
  };
}

const nodeSignatures = new WeakMap<JSONContent, string>();
export function latexVisualNodeSignature(node: JSONContent): string {
  const cached = nodeSignatures.get(node);
  if (cached !== undefined) return cached;
  // Retained source also owns properties which do not change visible text:
  // colors, spans, caption position, listing options and citation notes.
  // Ordinary field edits keep that snapshot; explicit property operations replace it.
  const retained = (value: JSONContent): unknown => [
    ["latexRichPreview", "latexScientific", "latexInlineCommand"].includes(value.type ?? "")
      ? (value.attrs?.raw ?? null)
      : null,
    value.content?.map(retained) ?? [],
  ];
  const signature = JSON.stringify([comparableNode(node), retained(node)]);
  nodeSignatures.set(node, signature);
  return signature;
}

/** TeX collapses ordinary whitespace. Keep the live editor's whitespace in its
 * session projection, while checking structural round trips using TeX semantics. */
const roundTripSignatures = new WeakMap<JSONContent, string>();
function roundTripSignature(node: JSONContent): string {
  const cached = roundTripSignatures.get(node);
  if (cached !== undefined) return cached;
  const prose = (text: string) =>
    text
      .replace(/---/gu, "\u2014")
      .replace(/--/gu, "\u2013")
      .replace(/[\t\r\n ]+/gu, " ");
  const normalize = (value: JSONContent): JSONContent => {
    const children = value.content?.map(normalize);
    if (children) {
      for (const [index, child] of children.entries()) {
        if (child.type !== "text") continue;
        let text = child.text ?? "";
        if (index === 0) text = text.trimStart();
        if (index === children.length - 1) text = text.trimEnd();
        child.text = text;
      }
    }
    return {
      ...value,
      ...(value.type === "latexScientific" && value.attrs
        ? {
            attrs: {
              ...value.attrs,
              titleRemoved: false,
              ...(value.attrs.layout?.kind === "colorBox"
                ? {
                    title:
                      metadataText(escapeText(String(value.attrs.title ?? ""))) ??
                      value.attrs.title,
                  }
                : {}),
            },
          }
        : {}),
      ...(value.type === "latexDisplayMath" && value.attrs?.numberingSource
        ? {
            attrs: {
              ...value.attrs,
              tex: projectMathNumbering(String(value.attrs.tex ?? ""))?.tex ?? value.attrs.tex,
            },
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs
        ? {
            attrs: Object.fromEntries(
              Object.entries(value.attrs).map(([key, item]) => [
                key,
                key === "captionRemoved" || key === "titleRemoved"
                  ? false
                  : key === "figureCaptionPosition" &&
                      value.attrs?.kind === "figure" &&
                      !latexVisualFloatHasCaption(value)
                    ? "below"
                    : ["title", "author", "date", "caption", "body"].includes(key) &&
                        typeof item === "string"
                      ? key === "author" && value.attrs?.authorEnabled === false
                        ? ""
                        : value.attrs?.kind === "simple" &&
                            ["verbatim", "verbatim*", "alltt", "lstlisting", "tcblisting"].includes(
                              String(value.attrs.environment),
                            )
                          ? value.attrs?.sourceMeta?.literal === true && key === "body"
                            ? item.replace(/\r\n/gu, "\n")
                            : key === "caption"
                              ? prose(item).trim()
                              : item
                          : prose(item).trim()
                      : item,
              ]),
            ),
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs?.kind === "table"
        ? {
            attrs: {
              ...value.attrs,
              // Removal is an editing intent; its source representation is
              // the absence of a caption, not a serialized attribute.
              captionRemoved: false,
              // The live cell keeps exactly what was typed. Compare the
              // reparsed TeX using its whitespace semantics, just like prose.
              ...(Array.isArray(value.attrs.rows)
                ? {
                    // Header status is inferred from rules and cell formatting.
                    // Compare the actual inline content, including formatting
                    // added explicitly by a structural header operation.
                    rows: (value.attrs.tableCanonical
                      ? preservedTableCells(value, value.attrs.rows)
                      : value.attrs.rows
                    ).map((row: unknown) =>
                      Array.isArray(row)
                        ? row.map((cell: unknown) =>
                            typeof cell === "string"
                              ? comparableNode(
                                  normalize({
                                    type: "paragraph",
                                    content:
                                      latexTableInlineContent(serializeTableCellValue(cell)) ?? [],
                                  }),
                                )
                              : cell,
                          )
                        : row,
                    ),
                  }
                : {}),
              ...(typeof value.attrs.caption === "string"
                ? { caption: prose(value.attrs.caption).trim() }
                : {}),
            },
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs?.kind === "figureLayout"
        ? {
            attrs: {
              ...value.attrs,
              ...(typeof value.attrs.caption === "string"
                ? { caption: prose(value.attrs.caption).trim() }
                : {}),
              items: Array.isArray(value.attrs.items)
                ? value.attrs.items.map((item: Record<string, unknown>) =>
                    Object.fromEntries(
                      Object.entries(item).map(([key, text]) => [
                        key,
                        typeof text === "string" ? prose(text).trim() : text,
                      ]),
                    ),
                  )
                : value.attrs.items,
            },
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs?.kind === "bibliography"
        ? {
            attrs: {
              ...value.attrs,
              items: Array.isArray(value.attrs.items)
                ? value.attrs.items.map((item: unknown) =>
                    item &&
                    typeof item === "object" &&
                    "body" in item &&
                    typeof item.body === "string"
                      ? { ...item, body: prose(item.body).trim() }
                      : item,
                  )
                : value.attrs.items,
            },
          }
        : {}),
      ...(value.text === undefined ? {} : { text: prose(value.text) }),
      ...(children
        ? { content: children.filter((child) => child.type !== "text" || child.text !== "") }
        : {}),
    };
  };
  const signature = JSON.stringify(comparableNode(normalize(node)));
  roundTripSignatures.set(node, signature);
  return signature;
}

export function adoptLatexVisualContent(
  source: string,
  content: JSONContent,
  parsed = projectLatexVisualDocument(source),
): LatexVisualDocument {
  return {
    ...parsed,
    content,
    ...(parsed.generated
      ? {
          generated: {
            ...parsed.generated,
            virtual: adoptLatexVisualContent(
              parsed.generated.virtual.source,
              content,
              parsed.generated.virtual,
            ),
          },
        }
      : {}),
    blocks: parsed.blocks.map((block, index) => ({
      ...block,
      node: content.content?.[index] ?? block.node,
    })),
  };
}

function scientificEnvironments(content: readonly JSONContent[]): Set<string> {
  return new Set(
    content
      .flatMap((node) => [
        ...((node.type === "latexRichPreview" && node.attrs?.kind === "scientific") ||
        node.type === "latexScientific"
          ? [String(node.attrs?.environment ?? "")]
          : []),
        ...scientificEnvironments(node.content ?? []),
      ])
      .filter((environment) => SCIENTIFIC_ENVIRONMENTS.has(environment)),
  );
}

function ensureScientificEnvironmentDeclarations(
  source: string,
  environments: ReadonlySet<string>,
  eol: string,
): string {
  if (environments.size === 0) return source;
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (begin < 0) return source;
  const preamble = source.slice(0, begin).replace(/(?<!\\)%[^\r\n]*/gu, "");
  const declarations: string[] = [];
  for (const environment of environments) {
    if (environment === "abstract") continue;
    const declared = new RegExp(
      `\\\\(?:newtheorem|newenvironment)\\*?\\s*\\{${environment}\\}`,
      "u",
    ).test(preamble);
    if (
      declared ||
      (environment === "proof" &&
        /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\bamsthm\b[^{}]*\}/u.test(
          preamble,
        ))
    )
      continue;
    if (environment === "proof") {
      declarations.push(
        "\\newenvironment{proof}{\\par\\noindent\\textit{Proof.}\\ }{\\hfill\\rule{0.6em}{0.6em}\\par}",
      );
      continue;
    }
    const label = environment[0]!.toUpperCase() + environment.slice(1);
    declarations.push(`\\newtheorem{${environment}}{${label}}`);
  }
  if (declarations.length === 0) return source;
  const boundary = begin > 0 && !/[\r\n]/u.test(source[begin - 1]!) ? eol : "";
  const insertion = [`% Scient visual statement environments`, ...declarations, ""].join(eol);
  return source.slice(0, begin) + boundary + insertion + source.slice(begin);
}

function requiredObjectPackages(nodes: readonly JSONContent[]): Set<string> {
  const packages = new Set<string>();
  for (const node of nodes) {
    if (node.attrs?.layout?.kind === "algorithm") {
      if (node.attrs.layout.floating !== false) packages.add("algorithm");
      packages.add("algpseudocode");
    }
    if (node.attrs?.layout?.kind === "colorBox") {
      packages.add("tcolorbox");
      packages.add("xcolor");
    }
    if (node.attrs?.layout?.kind === "colorBox" && node.attrs.layout.breakable)
      packages.add("tcolorbox-breakable");
    if (node.attrs?.layout?.kind === "columns") packages.add("multicol");
    if (node.marks?.some((mark) => ["latexColor", "latexBackground"].includes(mark.type)))
      packages.add("xcolor");
    if (node.attrs?.kind === "figure") {
      packages.add("graphicx");
      if (String(node.attrs.figurePlacement ?? "").includes("H")) packages.add("float");
    }
    if (node.attrs?.kind === "table") {
      if (/\\begin\{table\*?\}\[[^\]]*H/u.test(String(node.attrs.raw ?? ""))) packages.add("float");
      if (node.attrs.tableStyle === "booktabs") packages.add("booktabs");
      if (node.attrs.tableKind === "stretch") packages.add("tabularx");
      if (node.attrs.tableKind === "long") packages.add("longtable");
    }
    if (
      node.attrs?.kind === "description" &&
      (node.attrs.descriptionStyle === "nextline" || node.attrs.descriptionLeftMargin)
    )
      packages.add("enumitem");
    if (
      node.type === "orderedList" &&
      (node.attrs?.resume === true ||
        Number(node.attrs?.start ?? 1) !== 1 ||
        node.attrs?.latexListOptions)
    )
      packages.add("enumitem");
    if (node.attrs?.kind === "simple" && node.attrs.environment === "alltt") packages.add("alltt");
    if (node.attrs?.kind === "simple" && node.attrs.environment === "lstlisting")
      packages.add("listings");
    if (node.type === "latexInlineCommand") {
      if (node.attrs?.name === "eqref") packages.add("amsmath");
      if (["autoref", "href", "url"].includes(String(node.attrs?.name))) packages.add("hyperref");
    }
    requiredObjectPackages(node.content ?? []).forEach((name) => packages.add(name));
  }
  return packages;
}

function ensureMathSymbolDefinitions(source: string, nextMath: string, eol: string): string {
  const { preamble, end } = latexPackageInventory(source);
  // wasysym's nointegrals option leaves these variants under private names.
  const definitions = ["varint", "varoint"]
    .filter(
      (name) =>
        new RegExp(`\\\\${name}\\b`, "u").test(nextMath) &&
        !preamble.includes(`\\providecommand{\\${name}}`),
    )
    .map((name) => `\\providecommand{\\${name}}{\\csname wasy@${name.slice(3)}\\endcsname}${eol}`)
    .join("");
  if (!definitions) return source;
  const boundary = end > 0 && !/[\r\n]/u.test(source[end - 1]!) ? eol : "";
  return source.slice(0, end) + boundary + definitions + source.slice(end);
}

function setPreambleCommandArgument(
  source: string,
  command: string,
  value: string,
  eol: string,
): string | null {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (begin < 0) return null;
  const range = latexTitleDeclarations(source).get(command);
  if (range) return source.slice(0, range.from) + value + source.slice(range.to);
  return replaceOrInsertPreambleLine(
    source,
    new RegExp("(?!)", "u"),
    `\\${command}{${value}}`,
    begin,
    eol,
  );
}

function updateTitleMetadata(
  source: string,
  previous: JSONContent,
  node: JSONContent,
): string | null {
  if (
    typeof node.attrs?.title !== "string" ||
    typeof node.attrs?.author !== "string" ||
    typeof node.attrs?.authorEnabled !== "boolean" ||
    typeof node.attrs?.date !== "string" ||
    typeof node.attrs?.dateEnabled !== "boolean" ||
    !["default", "today", "explicit", "hidden"].includes(String(node.attrs?.dateMode))
  )
    return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let changed = source;
  const authorSource = node.attrs.author.split(/\r?\n/u).map(escapeText).join(`\\\\${eol}`);
  if (node.attrs.title !== previous.attrs?.title)
    changed =
      setPreambleCommandArgument(
        changed,
        "title",
        node.attrs.title.split(/\r?\n/u).map(escapeText).join(`\\\\${eol}`),
        eol,
      ) ?? changed;
  if (
    node.attrs.authorEnabled !== previous.attrs?.authorEnabled ||
    node.attrs.author !== previous.attrs?.author
  ) {
    const begin = findDelimiter(changed, "\\begin{document}", 0);
    if (begin < 0) return null;
    changed = changed.slice(0, begin).replace(HIDDEN_AUTHOR_COMMENT, "") + changed.slice(begin);
    changed =
      setPreambleCommandArgument(
        changed,
        "author",
        node.attrs.authorEnabled ? authorSource : "",
        eol,
      ) ?? changed;
  }
  if (
    node.attrs.dateMode !== previous.attrs?.dateMode ||
    (node.attrs.dateMode === "explicit" && node.attrs.date !== previous.attrs?.date)
  ) {
    const dateValue =
      node.attrs.dateMode === "hidden"
        ? ""
        : node.attrs.dateMode === "today" || node.attrs.dateMode === "default"
          ? "\\today"
          : escapeText(node.attrs.date);
    changed = setPreambleCommandArgument(changed, "date", dateValue, eol) ?? changed;
  }
  return changed;
}

interface InlineSourceUnit {
  key: string;
  node: JSONContent;
  from: number;
  to: number;
  marks: readonly string[];
  wrappers: readonly string[];
}

export interface LatexInlineEditingScope {
  readonly from: number;
  readonly to: number;
  readonly mark: string;
  readonly attrs?: Record<string, unknown>;
  readonly depth: number;
}

/** Read authored wrapper boundaries without adding editor metadata to the source. */
export function latexInlineEditingScopes(
  source: string,
): readonly LatexInlineEditingScope[] | null {
  const read = (
    text: string,
    marks: readonly string[],
    scoped: boolean,
    depth: number,
  ): { size: number; scopes: LatexInlineEditingScope[] } | null => {
    let size = 0;
    let currentMarks = marks;
    const scopes: LatexInlineEditingScope[] = [];
    for (let at = 0; at < text.length;) {
      const colored = latexInlineColor(text, at);
      if (colored) {
        const children = read(colored.body.value, currentMarks, scoped, depth + 1);
        if (!children) return null;
        scopes.push({
          from: size,
          to: size + children.size,
          mark: colored.attrs.command === "textcolor" ? "latexColor" : "latexBackground",
          attrs: colored.attrs,
          depth,
        });
        scopes.push(
          ...children.scopes.map((scope) => ({
            ...scope,
            from: size + scope.from,
            to: size + scope.to,
          })),
        );
        size += children.size;
        at = colored.body.end;
        continue;
      }
      const piece = inlinePiece(text, at, currentMarks, scoped);
      if (!piece) return null;
      if (piece.declaration) currentMarks = withLatexTextMark(currentMarks, piece.declaration);
      else if (piece.group) {
        const group = piece.group;
        const children = read(text.slice(group.from, group.to), group.marks, true, depth + 1);
        if (!children) return null;
        const command = /^\\([A-Za-z]+)/u.exec(group.prefix)?.[1];
        const mark = command
          ? LATEX_INLINE_MARKS[command]
          : group.marks.find((name) => !currentMarks.includes(name));
        if (mark) scopes.push({ from: size, to: size + children.size, mark, depth });
        scopes.push(
          ...children.scopes.map((scope) => ({
            ...scope,
            from: size + scope.from,
            to: size + scope.to,
          })),
        );
        size += children.size;
      } else if (piece.node)
        size += piece.node.type === "text" ? (piece.node.text?.length ?? 0) : 1;
      at = piece.end;
    }
    return { size, scopes };
  };
  return read(source, [], false, 0)?.scopes ?? null;
}

/** A source map for supported inline content, including TeX whitespace and aliases. */
function inlineSourceUnits(
  source: string,
  offset = 0,
  marks: readonly string[] = [],
  wrappers: readonly string[] = [],
  scoped = false,
): InlineSourceUnit[] | null {
  const units: InlineSourceUnit[] = [];
  let currentMarks = marks;
  let currentWrappers = wrappers;
  for (let at = 0; at < source.length;) {
    const color = latexInlineColor(source, at);
    if (color) {
      const type = color.attrs.command === "textcolor" ? "latexColor" : "latexBackground";
      const children = inlineSourceUnits(
        color.body.value,
        offset + color.body.from,
        currentMarks,
        [...currentWrappers, source.slice(at, color.body.from)],
        scoped,
      );
      if (!children) return null;
      for (const child of children) {
        const node = {
          ...child.node,
          marks: [{ type, attrs: color.attrs }, ...(child.node.marks ?? [])],
        };
        units.push({
          ...child,
          node,
          key: latexVisualNodeSignature(node),
          marks: [type, ...child.marks],
        });
      }
      at = color.body.end;
      continue;
    }
    const piece = inlinePiece(source, at, currentMarks, scoped);
    if (!piece) return null;
    if (piece.ignored) {
      at = piece.end;
      continue;
    }
    if (piece.declaration) {
      currentMarks = withLatexTextMark(currentMarks, piece.declaration);
      currentWrappers = [
        ...currentWrappers.slice(0, -1),
        currentWrappers.at(-1)! + source.slice(at, piece.end),
      ];
      at = piece.end;
      continue;
    }
    if (piece.group) {
      const group = piece.group;
      const children = inlineSourceUnits(
        source.slice(group.from, group.to),
        offset + group.from,
        group.marks,
        [...currentWrappers, group.prefix],
        true,
      );
      if (!children) return null;
      units.push(...children);
    } else {
      const node = piece.node!;
      units.push({
        key: latexVisualNodeSignature(node),
        node,
        from: offset + at,
        to: offset + piece.end,
        marks: currentMarks,
        wrappers: currentWrappers,
      });
    }
    at = piece.end;
  }
  return units;
}

function inlineEditorUnits(nodes: readonly JSONContent[]): JSONContent[] {
  return nodes.flatMap((node) =>
    node.type === "text"
      ? Array.from(textGraphemes.segment(node.text ?? ""), ({ segment: text }) => ({
          ...node,
          text,
        }))
      : [node],
  );
}

/** A paragraph split keeps each surviving token's original TeX spelling. */
function splitParagraphSource(
  block: LatexVisualSourceBlock,
  next: readonly JSONContent[],
): string[] | null {
  if (
    block.node.type !== "paragraph" ||
    next.length < 2 ||
    next.some((node) => node.type !== "paragraph")
  )
    return null;
  const units = inlineSourceUnits(block.source);
  if (!units) return null;
  let at = 0;
  const results: string[] = [];
  for (const node of next) {
    const desired = inlineEditorUnits(node.content ?? []);
    let value = "";
    let wrappers: readonly string[] = [];
    for (const child of desired) {
      const key = latexVisualNodeSignature(child);
      // Enter consumes boundary whitespace, which must not migrate into a wrapper.
      while (
        units[at]?.key !== key &&
        units[at]?.node.type === "text" &&
        /^\s+$/u.test(units[at]!.node.text ?? "")
      )
        at++;
      const unit = units[at++];
      if (!unit || unit.key !== key) return null;
      let shared = 0;
      while (
        shared < wrappers.length &&
        shared < unit.wrappers.length &&
        wrappers[shared] === unit.wrappers[shared]
      )
        shared++;
      value += "}".repeat(wrappers.length - shared);
      value += unit.wrappers.slice(shared).join("");
      value += block.source.slice(unit.from, unit.to);
      wrappers = unit.wrappers;
    }
    value += "}".repeat(wrappers.length);
    results.push(value || "\\par");
  }
  if (
    units
      .slice(at)
      .some((unit) => unit.node.type !== "text" || !/^\s*$/u.test(unit.node.text ?? ""))
  )
    return null;
  return results;
}

function minimallyPatchedBlock(block: LatexVisualSourceBlock, next: JSONContent): string | null {
  const noIndentPrefix =
    block.node.type === "paragraph" && block.node.attrs?.latexNoIndent && next.attrs?.latexNoIndent
      ? /^\s*\\noindent\b\s*/u.exec(block.source)
      : null;
  if (noIndentPrefix) {
    const value = minimallyPatchedBlock(
      {
        ...block,
        source: block.source.slice(noIndentPrefix[0].length),
        node: { ...block.node, attrs: { ...block.node.attrs, latexNoIndent: false } },
      },
      { ...next, attrs: { ...next.attrs, latexNoIndent: false } },
    );
    return value === null ? null : noIndentPrefix[0] + value;
  }
  if (block.node.type !== next.type || !["paragraph", "heading"].includes(next.type ?? ""))
    return null;
  if (
    latexVisualNodeSignature({ ...block.node, content: [] }) !==
    latexVisualNodeSignature({ ...next, content: [] })
  )
    return null;
  const heading =
    next.type === "heading"
      ? /^\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/u.exec(
          block.source,
        )
      : null;
  const plain = (block.node.content ?? []).every(
    (node) => node.type === "text" && !node.marks?.length,
  )
    ? (block.node.content ?? []).map((node) => node.text ?? "").join("")
    : null;
  const trimmed: readonly [number, number] =
    plain !== null && block.source === escapeText(plain)
      ? [0, block.source.length]
      : trimSourceRange(block.source, 0, block.source.length);
  const from = heading?.[0].length ?? trimmed[0];
  const to = heading ? closingBrace(block.source, from - 1) : trimmed[1];
  if (to === null) return null;
  // Plain prose needs no per-character LaTeX tokenization. Keep the general
  // mapper for commands, marks, nonbreaking spaces and original TeX spelling.
  const plainText = (nodes: readonly JSONContent[] | undefined) =>
    (nodes ?? []).every((node) => node.type === "text" && !node.marks?.length)
      ? (nodes ?? []).map((node) => node.text ?? "").join("")
      : null;
  const before = plainText(block.node.content);
  const after = plainText(next.content);
  if (before !== null && after !== null && block.source.slice(from, to) === escapeText(before))
    return block.source.slice(0, from) + escapeText(after) + block.source.slice(to);
  const oldUnits = inlineSourceUnits(block.source.slice(from, to), from);
  if (!oldUnits) return null;
  const nextUnits = inlineEditorUnits(next.content ?? []);
  const keys = nextUnits.map(latexVisualNodeSignature);
  let prefix = 0;
  while (prefix < oldUnits.length && prefix < keys.length && oldUnits[prefix]!.key === keys[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < oldUnits.length - prefix &&
    suffix < keys.length - prefix &&
    oldUnits.at(-1 - suffix)!.key === keys.at(-1 - suffix)
  )
    suffix++;
  const oldEnd = oldUnits.length - suffix;
  const changed = nextUnits.slice(prefix, keys.length - suffix);
  const left = oldUnits[prefix - 1];
  const right = oldUnits[oldEnd];
  const starts = prefix < oldEnd ? [oldUnits[prefix]!.from] : [left?.to ?? from, right?.from ?? to];
  const ends = prefix < oldEnd ? [oldUnits[oldEnd - 1]!.to] : starts;
  // At a pure insertion, the left endpoint can still be inside its formatting
  // command. Prefer that context before wrapping the inserted text again.
  const contexts =
    prefix === oldEnd
      ? [left?.marks ?? [], right?.marks ?? [], []]
      : [oldUnits[prefix]?.marks ?? [], left?.marks ?? [], right?.marks ?? [], []];
  for (const start of starts)
    for (const end of ends)
      for (const context of contexts) {
        if (
          start > end ||
          changed.some((node) =>
            context.some((mark) => !node.marks?.some((item) => item.type === mark)),
          )
        )
          continue;
        const inserted = serializeInline(
          changed.map((node) => ({
            ...node,
            marks: (node.marks ?? []).filter((mark) => !context.includes(mark.type)),
          })),
        );
        const before = block.source.slice(0, start);
        const delimiter =
          /\\[A-Za-z]+$/u.test(before) && /^[A-Za-z\t\r\n ]/u.test(inserted) ? "{}" : "";
        const preserved = preserveSourceComments(
          block.source.slice(start, end),
          inserted,
          block.source.includes("\r\n") ? "\r\n" : "\n",
          block.source.slice(end),
        );
        const candidate = before + delimiter + preserved + block.source.slice(end);
        const reparsed = classifyBlock(candidate, 0);
        if (reparsed && roundTripSignature(reparsed) === roundTripSignature(next)) return candidate;
      }
  return null;
}

function patchScientificStructure(
  block: LatexVisualSourceBlock,
  next: JSONContent,
  rootSource: string | null,
  setup: LatexVisualSetup,
): string | null {
  if (next.type !== "latexScientific") return null;
  const ranges = scientificSourceRanges(block.source, setup);
  const environment = safeLatexArgument(next.attrs?.environment);
  const title = next.attrs?.title;
  if (
    !ranges ||
    !environment ||
    setup.declarations.unsupported.has(environment) ||
    (!SCIENTIFIC_ENVIRONMENTS.has(environment) &&
      !setup.declarations.environments.has(environment)) ||
    typeof title !== "string" ||
    (title !== (ranges.title?.display ?? "") && /[\[\]]/u.test(title)) ||
    (setup.declarations.environments.get(environment)?.kind === "quote" && title !== "")
  )
    return null;
  const originalBody = block.source.slice(ranges.from, ranges.to);
  const body = applyLatexVisualDocumentChange(
    originalBody,
    projectLatexVisualDocument(originalBody, 0, setup),
    {
      type: "doc",
      content: next.content ?? [],
    },
    { rootSource, allowRootUpdates: true },
  );
  if (!body) return null;
  let changedBody = body.source;
  const eol = block.source.includes("\r\n") ? "\r\n" : "\n";
  if (!originalBody.trim() && changedBody.trim() && !/[\r\n]$/u.test(changedBody))
    changedBody += eol;
  let head = block.source.slice(0, ranges.from);
  if (title !== (ranges.title?.display ?? "") || next.attrs?.titleRemoved === true) {
    if (ranges.titleRange && !title) {
      head =
        head.slice(0, ranges.titleRange.from - 1) +
        preserveSourceComments(
          head.slice(ranges.titleRange.from, ranges.titleRange.to),
          "",
          eol,
          head.slice(ranges.titleRange.end),
        ) +
        head.slice(ranges.titleRange.end);
    } else if (ranges.title) {
      const raw = head.slice(ranges.title.from, ranges.title.to);
      const content = parseInline(raw);
      const patched =
        content &&
        minimallyPatchedBlock(
          { ...block, source: raw, node: { type: "paragraph", content } },
          {
            type: "paragraph",
            content: title ? [{ type: "text", text: title }] : [],
          },
        );
      if (patched === null || patched === undefined) return null;
      head = head.slice(0, ranges.title.from) + patched + head.slice(ranges.title.to);
    } else if (title) head += "[" + escapeText(title) + "]";
  }
  head = head.slice(0, 7) + environment + head.slice(7 + ranges.environment.length);
  return head + changedBody + "\\end{" + environment + "}";
}

function patchRichTextBlock(block: LatexVisualSourceBlock, next: JSONContent): string | null {
  if (block.node.type !== "latexRichPreview" || next.type !== block.node.type) return null;
  const original = parseRichPreview(block.source, block.source);
  if (!original?.attrs?.editable || original.attrs.kind !== next.attrs?.kind) return null;
  const kind = String(original.attrs.kind);
  if (kind !== "scientific" && kind !== "abstract") return null;
  const meta = original.attrs.sourceMeta;
  if (!meta || typeof meta !== "object") return null;
  const patches: { from: number; to: number; value: string }[] = [];
  for (const field of kind === "scientific" ? ["body", "title"] : ["body"]) {
    const value = next.attrs?.[field];
    if (typeof value !== "string") return null;
    if (
      value === original.attrs[field] &&
      !(field === "title" && next.attrs?.titleRemoved === true)
    )
      continue;
    const range = meta[field + "Range"];
    if (!range) {
      if (field !== "title") return null;
      if (!value) continue;
      patches.push({
        from: meta.openingTo,
        to: meta.openingTo,
        value: "[" + escapeText(value) + "]",
      });
      continue;
    }
    const raw = block.source.slice(range.from, range.to);
    if (field === "title" && !value) {
      const argument = optionalArgumentRange(
        block.source,
        String(original.attrs.environment).length + 8,
      );
      if (!argument) return null;
      patches.push({
        from: argument.from - 1,
        to: argument.end,
        value: preserveSourceComments(
          argument.source,
          "",
          block.source.includes("\r\n") ? "\r\n" : "\n",
          block.source.slice(argument.end),
        ),
      });
      continue;
    }
    const content = parseInline(raw);
    if (!content) return null;
    const changed = minimallyPatchedBlock(
      { ...block, source: raw, node: { type: "paragraph", content } },
      { type: "paragraph", content: value ? [{ type: "text", text: value }] : [] },
    );
    if (changed === null) return null;
    patches.push({ from: range.from, to: range.to, value: changed });
  }
  if (kind === "scientific") {
    const environment = safeLatexArgument(next.attrs?.environment);
    const label = safeLatexLabel(next.attrs?.label ?? "");
    if (!environment || !SCIENTIFIC_ENVIRONMENTS.has(environment) || label === null) return null;
    if (environment !== original.attrs.environment) {
      const old = String(original.attrs.environment);
      patches.push(
        { from: 7, to: 7 + old.length, value: environment },
        { from: meta.endingFrom + 5, to: meta.endingFrom + 5 + old.length, value: environment },
      );
    }
    if (label !== original.attrs.label) {
      const range = meta.labelCommandRange;
      if (range)
        patches.push(
          label
            ? { from: range.argumentFrom, to: range.argumentTo, value: label }
            : { from: range.from, to: range.to, value: "" },
        );
      else if (label) {
        const eol = block.source.includes("\r\n") ? "\r\n" : "\n";
        patches.push({
          from: meta.openingTo,
          to: meta.openingTo,
          value: eol + "\\label{" + label + "}",
        });
      }
    }
  }
  const ordered = patches
    .map((patch, order) => ({ ...patch, order }))
    .sort((left, right) => right.from - left.from || right.order - left.order);
  let changed = block.source;
  let boundary = block.source.length;
  for (const patch of ordered) {
    if (patch.from < 0 || patch.to > boundary || patch.to < patch.from) return null;
    changed = changed.slice(0, patch.from) + patch.value + changed.slice(patch.to);
    boundary = patch.from;
  }
  return changed;
}

export function applyLatexVisualDocumentChange(
  source: string,
  projection: LatexVisualDocument,
  nextContent: JSONContent,
  context?: {
    rootSource?: string | null;
    allowRootUpdates?: boolean;
    onMissingRequirement?: (message: string) => void;
  },
): {
  source: string;
  structural: boolean;
  projection: LatexVisualDocument;
  rootUpdate?: LatexRootUpdate;
  origin?: number;
  materializedGenerator?: boolean;
} | null {
  if (projection.source !== source) return null;
  if (projection.generated || projection.generatedOrigins?.length) {
    if (latexVisualNodeSignature(projection.content) === latexVisualNodeSignature(nextContent))
      return { source, structural: false, projection };
    const { generated, generatedOrigins, ...ordinary } = projection;
    const virtual = generated?.virtual ?? ordinary;
    const changed = applyLatexVisualDocumentChange(virtual.source, virtual, nextContent, context);
    if (!changed) return null;
    const origins = generatedOrigins ?? [];
    let result = changed.source;
    for (const origin of origins) {
      const at = result.indexOf(origin.expanded);
      if (at >= 0 && result.indexOf(origin.expanded, at + 1) < 0)
        result = result.slice(0, at) + origin.raw + result.slice(at + origin.expanded.length);
    }
    // Once materialized, normal typing retains the existing incremental source map.
    if (result === changed.source)
      return {
        ...changed,
        materializedGenerator: generated !== undefined,
        ...(generated && changed.origin !== undefined
          ? {
              origin: documentLoopSourceRange(
                generated.expansion,
                changed.origin,
                changed.origin + 1,
              ).from,
            }
          : {}),
        projection: { ...changed.projection, generatedOrigins: origins },
      };
    const project = (value: string) =>
      projectLatexVisualDocument(
        value,
        0,
        value.includes("\\begin{document}")
          ? value
          : (changed.rootUpdate?.next ?? context?.rootSource ?? projection.setup ?? value),
      );
    let parsed = project(result);
    if (roundTripSignature(parsed.content) !== roundTripSignature(nextContent)) {
      result = changed.source;
      parsed = project(result);
      if (roundTripSignature(parsed.content) !== roundTripSignature(nextContent)) return null;
    }
    const mappedOrigin =
      generated && changed.origin !== undefined
        ? documentLoopSourceRange(generated.expansion, changed.origin, changed.origin + 1).from
        : changed.origin;
    return {
      ...changed,
      source: result,
      ...(mappedOrigin === undefined ? {} : { origin: mappedOrigin }),
      materializedGenerator: generated !== undefined && parsed.generated === undefined,
      projection: {
        ...adoptLatexVisualContent(result, nextContent, parsed),
        generatedOrigins: origins,
      },
    };
  }
  const setup = context?.rootSource
    ? visualSetup(context.rootSource)
    : (projection.setup ?? visualSetup(source));
  const previous = projection.blocks;
  const next = nextContent.content ?? [];
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    latexVisualNodeSignature(previous[prefix]!.node) === latexVisualNodeSignature(next[prefix]!)
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    latexVisualNodeSignature(previous[previous.length - 1 - suffix]!.node) ===
      latexVisualNodeSignature(next[next.length - 1 - suffix]!)
  )
    suffix++;
  if (prefix === previous.length && prefix === next.length)
    return { source, structural: false, projection };
  const oldChanged = previous.slice(prefix, previous.length - suffix);
  const newChanged = next.slice(prefix, next.length - suffix);
  if (oldChanged.some((block) => !block.editable)) return null;
  if (
    oldChanged.length === newChanged.length &&
    oldChanged.some(
      (block, index) =>
        block.node.type === "latexDisplayMath" &&
        block.node.attrs?.numberingSource &&
        (newChanged[index]?.type !== "latexDisplayMath" ||
          (!newChanged[index]?.attrs?.numberingSource &&
            serializeNumberedMath(
              { ...newChanged[index]?.attrs, tex: String(newChanged[index]?.attrs?.tex ?? "") },
              block.source,
            ) === null)),
    )
  )
    return null;
  if (
    oldChanged.length === 1 &&
    newChanged.length === 1 &&
    oldChanged[0]?.node.type === "latexRichPreview" &&
    oldChanged[0]?.node.attrs?.kind === "title" &&
    newChanged[0]?.type === "latexRichPreview" &&
    newChanged[0]?.attrs?.kind === "title"
  ) {
    const changedSource = updateTitleMetadata(source, oldChanged[0]!.node, newChanged[0]);
    if (changedSource === null) return null;
    const projected = projectLatexVisualDocument(changedSource);
    if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) return null;
    return {
      source: changedSource,
      projection: adoptLatexVisualContent(changedSource, nextContent, projected),
      structural: false,
    };
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const split = oldChanged.length === 1 ? splitParagraphSource(oldChanged[0]!, newChanged) : null;
  const serialized =
    split ??
    newChanged.map((node, index) => {
      const previousBlock = oldChanged.length === newChanged.length ? oldChanged[index] : null;
      if (node.type === "latexRichPreview" && node.attrs?.kind === "documentCommand") {
        // Title edits update the declaration's source without replacing the live
        // editor. A later structural edit must not restore its older raw attribute.
        const originals = previous.filter(
          (block) =>
            node.attrs?.sourceId != null &&
            block.node.attrs?.sourceId === node.attrs.sourceId &&
            latexVisualNodeSignature(block.node) === latexVisualNodeSignature(node),
        );
        if (originals.length === 1) return originals[0]!.source;
      }
      if (node.type === "latexScientific" && node.attrs?.layout)
        return patchPageLayoutStructure(
          previousBlock?.node.type === "latexScientific" &&
            previousBlock.node.attrs?.sourceId === node.attrs.sourceId &&
            previousBlock.node.attrs?.layout?.kind === node.attrs.layout.kind
            ? previousBlock.source
            : String(node.attrs.raw ?? ""),
          node,
          setup,
          source.includes("\\begin{document}") ? source : (context?.rootSource ?? null),
        );
      if (previousBlock?.node.type === "latexScientific" && node.type === "latexScientific")
        return patchScientificStructure(
          previousBlock,
          node,
          source.includes("\\begin{document}") ? source : (context?.rootSource ?? null),
          setup,
        );
      if (
        previousBlock?.node.type === "latexDisplayMath" &&
        node.type === "latexDisplayMath" &&
        !previousBlock.node.attrs?.numberingSource &&
        !node.attrs?.numberingSource &&
        previousBlock.node.attrs?.wrapper === node.attrs?.wrapper &&
        (previousBlock.node.attrs?.environment ?? null) === (node.attrs?.environment ?? null) &&
        typeof node.attrs?.tex === "string"
      ) {
        const old = String(previousBlock.node.attrs?.tex ?? "");
        const from = old ? previousBlock.source.indexOf(old) : -1;
        if (from >= 0)
          return (
            previousBlock.source.slice(0, from) +
            node.attrs.tex +
            previousBlock.source.slice(from + old.length)
          );
      }
      if (
        previousBlock?.node.type === "latexDisplayMath" &&
        previousBlock.node.attrs?.numberingSource
      )
        return serializeNumberedMath(
          { ...node.attrs, tex: String(node.attrs?.tex ?? "") },
          previousBlock.source,
        );
      const minimal =
        oldChanged.length === newChanged.length && oldChanged[index]
          ? minimallyPatchedBlock(oldChanged[index]!, node)
          : null;
      if (
        previousBlock?.node.type === "latexRichPreview" &&
        ["scientific", "abstract"].includes(String(previousBlock.node.attrs?.kind)) &&
        node.type === previousBlock.node.type &&
        node.attrs?.kind === previousBlock.node.attrs?.kind
      )
        return patchRichTextBlock(previousBlock, node);
      if (node.type === "latexRichPreview" && node.attrs?.sourceMeta?.literal === true)
        return serializeLatexVisualBlock(node);
      return minimal ?? serializeLatexVisualBlock(node)?.replace(/\r?\n/gu, eol) ?? null;
    });
  if (serialized.some((value) => value === null)) return null;
  let from = oldChanged[0]?.from ?? previous[prefix]?.from ?? previous.at(-1)?.to ?? source.length;
  let to = oldChanged.at(-1)?.to ?? from;
  const origin = oldChanged[0]?.from ?? previous[prefix - 1]?.from ?? from;
  const sourceGaps = oldChanged
    .slice(1)
    .map((block, index) => source.slice(oldChanged[index]!.to, block.from));
  const hasContentsGap = sourceGaps.some((gap) => {
    const at = findDelimiter(gap, "\\addcontentsline", 0);
    return at >= 0 && contentsEntry(gap, at) !== null;
  });
  // Keep explicit contents metadata at its existing boundary. Refuse a
  // structural change that cannot retain that boundary instead of deleting it.
  if (hasContentsGap && oldChanged.length !== newChanged.length) return null;
  const keepParagraphGaps =
    oldChanged.length === newChanged.length && sourceGaps.some((gap) => /\\par\b/u.test(gap));
  let replacement = serialized
    .map(
      (block, index) =>
        block +
        (index < serialized.length - 1
          ? hasContentsGap || keepParagraphGaps
            ? sourceGaps[index]!
            : eol + eol
          : ""),
    )
    .join("");
  // Own only whitespace at the edited boundaries. Otherwise inserting/deleting
  // a block leaves old separators behind and blank lines accumulate over time.
  if (oldChanged.length !== 1 || newChanged.length !== 1) {
    const before = previous[prefix - 1];
    const after = previous[previous.length - suffix];
    if (before && /^\s*$/u.test(source.slice(before.to, from))) from = before.to;
    if (after && /^\s*$/u.test(source.slice(to, after.from))) to = after.from;
    const originalGap = before && after ? source.slice(before.to, after.from) : "";
    const gap =
      (before?.node.type === "latexDisplayMath" || after?.node.type === "latexDisplayMath") &&
      /^\s*$/u.test(originalGap) &&
      !/\r?\n[\t ]*\r?\n/u.test(originalGap)
        ? eol
        : eol + eol;
    if (replacement) {
      if (before && from === before.to) replacement = gap + replacement;
      if (after && to === after.from) replacement += gap;
    } else if (before && after && from === before.to && to === after.from) replacement = gap;
  }
  replacement = preserveSourceComments(source.slice(from, to), replacement, eol, source.slice(to));
  if (replacement && from > 0 && source[from - 1] !== "\n") {
    const precedingLine = source.slice(source.lastIndexOf("\n", from - 1) + 1, from);
    if (
      precedingLine.includes("%") &&
      latexCommentRanges(precedingLine).at(-1)?.to === precedingLine.length
    )
      replacement = eol + replacement;
  }
  let changedSource = source.slice(0, from) + replacement + source.slice(to);
  let rootUpdate: LatexRootUpdate | undefined;
  const previousNodes = oldChanged.map((block) => block.node);
  const ownPreamble = findDelimiter(source, "\\begin{document}", 0) >= 0;
  const root = ownPreamble ? changedSource : context?.rootSource;
  const previousEnvironments = scientificEnvironments(previousNodes);
  const addedEnvironments = new Set(
    [...scientificEnvironments(newChanged)].filter(
      (environment) => !previousEnvironments.has(environment),
    ),
  );
  // Inspect newly introduced source and structures. Existing commands must not
  // make an ordinary text edit depend on resolving the root document.
  const previousSource = oldChanged.map((block) => block.source).join(eol + eol);
  const previousPackages = requiredObjectPackages(previousNodes);
  const requiredPackages = new Set([
    ...[...requiredObjectPackages(newChanged)].filter((name) => !previousPackages.has(name)),
    ...newMathSymbolPackages(activeLatexSource(previousSource), activeLatexSource(replacement)),
    ...newLatexCommandPackages(activeLatexSource(previousSource), activeLatexSource(replacement)),
  ]);
  if (addedEnvironments.size || requiredPackages.size) {
    if (!root || findDelimiter(root, "\\begin{document}", 0) < 0) {
      context?.onMissingRequirement?.(
        "Choose the root document before inserting content that needs LaTeX packages or declarations.",
      );
      return null;
    }
    let prepared = ensureLatexPackages(root, requiredPackages, eol);
    prepared = ensureLatexMenuColors(prepared, replacement, eol);
    prepared = ensureMathSymbolDefinitions(prepared, replacement, eol);
    prepared = ensureScientificEnvironmentDeclarations(prepared, addedEnvironments, eol);
    if (!ownPreamble && prepared !== root && !context?.allowRootUpdates) {
      context?.onMissingRequirement?.(
        "This insertion needs packages or declarations in the root document. Add them in the root's Source view, then try again.",
      );
      return null;
    }
    if (!ownPreamble && prepared !== root) rootUpdate = { expected: root, next: prepared };
    if (ownPreamble) changedSource = prepared;
  }
  // Local edits cannot change neighboring syntax. Validate only the replacement
  // block; keep the original source and mappings for all unaffected blocks.
  if (
    oldChanged.length === 1 &&
    newChanged.length === 1 &&
    changedSource === source.slice(0, from) + replacement + source.slice(to) &&
    !["bulletList", "orderedList"].includes(newChanged[0]!.type ?? "") &&
    !["title", "toc"].includes(String(newChanged[0]!.attrs?.kind))
  ) {
    const parsed = projectLatexVisualDocument(
      replacement,
      0,
      rootUpdate?.next ?? (ownPreamble ? changedSource : setup),
    );
    if (
      parsed.blocks.length === 1 &&
      roundTripSignature(parsed.blocks[0]!.node) === roundTripSignature(newChanged[0]!)
    ) {
      const delta = replacement.length - (to - from);
      const blocks = previous.map((block, index) =>
        index === prefix
          ? {
              ...parsed.blocks[0]!,
              id: block.id,
              from: from + parsed.blocks[0]!.from,
              to: from + parsed.blocks[0]!.to,
              node: newChanged[0]!,
            }
          : index > prefix
            ? { ...block, from: block.from + delta, to: block.to + delta }
            : block,
      );
      return {
        source: changedSource,
        ...(rootUpdate ? { rootUpdate } : {}),
        origin,
        structural: false,
        projection: {
          ...projection,
          source: changedSource,
          content: nextContent,
          blocks,
          supportedBlocks:
            projection.supportedBlocks -
            Number(oldChanged[0]!.editable) +
            Number(parsed.blocks[0]!.editable),
          rawBlocks:
            projection.rawBlocks +
            Number(oldChanged[0]!.editable) -
            Number(parsed.blocks[0]!.editable),
        },
      };
    }
  }
  // Reject a transaction that the supported projection cannot round-trip.
  const projected = projectLatexVisualDocument(
    changedSource,
    0,
    rootUpdate?.next ?? (ownPreamble ? changedSource : setup),
  );
  if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) {
    const oldBlock = oldChanged[0];
    const newBlock = newChanged[0];
    const nonText = (node: JSONContent): JSONContent => ({
      ...node,
      ...(node.content
        ? { content: node.content.filter((child) => child.type !== "text").map(nonText) }
        : {}),
    });
    const hasMultilineText = (node: JSONContent): boolean =>
      (node.type === "text" && /[\r\n]/u.test(node.text ?? "")) ||
      (node.content?.some(hasMultilineText) ?? false);
    if (
      oldChanged.length !== 1 ||
      newChanged.length !== 1 ||
      !oldBlock?.editable ||
      !newBlock ||
      !["paragraph", "heading", "blockquote", "bulletList", "orderedList"].includes(
        newBlock.type ?? "",
      ) ||
      latexVisualNodeSignature(nonText(oldBlock.node)) !==
        latexVisualNodeSignature(nonText(newBlock)) ||
      hasMultilineText(newBlock) ||
      rootUpdate ||
      changedSource !== source.slice(0, from) + replacement + source.slice(to)
    )
      return null;
    // Text is escaped by serializeInline. Preserve the unchanged inline atoms
    // and source ranges even when the general parser cannot compare this edit.
    const delta = replacement.length - (to - from);
    const blocks = previous.map((block, index) =>
      index === prefix
        ? { ...block, from, to: from + replacement.length, source: replacement, node: newBlock }
        : index > prefix
          ? { ...block, from: block.from + delta, to: block.to + delta }
          : block,
    );
    return {
      source: changedSource,
      origin,
      structural: false,
      projection: { ...projection, source: changedSource, content: nextContent, blocks },
    };
  }
  return {
    source: changedSource,
    ...(rootUpdate ? { rootUpdate } : {}),
    origin,
    projection: adoptLatexVisualContent(changedSource, nextContent, projected),
    structural: oldChanged.length !== 1 || newChanged.length !== 1,
  };
}
