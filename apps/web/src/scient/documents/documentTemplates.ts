import assignmentSource from "./templates/assignment.tex?raw";
import reportSource from "./templates/report.tex?raw";
import proposalSource from "./templates/proposal.tex?raw";
import thesisSource from "./templates/thesis.tex?raw";
import blankSource from "./templates/blank.tex?raw";
import articleSource from "./templates/article.tex?raw";
import { updateLatexLanguageSource } from "../latex/latexLanguage";

export const DOCUMENT_TEMPLATES = [
  {
    id: "article",
    name: "Article",
    description: "A paper: abstract and sections.",
    detail: "Abstract, introduction, results, and discussion.",
  },
  {
    id: "assignment",
    name: "Assignment",
    description: "Questions, calculations, and solutions.",
    detail: "A title and your first numbered question.",
  },
  {
    id: "report",
    name: "Report",
    description: "Explain a topic or present your findings.",
    detail: "Abstract, introduction, methods, results, and conclusion.",
  },
  {
    id: "proposal",
    name: "Research proposal",
    description: "Turn a research idea into a clear plan.",
    detail: "Research question, background, approach, and next steps.",
  },
  {
    id: "thesis",
    name: "Thesis",
    description: "A starting structure for a longer project.",
    detail: "A general academic template. You can also use your institution’s own LaTeX template.",
  },
  {
    id: "blank",
    name: "Blank",
    description: "A clean page with the essentials ready.",
    detail: "Standard article formatting with math, figures, and tables available.",
  },
] as const;
export type DocumentTemplateId = (typeof DOCUMENT_TEMPLATES)[number]["id"];

export function documentPath(value: string): string | null {
  let path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 480 || /^[/.]/u.test(path) || /[<>:"|?*\u0000-\u001f]/u.test(path))
    return null;
  if (
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    return null;
  if (!/\.tex$/iu.test(path)) {
    if (/\.[^/]+$/u.test(path)) return null;
    path += ".tex";
  }
  if (path.split("/").at(-1)?.toLowerCase() === ".tex") return null;
  return path;
}

export function documentFilename(title: string): string {
  return (
    (title
      .trim()
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
      .replace(/[. ]+$/u, "")
      .slice(0, 100) || "Untitled") + ".tex"
  );
}

export function escapeDocumentText(value: string): string {
  const escapes: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "%": "\\%",
    $: "\\$",
    "&": "\\&",
    "#": "\\#",
    _: "\\_",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return value
    .replace(/[\\{}%$&#_~^]/gu, (character) => escapes[character]!)
    .replace(/[\r\n]+/gu, " ");
}

export function createDocumentSource(input: {
  template: DocumentTemplateId;
  title: string;
  author: string;
  course: string;
}) {
  const title = escapeDocumentText(input.title.trim() || "Untitled");
  const author = escapeDocumentText(input.author.trim());
  const course = escapeDocumentText(input.course.trim());
  const sources: Record<DocumentTemplateId, string> = {
    assignment: assignmentSource,
    report: reportSource,
    proposal: proposalSource,
    thesis: thesisSource,
    blank: blankSource,
    article: articleSource,
  };
  const values: Record<string, string> = {
    TITLE: title,
    AUTHOR_BLOCK: [author, course].filter(Boolean).join("\\\\\n"),
  };
  // Replace only template tokens, once. User text cannot expand further tokens.
  return sources[input.template].replace(
    /<<SCIENT_(TITLE|AUTHOR_BLOCK)>>/gu,
    (_token, name: string) => values[name]!,
  );
}

/** File naming and the printed title start together and can diverge after creation. */
export function documentTitleFromFilename(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/\.tex$/iu, "");
}

export function availableDocumentPath(path: string, existing: readonly string[]): string {
  const occupied = new Set(existing.map((entry) => entry.toLocaleLowerCase()));
  const stem = path.replace(/\.tex$/iu, "");
  let candidate = path;
  for (let suffix = 2; occupied.has(candidate.toLocaleLowerCase()); suffix++) {
    candidate = `${stem} (${suffix}).tex`;
  }
  return candidate;
}

export type NewDocumentFormat = "markdown" | "latex";
export type NewDocumentLanguage = "english" | "hebrew";

/** The starting points shown in the row on a new LaTeX document, in order. */
export const NEW_DOCUMENT_TEMPLATES: ReadonlyArray<{
  readonly id: DocumentTemplateId;
  readonly name: string;
}> = [
  { id: "blank", name: "Blank" },
  { id: "article", name: "Article" },
  { id: "report", name: "Report" },
  { id: "thesis", name: "Thesis" },
];

/** The rest, behind "More…". */
export const MORE_DOCUMENT_TEMPLATES: ReadonlyArray<{
  readonly id: DocumentTemplateId;
  readonly name: string;
}> = [
  { id: "proposal", name: "Research proposal" },
  { id: "assignment", name: "Assignment" },
];

export const NEW_DOCUMENT_LANGUAGES: ReadonlyArray<{
  readonly id: NewDocumentLanguage;
  readonly name: string;
}> = [
  { id: "english", name: "English" },
  { id: "hebrew", name: "Hebrew" },
];

// Present on macOS and Windows, so the PDF and the Visual page use the same face.
const HEBREW_DOCUMENT_FONT = "Times New Roman";

/** A filename stem from a title: letters and digits in any script, joined by hyphens. */
export function newDocumentStem(title: string): string {
  return (
    title
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80)
      .replace(/-+$/u, "") || "untitled"
  );
}

export function newDocumentExtension(format: NewDocumentFormat): "tex" | "md" {
  return format === "latex" ? "tex" : "md";
}

/** `<stem>.<ext>` beside `beside`'s folder, or `<stem>-<n>.<ext>` for the nth attempt. */
export function newDocumentCandidate(
  stem: string,
  format: NewDocumentFormat,
  attempt: number,
  folder = "",
): string {
  const name = attempt <= 1 ? stem : `${stem}-${attempt}`;
  return `${folder}${name}.${newDocumentExtension(format)}`;
}

/** The balanced `\title{…}` argument of a LaTeX source, raw. */
function latexTitleRange(source: string): { from: number; to: number } | null {
  const match = /\\title\s*\{/u.exec(source);
  if (!match) return null;
  const from = match.index + match[0].length;
  let depth = 1;
  for (let at = from; at < source.length; at++) {
    const character = source[at];
    if (character === "\\") at++;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return { from, to: at };
  }
  return null;
}

/** Title text compared as words, the way the title field and the source can both show it. */
export function sameTitleText(a: string, b: string): boolean {
  const words = (value: string) =>
    value
      .replace(/[\\{}$~^_%&#]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  return words(a) === words(b);
}

/** The title a document gives itself: LaTeX `\title{…}`, Markdown's first heading. */
export function newDocumentTitle(source: string, format: NewDocumentFormat): string {
  if (format === "markdown") return /^#[ \t]+([^\r\n]*)/u.exec(source)?.[1]?.trim() ?? "";
  const range = latexTitleRange(source);
  if (!range) return "";
  return source
    .slice(range.from, range.to)
    .replace(/\\[a-zA-Z@]+\*?/gu, " ")
    .replace(/\\./gu, " ")
    .replace(/[{}$~^_%&#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function withRawLatexTitle(source: string, rawTitle: string): string {
  const range = latexTitleRange(source);
  return range ? source.slice(0, range.from) + rawTitle + source.slice(range.to) : source;
}

/** A new document's source with an empty title: what Scient writes before anyone types. */
export function createNewDocumentSource(input: {
  readonly format: NewDocumentFormat;
  readonly template: DocumentTemplateId;
  readonly language: NewDocumentLanguage;
}): string {
  if (input.format === "markdown") return "# \n";
  const source = withRawLatexTitle(
    createDocumentSource({ template: input.template, title: "x", author: "", course: "" }),
    "",
  );
  if (input.language === "english") return source;
  // Hebrew runs on XeLaTeX with fontspec, which replaces the 8-bit font setup.
  const unicode = source.replace(
    /^\\usepackage\[(?:T1|utf8)\]\{(?:fontenc|inputenc)\}\r?\n/gmu,
    "",
  );
  return updateLatexLanguageSource(unicode, "hebrew", HEBREW_DOCUMENT_FONT) ?? source;
}

/**
 * Whether a new LaTeX document is still exactly what Scient wrote, apart from
 * its title: only then can its template or language change without touching
 * anyone's writing.
 */
export function isUntouchedNewLatexDocument(
  source: string,
  template: DocumentTemplateId,
  language: NewDocumentLanguage,
): boolean {
  const pristine = createNewDocumentSource({ format: "latex", template, language });
  return withRawLatexTitle(source, "") === pristine;
}

/** The same document in another template or language, keeping the title as typed. */
export function switchNewLatexDocument(
  source: string,
  template: DocumentTemplateId,
  language: NewDocumentLanguage,
): string {
  const range = latexTitleRange(source);
  const title = range ? source.slice(range.from, range.to) : "";
  return withRawLatexTitle(createNewDocumentSource({ format: "latex", template, language }), title);
}
