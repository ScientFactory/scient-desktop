import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { useProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { escapeDocumentText } from "../documents/documentTemplates";

function relativeAsset(documentPath: string, assetPath: string) {
  const parent = documentPath.replaceAll("\\", "/").split("/").slice(0, -1);
  const target = assetPath.replaceAll("\\", "/").split("/");
  while (parent.length && target.length && parent[0] === target[0]) {
    parent.shift();
    target.shift();
  }
  return [...parent.map(() => ".."), ...target].join("/");
}

export function LatexFigureInsertDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  source: string;
  onInsert: (source: string) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="scient-writing-dialog">
        <DialogTitle>Insert a figure</DialogTitle>
        <DialogDescription>
          Choose an image already in this project. Its caption and size can be edited after
          insertion.
        </DialogDescription>
        {props.open ? <FigurePicker {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function FigurePicker(props: Parameters<typeof LatexFigureInsertDialog>[0]) {
  const files = useProjectEntriesQuery(props.environmentId, props.cwd);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [caption, setCaption] = useState("");
  const [width, setWidth] = useState(80);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const images = (files.data?.entries ?? []).filter(
    (entry) =>
      entry.kind === "file" &&
      /\.(?:png|jpe?g|pdf)$/iu.test(entry.path) &&
      !/[{}\\%#\r\n]/u.test(entry.path),
  );
  const valid = images.some((image) => image.path === path);
  const insert = () => {
    if (!valid) return;
    const slug =
      path
        .split("/")
        .at(-1)!
        .replace(/\.[^.]+$/u, "")
        .replace(/[^A-Za-z0-9-]/gu, "-")
        .slice(0, 50) || "image";
    const labels = new Set(
      [...props.source.matchAll(/\\label\{([^{}]+)\}/gu)].map((match) => match[1]),
    );
    let label = `fig:${slug}`,
      suffix = 2;
    while (labels.has(label)) label = `fig:${slug}-${suffix++}`;
    const source = `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=${width / 100}\\textwidth]{${relativeAsset(props.relativePath, path)}}\n\\caption{${escapeDocumentText(caption || "Figure caption")}}\n\\label{${label}}\n\\end{figure}`;
    props.onOpenChange(false);
    requestAnimationFrame(() => props.onInsert(source));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        insert();
      }}
    >
      <input
        ref={input}
        className="scient-writing-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Find a PNG, JPEG, or PDF image…"
        aria-label="Find project image"
      />
      <div className="scient-writing-choices">
        {images
          .filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase()))
          .map((image) => (
            <button
              type="button"
              key={image.path}
              aria-pressed={path === image.path}
              onClick={() => setPath(image.path)}
            >
              <span>
                <strong>{image.path.split("/").at(-1)}</strong>
                <small>{image.path}</small>
              </span>
            </button>
          ))}
        {images.length === 0 ? (
          <p>
            {files.isPending
              ? "Loading images…"
              : "Add an image to your project folder, then refresh this list."}
          </p>
        ) : null}
      </div>
      {files.error ? <p role="alert">{files.error}</p> : null}
      {files.data?.truncated ? <p>Some project files aren’t listed.</p> : null}
      <button type="button" onClick={files.refresh}>
        Refresh images
      </button>
      <label className="scient-writing-field">
        Caption
        <input
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Describe the figure"
        />
      </label>
      <label className="scient-writing-field">
        Width
        <select value={width} onChange={(event) => setWidth(Number(event.target.value))}>
          {[25, 50, 75, 80, 100].map((value) => (
            <option key={value} value={value}>
              {value}% of text width
            </option>
          ))}
        </select>
      </label>
      <button className="scient-writing-primary" type="submit" disabled={!valid}>
        Insert figure
      </button>
    </form>
  );
}
