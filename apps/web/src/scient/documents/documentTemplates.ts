import assignmentSource from "./templates/assignment.tex?raw";
import reportSource from "./templates/report.tex?raw";
import proposalSource from "./templates/proposal.tex?raw";
import thesisSource from "./templates/thesis.tex?raw";
import blankSource from "./templates/blank.tex?raw";
import { updateLatexLanguageSource } from "../latex/latexLanguage";

export const DOCUMENT_TEMPLATES = [
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

/** The starting points offered on a new LaTeX page, in the order shown. */
export const NEW_DOCUMENT_TEMPLATES: ReadonlyArray<{
  readonly id: DocumentTemplateId;
  readonly name: string;
}> = [
  { id: "blank", name: "Article" },
  { id: "report", name: "Report" },
  { id: "thesis", name: "Thesis" },
  { id: "proposal", name: "Proposal" },
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

/** The first free `<stem>.<ext>`, then `<stem>-2.<ext>`, compared case-insensitively. */
export function newDocumentPath(
  title: string,
  format: NewDocumentFormat,
  existing: readonly string[],
): string {
  const extension = format === "latex" ? "tex" : "md";
  const stem = newDocumentStem(title);
  const occupied = new Set(existing.map((entry) => entry.toLocaleLowerCase()));
  let candidate = `${stem}.${extension}`;
  for (let suffix = 2; occupied.has(candidate.toLocaleLowerCase()); suffix++)
    candidate = `${stem}-${suffix}.${extension}`;
  return candidate;
}

export function createNewDocumentSource(input: {
  readonly format: NewDocumentFormat;
  readonly title: string;
  readonly template: DocumentTemplateId;
  readonly language: NewDocumentLanguage;
}): string {
  const title = input.title.trim().replace(/[\r\n]+/gu, " ");
  if (input.format === "markdown") return `# ${title || "Untitled"}\n\n`;
  const source = createDocumentSource({ template: input.template, title, author: "", course: "" });
  if (input.language === "english") return source;
  // Hebrew runs on XeLaTeX with fontspec, which replaces the 8-bit font setup.
  const unicode = source.replace(
    /^\\usepackage\[(?:T1|utf8)\]\{(?:fontenc|inputenc)\}\r?\n/gmu,
    "",
  );
  return updateLatexLanguageSource(unicode, "hebrew", HEBREW_DOCUMENT_FONT) ?? source;
}
