import { LatexSelect } from "./LatexSelect";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { useProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import { Button } from "~/components/ui/button";
import { useAssetUrlState } from "~/assets/assetUrls";
import type { AssetResource } from "@t3tools/contracts";
import { uploadLatexImage } from "./imageUpload";
import { latexFigureSource } from "./figureSource";

export function LatexFigureInsertDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  source: string;
  onInsert: (source: string) => void;
  onCancel?: () => void;
}) {
  const pending = useRef<string | null>(null);
  const uploading = useRef(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!uploading.current) props.onOpenChange(open);
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const source = pending.current;
        pending.current = null;
        if (source !== null) props.onInsert(source);
        else props.onCancel?.();
      }}
    >
      <DialogPopup
        className="w-[min(560px,calc(100vw-32px))]"
        padding="none"
        gap="none"
        finalFocus={false}
        data-dock-command-scope="latex"
      >
        <DialogHeader>
          <DialogTitle>Insert a figure</DialogTitle>
          <DialogDescription>
            Choose a project image or import one. Add an optional caption and preview it before
            inserting.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="scient-writing-dialog">
            {props.open ? (
              <FigurePicker
                {...props}
                onBusyChange={(busy) => {
                  uploading.current = busy;
                }}
                onInsert={(source) => {
                  pending.current = source;
                  props.onOpenChange(false);
                }}
              />
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function FigurePicker(
  props: Parameters<typeof LatexFigureInsertDialog>[0] & { onBusyChange: (busy: boolean) => void },
) {
  const files = useProjectEntriesQuery(props.environmentId, props.cwd);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [caption, setCaption] = useState("");
  const [width, setWidth] = useState(80);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!localFile) {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(localFile);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localFile]);
  const resource = useMemo<AssetResource | null>(
    () =>
      path && !localFile ? { _tag: "workspace-file", cwd: props.cwd, relativePath: path } : null,
    [path, localFile, props.cwd],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const preview = localUrl ?? (asset._tag === "Success" ? asset.url : null);
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
  const valid = Boolean(localFile) || images.some((image) => image.path === path);
  const insert = async () => {
    if (!valid || pendingUpload) return;
    setError(null);
    let assetPath = path;
    if (localFile) {
      setPendingUpload(true);
      props.onBusyChange(true);
      try {
        const result = await uploadLatexImage(props.environmentId, {
          cwd: props.cwd,
          documentRelativePath: props.relativePath,
          file: localFile,
        });
        assetPath = result.relativePath;
        if (!live.current) return;
        files.refresh();
      } catch {
        props.onBusyChange(false);
        if (live.current) {
          setPendingUpload(false);
          setError("Could not import the image. Use a PNG or JPEG under 20 MB.");
        }
        return;
      }
      setPendingUpload(false);
      props.onBusyChange(false);
    }
    props.onInsert(
      latexFigureSource({
        documentPath: props.relativePath,
        assetPath,
        source: props.source,
        caption,
        width,
      }),
    );
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void insert();
      }}
    >
      <label className="scient-writing-field">
        Import from computer
        <input
          type="file"
          accept="image/png,image/jpeg"
          disabled={pendingUpload}
          onChange={(event) => {
            setLocalFile(event.target.files?.[0] ?? null);
            setPath("");
            setError(null);
          }}
        />
      </label>
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
              disabled={pendingUpload}
              onClick={() => {
                setPath(image.path);
                setLocalFile(null);
              }}
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
      {preview && (localFile || !/\.pdf$/iu.test(path)) && (
        <div className="scient-latex-insert-image-preview">
          <img src={preview} alt={caption || localFile?.name || path} />
        </div>
      )}
      {localFile && <p>{localFile.name}</p>}
      {error && <p role="alert">{error}</p>}
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
        <LatexSelect
          value={width}
          onValueChange={(value) => setWidth(Number(value))}
          aria-label="Figure width"
          options={[25, 50, 75, 80, 100].map((value) => ({
            value: String(value),
            label: `${value}% of text width`,
          }))}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={pendingUpload}
        onClick={() => props.onOpenChange(false)}
      >
        Cancel
      </Button>
      <button className="scient-writing-primary" type="submit" disabled={!valid || pendingUpload}>
        {pendingUpload ? "Importing image…" : "Insert figure"}
      </button>
    </form>
  );
}
