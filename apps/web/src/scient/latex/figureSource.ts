import { escapeDocumentText } from "../documents/documentTemplates";

export function relativeLatexImagePath(documentPath: string, assetPath: string) {
  const parent = documentPath.replaceAll("\\", "/").split("/").slice(0, -1);
  const target = assetPath.replaceAll("\\", "/").split("/");
  while (parent.length && target.length && parent[0] === target[0]) {
    parent.shift();
    target.shift();
  }
  return [...parent.map(() => ".."), ...target].join("/");
}

export function latexFigureSource(input: {
  readonly documentPath: string;
  readonly assetPath: string;
  readonly source: string;
  readonly caption?: string;
  readonly width?: number;
}) {
  const slug =
    input.assetPath
      .split("/")
      .at(-1)!
      .replace(/\.[^.]+$/u, "")
      .replace(/[^A-Za-z0-9-]/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 50) || "image";
  const labels = new Set(
    [...input.source.matchAll(/\\label\{([^{}]+)\}/gu)].map((match) => match[1]),
  );
  let label = `fig:${slug}`,
    suffix = 2;
  while (labels.has(label)) label = `fig:${slug}-${suffix++}`;
  const caption = escapeDocumentText(input.caption ?? "");
  const path = relativeLatexImagePath(input.documentPath, input.assetPath);
  return `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=${(input.width ?? 80) / 100}\\textwidth]{${path}}${caption ? `\n\\caption{${caption}}\n\\label{${label}}` : ""}\n\\end{figure}`;
}
