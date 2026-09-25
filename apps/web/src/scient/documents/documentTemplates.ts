import assignmentSource from "./templates/assignment.tex?raw";
import reportSource from "./templates/report.tex?raw";
import proposalSource from "./templates/proposal.tex?raw";
import thesisSource from "./templates/thesis.tex?raw";
import blankSource from "./templates/blank.tex?raw";

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
