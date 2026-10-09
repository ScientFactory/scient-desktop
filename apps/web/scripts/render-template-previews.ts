// Renders the first page of each built-in LaTeX template to
// src/scient/documents/previews/<id>.png, the picture a template's card shows.
// Run after changing a template: `node apps/web/scripts/render-template-previews.ts`.
// Needs latexmk (TeX Live, MacTeX or TinyTeX), and pdftoppm or, on macOS, sips.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const documents = NodePath.resolve(import.meta.dirname, "../src/scient/documents");
const templates = NodePath.join(documents, "templates");
const previews = NodePath.join(documents, "previews");
/** Twice the card's width, for sharp pictures on high-density screens. */
const WIDTH = 360;

function has(command: string): boolean {
  return NodeChildProcess.spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
}

if (!has("latexmk")) throw new Error("latexmk is needed to typeset the templates.");
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

NodeFS.mkdirSync(previews, { recursive: true });
for (const { id, folder } of entries) {
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `scient-template-${id}-`));
  if (folder) NodeFS.cpSync(folder, work, { recursive: true });
  else NodeFS.copyFileSync(NodePath.join(templates, `${id}.tex`), NodePath.join(work, "main.tex"));
  const main = NodePath.join(work, "main.tex");
  // The placeholders Visual shows in an empty title, as print.
  NodeFS.writeFileSync(
    main,
    NodeFS.readFileSync(main, "utf8")
      .replace("<<SCIENT_TITLE>>", "Title")
      .replace("<<SCIENT_AUTHOR_BLOCK>>", "Author"),
  );
  NodeFS.writeFileSync(NodePath.join(work, "references.bib"), "");
  run(
    "latexmk",
    ["-pdf", "-norc", "-interaction=nonstopmode", "-no-shell-escape", "main.tex"],
    work,
  );
  const output = NodePath.join(previews, `${id}.png`);
  if (pdftoppm) {
    run(
      "pdftoppm",
      [
        "-png",
        "-f",
        "1",
        "-l",
        "1",
        "-scale-to",
        String(Math.round(WIDTH * Math.SQRT2)),
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
      ["-s", "format", "png", "--resampleWidth", String(WIDTH), "main.pdf", "--out", output],
      work,
    );
  }
  NodeFS.rmSync(work, { recursive: true, force: true });
  console.log(`${id}: ${NodePath.relative(process.cwd(), output)}`);
}
