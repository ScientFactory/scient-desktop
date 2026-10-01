import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { useProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { latexFigureSource } from "./figureSource";

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
      <DialogPopup className="w-[min(560px,calc(100vw-32px))]" padding="none" gap="none">
        <DialogHeader>
          <DialogTitle>Insert a figure</DialogTitle>
          <DialogDescription>
            Choose an image already in this project. Its caption and size can be edited after
            insertion.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="scient-writing-dialog">
            {props.open ? <FigurePicker {...props} /> : null}
          </div>
        </DialogPanel>
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
    const source = latexFigureSource({
      documentPath: props.relativePath,
      assetPath: path,
      source: props.source,
      caption,
      width,
    });
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
