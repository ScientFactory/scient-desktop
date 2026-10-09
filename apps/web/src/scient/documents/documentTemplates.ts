import articleSource from "./templates/article.tex?raw";
import blankSource from "./templates/blank.tex?raw";
import cvSource from "./templates/cv.tex?raw";
import grantProposalSource from "./templates/grant-proposal.tex?raw";
import labReportSource from "./templates/lab-report.tex?raw";
import lectureNotesSource from "./templates/lecture-notes.tex?raw";
import letterSource from "./templates/letter.tex?raw";
import problemSetSource from "./templates/problem-set.tex?raw";
import responseToReviewersSource from "./templates/response-to-reviewers.tex?raw";
import thesisAppendix from "./templates/thesis/chapters/appendix.tex?raw";
import thesisBackground from "./templates/thesis/chapters/background.tex?raw";
import thesisConclusion from "./templates/thesis/chapters/conclusion.tex?raw";
import thesisDiscussion from "./templates/thesis/chapters/discussion.tex?raw";
import thesisIntroduction from "./templates/thesis/chapters/introduction.tex?raw";
import thesisMethods from "./templates/thesis/chapters/methods.tex?raw";
import thesisResults from "./templates/thesis/chapters/results.tex?raw";
import thesisSource from "./templates/thesis/main.tex?raw";
import { updateLatexLanguageSource } from "../latex/latexLanguage";
import { userTemplates } from "./userTemplates";

/**
 * Scient's own LaTeX templates, in the order a new document offers them. Each
 * builds with a standard TeX installation (pdfLaTeX, BibTeX) and opens in
 * Visual without a source-only block.
 */
export const DOCUMENT_TEMPLATES = [
  { id: "blank", name: "Blank", source: blankSource },
  { id: "article", name: "Article", source: articleSource },
  { id: "thesis", name: "Thesis", source: thesisSource },
  { id: "problem-set", name: "Problem set", source: problemSetSource },
  { id: "lab-report", name: "Lab report", source: labReportSource },
  { id: "lecture-notes", name: "Lecture notes", source: lectureNotesSource },
  { id: "grant-proposal", name: "Grant proposal", source: grantProposalSource },
  {
    id: "response-to-reviewers",
    name: "Response to reviewers",
    source: responseToReviewersSource,
  },
  { id: "letter", name: "Letter", source: letterSource },
  { id: "cv", name: "CV", source: cvSource },
] as const;
export type BuiltInTemplateId = (typeof DOCUMENT_TEMPLATES)[number]["id"];
/** A built-in template's id, or one of the person's own (`user:…`). */
export type DocumentTemplateId = string;

function builtIn(id: DocumentTemplateId) {
  return DOCUMENT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Whether a template exists: Scient's, or the person's own still kept. */
export function isDocumentTemplateId(id: string): boolean {
  return builtIn(id) !== null || userTemplates.get(id) !== null;
}

export function templateName(id: DocumentTemplateId): string {
  return builtIn(id)?.name ?? userTemplates.get(id)?.name ?? "Blank";
}

/**
 * Templates that are a folder of their own: the document is the folder's
 * `main.tex`, and these files, relative to it, are created with it.
 */
const FOLDER_TEMPLATES: Partial<Record<BuiltInTemplateId, Readonly<Record<string, string>>>> = {
  thesis: {
    "chapters/introduction.tex": thesisIntroduction,
    "chapters/background.tex": thesisBackground,
    "chapters/methods.tex": thesisMethods,
    "chapters/results.tex": thesisResults,
    "chapters/discussion.tex": thesisDiscussion,
    "chapters/conclusion.tex": thesisConclusion,
    "chapters/appendix.tex": thesisAppendix,
  },
};

/** The main file of a template that is a folder. */
export const FOLDER_DOCUMENT_MAIN = "main.tex";

/** The files a template makes beside its main file, relative to its folder. */
function templateFiles(template: DocumentTemplateId): Readonly<Record<string, string>> | null {
  const own = builtIn(template);
  if (own) return FOLDER_TEMPLATES[own.id] ?? null;
  const files = userTemplates.get(template)?.files;
  return files && Object.keys(files).length > 0 ? files : null;
}

export function isFolderTemplate(template: DocumentTemplateId): boolean {
  return templateFiles(template) !== null;
}

/** A file created beside a new document, relative to its folder. */
export interface CompanionFile {
  readonly name: string;
  readonly contents: string;
}

/**
 * Everything a new document creates beside its main file: a folder template's
 * own files, and the (empty) bibliography databases its source names.
 */
export function templateCompanions(
  template: DocumentTemplateId,
  source: string,
): readonly CompanionFile[] {
  const files = Object.entries(templateFiles(template) ?? {}).map(([name, contents]) => ({
    name,
    contents,
  }));
  for (const name of companionFiles(source))
    if (!files.some((file) => file.name === name)) files.push({ name, contents: "" });
  return files;
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

function templateSource(template: DocumentTemplateId): string {
  return builtIn(template)?.source ?? userTemplates.get(template)?.source ?? blankSource;
}

/**
 * The files a LaTeX source reads beside itself that a new document creates
 * with it: the bibliography databases it names, relative to its folder.
 */
export function companionFiles(source: string): readonly string[] {
  const names = new Set<string>();
  const pattern = /^[^%\n]*?\\(?:bibliography|addbibresource)\s*\{([^}]*)\}/gmu;
  for (const match of source.matchAll(pattern)) {
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim();
      if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(name)) continue;
      names.add(/\.bib$/iu.test(name) ? name : `${name}.bib`);
    }
  }
  return [...names];
}

export type NewDocumentFormat = "markdown" | "latex";
export type NewDocumentLanguage = "english" | "hebrew";

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

function newDocumentExtension(format: NewDocumentFormat): "tex" | "md" {
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

/**
 * Whether a template prints a title. A new document is named from its title, or,
 * in a template without one, from the name typed above the page.
 */
export function templateHasTitle(template: DocumentTemplateId): boolean {
  return (
    latexTitleRange(createNewDocumentSource({ format: "latex", template, language: "english" })) !==
    null
  );
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

/** A source with its title emptied: how a template keeps a document. */
export function withEmptyTitle(source: string): string {
  return withRawLatexTitle(source, "");
}

/** A template's own source and files, as a new template copied from it starts. */
export function templateContents(template: DocumentTemplateId): {
  readonly source: string;
  readonly files: Readonly<Record<string, string>>;
} {
  return { source: templateSource(template), files: templateFiles(template) ?? {} };
}

/**
 * The project files a LaTeX source includes (`\include`, `\input`, `\subfile`),
 * relative to its folder; none outside it.
 */
export function includedFiles(source: string): readonly string[] {
  const names = new Set<string>();
  const pattern = /^[^%\n]*?\\(?:include|input|subfile)\s*\{([^}]+)\}/gmu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.trim().replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || !part))
      continue;
    names.add(/\.[A-Za-z]+$/u.test(name) ? name : `${name}.tex`);
  }
  return [...names];
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
  // The title and the author start empty, for the person to write.
  const source = templateSource(input.template).replace(/<<SCIENT_(?:TITLE|AUTHOR_BLOCK)>>/gu, "");
  if (input.language === "english") return source;
  // Hebrew runs on XeLaTeX with fontspec, which replaces the 8-bit font setup.
  const unicode = source.replace(
    /^\\usepackage(?:\[(?:T1|utf8)\]\{(?:fontenc|inputenc)\}|\{lmodern\})\r?\n/gmu,
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

/**
 * The same document in another template or language, keeping the title as typed.
 * Coming from a template without a title, `name` becomes the title.
 */
export function switchNewLatexDocument(
  source: string,
  template: DocumentTemplateId,
  language: NewDocumentLanguage,
  name = "",
): string {
  const range = latexTitleRange(source);
  const title = range ? source.slice(range.from, range.to) : escapeDocumentText(name.trim());
  return withRawLatexTitle(createNewDocumentSource({ format: "latex", template, language }), title);
}
