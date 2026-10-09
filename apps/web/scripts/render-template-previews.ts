// Renders the first page of each built-in LaTeX template to
// src/scient/documents/previews/<id>.png, the picture a template's card shows.
// Run after changing a template: `node apps/web/scripts/render-template-previews.ts`.
// Needs latexmk or Tectonic, and Poppler's pdftoppm or, on macOS, sips.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const documents = NodePath.resolve(import.meta.dirname, "../src/scient/documents");
const templates = NodePath.join(documents, "templates");
const previews = NodePath.join(documents, "previews");
/** Hover cards keep small assets; only expanding a page loads its larger image. */
const PREVIEW_WIDTHS = [
  { folder: "", width: 480 },
  { folder: "full", width: 1600 },
] as const;

function has(command: string): boolean {
  return NodeChildProcess.spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
}

const engine = has("latexmk") ? "latexmk" : has("tectonic") ? "tectonic" : null;
if (engine === null) throw new Error("latexmk or Tectonic is needed to typeset the templates.");
// Poppler's pdftoppm; the older xpdf one, which some TeX installations carry, lacks -singlefile.
const pdftoppm =
  has("pdftoppm") &&
  NodeChildProcess.spawnSync("pdftoppm", ["-h"], { encoding: "utf8" }).stderr.includes(
    "-singlefile",
  );
if (!pdftoppm && !has("sips")) throw new Error("Poppler's pdftoppm (or sips on macOS) is needed.");

/** Each template's main file, and the folder of its own files if it is a folder. */
const entries = [
  ...NodeFS.readdirSync(templates)
    .filter((name) => name.endsWith(".tex"))
    .map((name) => ({ id: name.replace(/\.tex$/u, ""), folder: null as string | null })),
  ...NodeFS.readdirSync(templates, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, folder: NodePath.join(templates, entry.name) })),
];

/** Text as TeX prints it literally. */
function literal(text: string): string {
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
  return text.replace(/[\\{}%$&#_~^]/gu, (character) => escapes[character]!);
}

/**
 * A template's guidance (`% Guide:` comment lines above an empty place) as
 * faint print: what the Visual page shows. The rule matches Visual's
 * (latexGuidance.ts); a document's own PDF never prints guidance.
 */
function faintGuidance(source: string): string {
  const faint = (lines: string) => {
    const text = lines
      .split("\n")
      .filter(Boolean)
      .map((line, index) =>
        (index === 0 ? line.replace(/^%+\s*Guide:\s*/u, "") : line.replace(/^%+\s?/u, "")).trim(),
      )
      .join(" ");
    return `{\\color{black!38}${literal(text)}}`;
  };
  return source
    .replace(
      /^(%+\s*Guide:[^\n]*\n(?:%[^\n]*\n)*)\\par$/gmu,
      (_, lines: string) => `${faint(lines)}\\par`,
    )
    .replace(
      /(\\begin\{[A-Za-z]+\*?\}(?:\s*\[[^\]]*\])?\n)(%+\s*Guide:[^\n]*\n(?:%[^\n]*\n)*)(\\end\{)/gu,
      (_, opening: string, lines: string, closing: string) =>
        `${opening}${faint(lines)}\n${closing}`,
    );
}

// Publish the whole batch only after every template has built successfully.
const batch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-template-previews-"));
try {
  for (const { id, folder } of entries) {
    const work = NodePath.join(batch, id);
    NodeFS.mkdirSync(work);
    if (folder) NodeFS.cpSync(folder, work, { recursive: true });
    else
      NodeFS.copyFileSync(NodePath.join(templates, `${id}.tex`), NodePath.join(work, "main.tex"));
    const main = NodePath.join(work, "main.tex");
    // The placeholders Visual shows in an empty title, as print.
    NodeFS.writeFileSync(
      main,
      NodeFS.readFileSync(main, "utf8")
        .replace("<<SCIENT_TITLE>>", "Title")
        .replace("<<SCIENT_AUTHOR_BLOCK>>", "Author")
        .replace(/^(\\documentclass[^\n]*\n)/u, "$1\\usepackage{xcolor}\n"),
    );
    // A template's guidance (a comment above an empty place) shows faintly,
    // as Visual draws it; a document's own PDF never prints it.
    for (const file of NodeFS.readdirSync(work, { recursive: true, encoding: "utf8" }))
      if (file.endsWith(".tex")) {
        const path = NodePath.join(work, file);
        NodeFS.writeFileSync(path, faintGuidance(NodeFS.readFileSync(path, "utf8")));
      }
    NodeFS.writeFileSync(NodePath.join(work, "references.bib"), "");
    run(
      engine,
      engine === "latexmk"
        ? ["-pdf", "-norc", "-interaction=nonstopmode", "-no-shell-escape", "main.tex"]
        : ["--untrusted", "--keep-logs", "main.tex"],
      work,
    );
    for (const { folder: imageFolder, width } of PREVIEW_WIDTHS) {
      const output = NodePath.join(batch, "images", imageFolder, `${id}.png`);
      NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
      if (pdftoppm) {
        run(
          "pdftoppm",
          [
            "-png",
            "-f",
            "1",
            "-l",
            "1",
            "-scale-to-x",
            String(width),
            "-scale-to-y",
            "-1",
            "-singlefile",
            "main.pdf",
            "page",
          ],
          work,
        );
        NodeFS.copyFileSync(NodePath.join(work, "page.png"), output);
      } else {
        run(
          "sips",
          ["-s", "format", "png", "--resampleWidth", String(width), "main.pdf", "--out", output],
          work,
        );
      }
    }
    console.log(`${id}: first page rendered`);
  }
  NodeFS.mkdirSync(previews, { recursive: true });
  NodeFS.cpSync(NodePath.join(batch, "images"), previews, { recursive: true });
} finally {
  NodeFS.rmSync(batch, { recursive: true, force: true });
}
