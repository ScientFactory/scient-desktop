import { parseDiffFromFile } from "@pierre/diffs";
import type { ScientOverleafDiffFile, ScientOverleafDiffResult } from "@t3tools/contracts";

import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";

const REASONS = {
  binary: "Binary file; diff not shown.",
  "file-too-large": "File is too large to preview.",
  "total-limit": "Review preview limit reached; diff not shown.",
};

function DiffGroup(props: {
  readonly title: string;
  readonly files: ReadonlyArray<ScientOverleafDiffFile>;
}) {
  const theme = useRenderedAppearance();
  const items = props.files.flatMap((file) =>
    file._tag === "text"
      ? [
          {
            id: file.path,
            type: "diff" as const,
            fileDiff: parseDiffFromFile(
              file.before === null ? null : { name: file.path, contents: file.before },
              file.after === null ? null : { name: file.path, contents: file.after },
            ),
          },
        ]
      : [],
  );
  return (
    <section aria-label={props.title} className="flex flex-col gap-2">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      {items.length > 0 ? (
        <div className="h-80 min-h-0 overflow-hidden rounded-md border border-border/60">
          <StyledDiffCodeView
            items={items}
            className="h-full"
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "wrap",
              theme: resolveDiffThemeName(theme),
              themeType: theme,
            }}
          />
        </div>
      ) : props.files.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">No changes.</p>
      ) : null}
      {props.files.map((file) =>
        file._tag === "not-shown" ? (
          <p key={file.path} className="px-1 text-xs text-muted-foreground">
            {file.path}: {REASONS[file.reason]}
          </p>
        ) : null,
      )}
    </section>
  );
}

export function OverleafReviewDiff(props: { readonly result: ScientOverleafDiffResult }) {
  if (props.result._tag === "stale")
    return (
      <p role="status" className="px-1 text-sm text-muted-foreground">
        This review is no longer current. Check again to see its diff.
      </p>
    );
  return (
    <div className="flex flex-col gap-4" aria-label="Overleaf line changes">
      <p className="px-1 text-xs text-muted-foreground">
        Compared with the last sync. To Overleaf includes the combined version this sync would send.
      </p>
      <DiffGroup title="From Overleaf" files={props.result.incoming} />
      <DiffGroup title="To Overleaf" files={props.result.outgoing} />
    </div>
  );
}
