// FILE: ChangedFilesCompactPreview.tsx
// Purpose: Shows a bounded, directly actionable orientation preview for a bulky current change.
// Layer: Web chat changed-files UI
// Exports: ChangedFilesCompactPreview

import { memo, useMemo, type CSSProperties } from "react";

import type { TurnDiffFileChange } from "../../types";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { selectChangedFilePreview } from "./changedFilesPresentation";

function accessibleFileStatLabel(file: TurnDiffFileChange): string {
  const additions = Math.max(0, file.additions ?? 0);
  const deletions = Math.max(0, file.deletions ?? 0);
  if (additions + deletions === 0) {
    return file.path;
  }
  return `${file.path}, ${additions} ${additions === 1 ? "addition" : "additions"}, ${deletions} ${deletions === 1 ? "deletion" : "deletions"}`;
}

export const ChangedFilesCompactPreview = memo(function ChangedFilesCompactPreview(props: {
  files: ReadonlyArray<TurnDiffFileChange>;
  resolvedTheme: "light" | "dark";
  fontSize: CSSProperties["fontSize"];
  onOpenFile: (filePath: string) => void;
  onShowAll: () => void;
}) {
  const { files, resolvedTheme, fontSize, onOpenFile, onShowAll } = props;
  const previewItems = useMemo(() => selectChangedFilePreview(files), [files]);
  if (previewItems.length === 0) {
    return null;
  }

  return (
    <div
      className="border-t border-[color:var(--color-border-light)] bg-transparent px-2 py-1.5"
      role="group"
      aria-label={`Previewing ${previewItems.length} of ${files.length} changed ${files.length === 1 ? "file" : "files"}`}
      data-changed-files-preview="true"
    >
      <div className="space-y-0.5">
        {previewItems.map(({ file, label }) => {
          const additions = Math.max(0, file.additions ?? 0);
          const deletions = Math.max(0, file.deletions ?? 0);
          return (
            <button
              key={file.path}
              type="button"
              title={file.path}
              aria-label={accessibleFileStatLabel(file)}
              className="group/preview-file flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              style={{ fontSize }}
              onClick={() => onOpenFile(file.path)}
            >
              <FileEntryIcon
                pathValue={file.path}
                kind="file"
                theme={resolvedTheme}
                colorMode="inherit"
                className="size-3.5 shrink-0 opacity-75 transition-opacity group-hover/preview-file:opacity-100 group-focus-visible/preview-file:opacity-100"
              />
              <span dir="ltr" className="min-w-0 truncate font-system-ui text-left font-normal">
                {label}
              </span>
              {additions + deletions > 0 ? (
                <span className="ml-auto shrink-0 font-system-ui tabular-nums" aria-hidden="true">
                  <DiffStatLabel additions={additions} deletions={deletions} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-1 flex w-full items-center justify-start gap-1.5 rounded-md px-1.5 py-1.5 font-system-ui font-normal text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ fontSize }}
        aria-label={`Show all ${files.length} changed ${files.length === 1 ? "file" : "files"}`}
        onClick={onShowAll}
      >
        <DisclosureChevron open={false} />
        <span>
          Show all {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </button>
    </div>
  );
});
