import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// The JSON keeps the TeX recipe alongside each generated outline. Regenerate
// with TeX Live's latex/dvisvgm on PATH (or LATEX_BIN / DVISVGM_BIN overrides).
const atlasPath = NodeURL.fileURLToPath(
  new URL("../apps/web/src/scient/latex/mathSymbolGlyphs.json", import.meta.url),
);
const atlas = JSON.parse(NodeFS.readFileSync(atlasPath, "utf8"));
const workPrefix = NodePath.join(NodeOS.tmpdir(), "scient-symbol-glyphs-");
const work = NodeFS.mkdtempSync(workPrefix);
if (!NodePath.resolve(work).startsWith(NodePath.resolve(workPrefix)))
  throw new Error("Unexpected temporary directory");

function run(executable, args) {
  const result = NodeChildProcess.spawnSync(executable, args, {
    cwd: work,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable}:\n${result.stdout}\n${result.stderr}`);
  return result.stderr;
}

function outline(svg) {
  const viewBox = /viewBox=['"]([^'"]+)['"]/u.exec(svg)?.[1];
  const body = /<svg\b[^>]*>([\s\S]*)<\/svg>/u.exec(svg)?.[1]?.trim();
  if (!viewBox || !body || !/<path\b/u.test(body)) throw new Error("Missing glyph outline");
  // Only self-contained path geometry is admitted to the runtime atlas.
  if (/<\/?(?!defs\b|path\b|g\b|use\b)[A-Za-z]/u.test(body)) {
    throw new Error("Unexpected element in glyph outline");
  }
  if (/\bon\w+\s*=|(?:href=['"])(?!#)/u.test(body)) throw new Error("Unsafe SVG reference");
  const [x, y, width, height] = viewBox.split(/\s+/u).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error(`Invalid glyph dimensions: ${viewBox}`);
  }
  // Preserve ordinary glyph scale; very short arrows should remain short.
  // Large expressions still fit the same square tile, with a little breathing room.
  const side = Math.max(14, width + 2, height + 2);
  return {
    viewBox: [x + (width - side) / 2, y + (height - side) / 2, side, side]
      .map((value) => Number(value.toFixed(4)))
      .join(" "),
    body: body.replace(/\s+/gu, " "),
  };
}

try {
  const groups = new Map();
  for (const [id, glyph] of Object.entries(atlas)) {
    const key = glyph.packages.join(",");
    const entries = groups.get(key) ?? [];
    entries.push([id, glyph]);
    groups.set(key, entries);
  }
  let groupIndex = 0;
  for (const [packages, entries] of groups) {
    const name = `glyphs-${groupIndex++}`;
    const source = [
      "\\documentclass{article}",
      "\\usepackage{amsmath,amssymb,graphicx}",
      ...(packages ? [`\\usepackage{${packages}}`] : []),
      "\\pagestyle{empty}",
      "\\begin{document}",
      ...entries.map(([, glyph]) => {
        // Some Type 1 converters drop St Mary's character-zero left arrow.
        // Its mirrored right-arrow counterpart has the same font geometry.
        const latex =
          glyph.latex === "\\shortleftarrow"
            ? "\\mathrel{\\reflectbox{$\\shortrightarrow$}}"
            : glyph.latex;
        return `\\noindent $${latex}$\\newpage`;
      }),
      "\\end{document}",
    ].join("\n");
    NodeFS.writeFileSync(NodePath.join(work, `${name}.tex`), source);
    run(process.env.LATEX_BIN || "latex", [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-no-shell-escape",
      `${name}.tex`,
    ]);
    const svgLog = run(process.env.DVISVGM_BIN || "dvisvgm", [
      "--no-fonts",
      "--exact-bbox",
      "--currentcolor",
      "--page=1-",
      "--output=" + name + "-%p.svg",
      `${name}.dvi`,
    ]);
    const pages = new Map(
      NodeFS.readdirSync(work)
        .filter((file) => file.startsWith(`${name}-`) && file.endsWith(".svg"))
        .map((file) => [Number(file.slice(name.length + 1, -4)), file]),
    );
    entries.forEach(([id, glyph], index) => {
      const file = pages.get(index + 1);
      if (!file) throw new Error(`Missing generated page for ${id}`);
      try {
        atlas[id] = {
          ...glyph,
          ...outline(NodeFS.readFileSync(NodePath.join(work, file), "utf8")),
        };
      } catch (error) {
        throw new Error(
          `Cannot generate ${id}:\n${svgLog}\n${NodeFS.readFileSync(NodePath.join(work, file), "utf8")}`,
          { cause: error },
        );
      }
    });
  }
  NodeFS.writeFileSync(atlasPath, JSON.stringify(atlas, null, 2) + "\n");
  console.log(`Generated ${Object.keys(atlas).length} bundled math glyphs.`);
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
