import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileCitation } from "@t3tools/contracts";
import { MarkdownSourceSurface, useFileLineReveal } from "~/components/files/FilePreviewPanel";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { toastManager } from "~/components/ui/toast";
import { StaticTextFileSurface } from "../fileSurfaces/StaticTextFileSurface";
import { latexSourceRevealRange } from "./latexSourceRevealRange";
import { useMarkdownPersistenceLease } from "../markdownEditor/persistence/useMarkdownPersistenceLease";
import { resolveLatexCitationSource } from "./latexVisualSelection";
import { sourcePositionFromPointerEvent } from "./latexSourceNavigation";

export interface LatexVisualSourceReveal {
  readonly path: string;
  readonly requestId: number;
  readonly line?: number;
  readonly from?: number;
  readonly to?: number;
  readonly citation?: FileCitation;
  readonly source?: string;
  readonly rootRelativePath?: string;
  readonly precise?: boolean;
  readonly column?: number | null;
  readonly selectedText?: string;
  /** PDF coordinates belong only to this admitted, unedited source revision. */
  readonly sourceRevision?: string;
}

/** Reveal source in Split without replacing or focusing the preview. */
export function LatexVisualSourcePane(
  props: Pick<
    Parameters<typeof MarkdownSourceSurface>[0],
    | "environmentId"
    | "cwd"
    | "composerDraftTarget"
    | "resolvedTheme"
    | "wordWrap"
    | "threadRef"
    | "onCite"
  > & {
    reveal: LatexVisualSourceReveal;
    onNavigateVisual?: ((source: string, line: number) => void) | undefined;
  },
) {
  const { environmentId, cwd, reveal } = props;
  const query = useProjectFileQuery(environmentId, cwd, reveal.path);
  const target = useMemo(
    () => ({ environmentId, cwd, relativePath: reveal.path }),
    [environmentId, cwd, reveal.path],
  );
  const { lease, snapshot, admissionError } = useMarkdownPersistenceLease({
    target,
    authoritativeSnapshot: query.authoritativeData,
  });
  const disk = query.authoritativeData;
  const source =
    snapshot?.draftSource ?? (disk?.readOnly || disk?.truncated ? disk.contents : undefined);
  const compiledRevealCurrent =
    reveal.sourceRevision === undefined ||
    (disk?.revision === reveal.sourceRevision &&
      !disk.truncated &&
      !query.isPending &&
      query.readError === null &&
      (lease !== null || disk.readOnly) &&
      (snapshot === null ||
        (!snapshot.pending &&
          !snapshot.reading &&
          !snapshot.currentMissing &&
          !snapshot.editingBlocked &&
          snapshot.error === null &&
          snapshot.conflict === null &&
          snapshot.baselineRevision === reveal.sourceRevision &&
          snapshot.draftSource === snapshot.baselineSource)));
  const [rejectedCompiledReveal, setRejectedCompiledReveal] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (
      reveal.sourceRevision !== undefined &&
      disk !== null &&
      !query.isPending &&
      !snapshot?.reading &&
      (lease !== null || disk.readOnly) &&
      !compiledRevealCurrent
    )
      setRejectedCompiledReveal(reveal.requestId);
  }, [reveal, disk, query.isPending, snapshot?.reading, lease, compiledRevealCurrent]);
  const revealCurrent = compiledRevealCurrent && rejectedCompiledReveal !== reveal.requestId;
  const range = useMemo(
    () =>
      source === undefined || !revealCurrent
        ? null
        : reveal.citation
          ? resolveLatexCitationSource(source, reveal.citation)
          : latexSourceRevealRange(source, reveal),
    [source, reveal, revealCurrent],
  );
  const line =
    source !== undefined && range
      ? source.slice(0, range.from).split("\n").length
      : (reveal.line ?? reveal.citation?.startLine ?? null);
  const endLine =
    source !== undefined && range
      ? source.slice(0, Math.max(range.from, range.to - 1)).split("\n").length
      : line;
  const [dismissedRequest, setDismissedRequest] = useState<number | null>(null);
  const navigationMarked =
    revealCurrent && !reveal.citation && dismissedRequest !== reveal.requestId;
  const { onPostRender } = useFileLineReveal(
    reveal.path,
    reveal.citation || navigationMarked ? line : null,
    reveal.requestId,
    !!reveal.citation,
  );
  const selectionReveal = useMemo(
    () =>
      navigationMarked && range && source !== undefined
        ? { source, ...range, requestId: reveal.requestId }
        : undefined,
    [navigationMarked, range, source, reveal.requestId],
  );
  const dismissNavigation = () => {
    if (!reveal.citation) setDismissedRequest(reveal.requestId);
  };
  const warned = useRef<number | null>(null);
  useEffect(() => {
    if (source === undefined || !reveal.citation || range || warned.current === reveal.requestId)
      return;
    warned.current = reveal.requestId;
    toastManager.add({
      type: "warning",
      title: "The quoted source has changed",
      description:
        "Showing its recorded source line. The saved quote is unchanged; its exact location could not be verified.",
    });
  }, [source, reveal, range]);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onPointerDownCapture={dismissNavigation}
      onKeyDownCapture={dismissNavigation}
      onDoubleClickCapture={(event) => {
        const position = sourcePositionFromPointerEvent(event);
        const currentSource = lease?.getSnapshot().draftSource ?? source;
        if (position && currentSource !== undefined)
          props.onNavigateVisual?.(currentSource, position.line);
      }}
    >
      {lease ? (
        <MarkdownSourceSurface
          {...props}
          persistence={lease}
          relativePath={reveal.path}
          revealRequestId={reveal.requestId}
          onPostRender={onPostRender}
          retainSelectionOnBlur
          sourceSelectionReveal={selectionReveal}
          activeLineRange={
            line && endLine && reveal.citation ? { start: line, end: endLine } : null
          }
          citationReveal={reveal.citation}
          citationRootRelativePath={
            reveal.citation?.latex?.rootRelativePath ?? reveal.rootRelativePath
          }
        />
      ) : query.authoritativeData &&
        (query.authoritativeData.readOnly || query.authoritativeData.truncated) ? (
        <StaticTextFileSurface
          threadRef={props.threadRef}
          onCite={props.onCite}
          contents={query.authoritativeData.contents}
          cwd={cwd}
          relativePath={reveal.path}
          resolvedTheme={props.resolvedTheme}
          wordWrap={props.wordWrap}
          onPostRender={onPostRender}
        />
      ) : (
        <div role="status" className="p-3 text-sm text-muted-foreground">
          {query.error ?? (admissionError ? "Could not open the source file." : "Opening source…")}
        </div>
      )}
    </div>
  );
}
