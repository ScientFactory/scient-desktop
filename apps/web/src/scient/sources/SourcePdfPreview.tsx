import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileText, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import type { AssetUrlState as RuntimeAssetUrlState } from "@t3tools/client-runtime/state/assets";
import type { AssetUrlState } from "../../assets/assetUrls";
import { Button } from "../../components/ui/button";
import { workspacePdfSource } from "../pdf/pdfSource";
import { readScientSourceAttachmentPreview } from "./client";

import "../pdf/scientPdfReader.css";

const ScientPdfReader = lazy(() =>
  import("../pdf/ScientPdfReader").then((module) => ({ default: module.ScientPdfReader })),
);

type SourcePreviewAssetState = AssetUrlState & {
  readonly requestKey: string;
};
/** Held without its retry, which the render attaches. */
type StoredSourcePreviewAsset = RuntimeAssetUrlState & {
  readonly requestKey: string;
  readonly waiting?: boolean;
};

export function SourcePdfPreview(props: {
  readonly readerScope?: string | undefined;
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly root: string;
  readonly sourceId: string;
}) {
  const requestKey = `${props.environmentId}\0${props.root}\0${props.sourceId}\0${props.attachmentId}`;
  const [request, setRequest] = useState(0);
  const authorizationAttempt = useRef(0);
  const [asset, setAsset] = useState<StoredSourcePreviewAsset>({
    _tag: "Loading",
    requestKey,
  });
  const refresh = useStableCallback(() => {
    authorizationAttempt.current += 1;
    setAsset((previous) =>
      previous._tag === "Loading" ? previous : { ...previous, waiting: true },
    );
    setRequest((current) => current + 1);
  });

  // A new document starts loading; a retry of the same one keeps it, waiting.
  const [previousRequest, setPreviousRequest] = useState({ requestKey, request });
  if (previousRequest.requestKey !== requestKey || previousRequest.request !== request) {
    setPreviousRequest({ requestKey, request });
    setAsset((previous) =>
      previous.requestKey === requestKey && previous._tag !== "Loading"
        ? { ...previous, waiting: true }
        : { _tag: "Loading", requestKey },
    );
  }

  const previewRequest = {
    attachmentId: props.attachmentId,
    environmentId: props.environmentId,
    root: props.root,
    sourceId: props.sourceId,
    requestKey,
    request,
  };
  useEffect(() => {
    let current = true;
    const attempt = authorizationAttempt.current;
    const { attachmentId, environmentId, root, sourceId, requestKey } = previewRequest;
    void readScientSourceAttachmentPreview(environmentId, {
      root,
      sourceId,
      attachmentId,
    }).then(
      (result) => {
        if (current && attempt === authorizationAttempt.current) {
          setAsset({
            _tag: "Success",
            url: result.url,
            expiresAt: result.expiresAt,
            ...(result.sourcePath ? { sourcePath: result.sourcePath } : {}),
            requestKey,
          });
        }
      },
      () => {
        if (current && attempt === authorizationAttempt.current) {
          setAsset({ _tag: "Failure", requestKey });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [previewRequest]);

  const currentAsset: SourcePreviewAssetState = {
    ...(asset.requestKey === requestKey ? asset : { _tag: "Loading", requestKey }),
    refresh,
  };
  const sourceRelativePath =
    currentAsset._tag === "Success" && currentAsset.waiting !== true
      ? (currentAsset.sourcePath ?? null)
      : null;

  const requestedSource =
    currentAsset._tag === "Success" && sourceRelativePath
      ? workspacePdfSource({
          environmentId: props.environmentId,
          fileName: props.fileName,
          workspaceRoot: props.root,
          relativePath: sourceRelativePath,
        })
      : null;
  // Keyed by its inputs, not its identity: a reauthorization keeps the open reader.
  const requestedSourceKey =
    requestedSource === null
      ? null
      : `${props.environmentId}\0${props.fileName}\0${props.root}\0${sourceRelativePath}`;
  const [retainedSource, setRetainedSource] = useState<{
    requestKey: string;
    sourceKey: string;
    source: NonNullable<typeof requestedSource>;
  } | null>(null);
  if (
    requestedSource !== null &&
    requestedSourceKey !== null &&
    (retainedSource?.requestKey !== requestKey || retainedSource.sourceKey !== requestedSourceKey)
  ) {
    setRetainedSource({ requestKey, sourceKey: requestedSourceKey, source: requestedSource });
  }
  const source =
    requestedSource ?? (retainedSource?.requestKey === requestKey ? retainedSource.source : null);
  const resolver: PdfSourceResolver = { useResolve: () => currentAsset };
  if (source === null) {
    return (
      <div className="scient-pdf-reader">
        <div
          className="scient-pdf-state-card"
          role={currentAsset._tag === "Failure" ? "alert" : undefined}
        >
          {currentAsset._tag === "Failure" ? (
            <>
              <FileText className="size-6 text-muted-foreground/70" aria-hidden="true" />
              <h2>Couldn't open this PDF</h2>
              <p>Scient could not create an authorized preview for this file.</p>
              <Button
                size="xs"
                variant="outline"
                disabled={currentAsset.waiting === true}
                aria-busy={currentAsset.waiting === true}
                onClick={refresh}
              >
                Try again
              </Button>
            </>
          ) : (
            <>
              <LoaderCircle
                className="size-6 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              <p>Preparing PDF…</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <Suspense fallback={null}>
      <ScientPdfReader source={source} resolver={resolver} readerScope={props.readerScope} />
    </Suspense>
  );
}
