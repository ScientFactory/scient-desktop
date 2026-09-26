import type {
  PdfSourceDescriptor,
  PdfSourceResolution,
  ResolvedPdfSource,
} from "@scientfactory/document-artifacts";
import { useMemo, useState } from "react";

import type { PresentedPdfSource } from "./useScientPdfReader";

type SuccessfulPdfSourceResolution = Extract<PdfSourceResolution, { readonly _tag: "Success" }>;

interface PresentedPdfSourceBundle {
  readonly documentKey: string;
  readonly revisionId: string | null;
  readonly source: PdfSourceDescriptor;
  readonly resolved: ResolvedPdfSource;
}

interface PresentedPdfSourceHistory {
  readonly bundles: readonly PresentedPdfSourceBundle[];
  readonly presentation: PresentedPdfSource | null;
  readonly requested: PresentedPdfSourceBundle;
}

function matchesPresentation(
  bundle: PresentedPdfSourceBundle | null,
  presentation: PresentedPdfSource | null,
): bundle is PresentedPdfSourceBundle {
  return (
    bundle !== null &&
    presentation !== null &&
    bundle.documentKey === presentation.documentKey &&
    bundle.revisionId === presentation.revisionId &&
    bundle.resolved.url === presentation.sourceUrl
  );
}

function samePresentation(
  left: PresentedPdfSource | null,
  right: PresentedPdfSource | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.documentKey === right.documentKey &&
      left.revisionId === right.revisionId &&
      left.sourceUrl === right.sourceUrl)
  );
}

/** Keep source actions bound to the PDF which actually owns the painted canvas. */
export function usePresentedPdfSourceBundle(input: {
  readonly documentKey: string;
  readonly source: PdfSourceDescriptor;
  readonly asset: SuccessfulPdfSourceResolution;
  readonly presentation: PresentedPdfSource | null;
}): PresentedPdfSourceBundle | null {
  const revisionId = input.source._tag === "generated-pdf" ? input.source.revisionId : null;
  const requested = useMemo<PresentedPdfSourceBundle>(
    () => ({
      documentKey: input.documentKey,
      revisionId,
      source: input.source,
      resolved: {
        url: input.asset.url,
        expiresAt: input.asset.expiresAt,
        refresh: input.asset.refresh,
        ...(input.asset.sourcePath === undefined ? {} : { sourcePath: input.asset.sourcePath }),
      },
    }),
    [
      input.asset.expiresAt,
      input.asset.refresh,
      input.asset.sourcePath,
      input.asset.url,
      input.documentKey,
      input.source,
      revisionId,
    ],
  );
  const [history, setHistory] = useState<PresentedPdfSourceHistory>(() => ({
    bundles: [requested],
    presentation: input.presentation,
    requested,
  }));
  // A guarded render transition makes the action source change in the same
  // commit as the painted presentation. Keep only that presentation and the
  // current request, so rapid superseding revisions cannot accumulate.
  if (
    history.requested !== requested ||
    !samePresentation(history.presentation, input.presentation)
  ) {
    const painted = history.bundles.find((bundle) =>
      matchesPresentation(bundle, input.presentation),
    );
    const requestIsPainted = matchesPresentation(requested, input.presentation);
    setHistory({
      bundles:
        painted === undefined || requestIsPainted || painted === requested
          ? [requested]
          : [painted, requested],
      presentation: input.presentation,
      requested,
    });
  }

  return history.bundles.find((bundle) => matchesPresentation(bundle, input.presentation)) ?? null;
}
