import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileText, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const refresh = useCallback(() => {
    authorizationAttempt.current += 1;
    setAsset((previous) =>
      previous._tag === "Loading" ? previous : { ...previous, waiting: true },
    );
    setRequest((current) => current + 1);
  }, []);
  const [asset, setAsset] = useState<SourcePreviewAssetState>({
    _tag: "Loading",
    requestKey,
    refresh,
  });

  useEffect(() => {
    let current = true;
    const attempt = authorizationAttempt.current;
    setAsset((previous) =>
      previous.requestKey === requestKey && previous._tag !== "Loading"
        ? { ...previous, waiting: true }
        : { _tag: "Loading", requestKey, refresh },
    );
    void readScientSourceAttachmentPreview(props.environmentId, {
      root: props.root,
      sourceId: props.sourceId,
      attachmentId: props.attachmentId,
    }).then(
      (result) => {
        if (current && attempt === authorizationAttempt.current) {
          setAsset({
            _tag: "Success",
            url: result.url,
            expiresAt: result.expiresAt,
            ...(result.sourcePath ? { sourcePath: result.sourcePath } : {}),
            requestKey,
            refresh,
          });
        }
      },
      () => {
        if (current && attempt === authorizationAttempt.current) {
          setAsset({ _tag: "Failure", requestKey, refresh });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [
    props.attachmentId,
    props.environmentId,
    props.root,
    props.sourceId,
    refresh,
    request,
    requestKey,
  ]);

  const currentAsset: SourcePreviewAssetState =
    asset.requestKey === requestKey ? asset : { _tag: "Loading", requestKey, refresh };
  const sourceRelativePath =
    currentAsset._tag === "Success" && currentAsset.waiting !== true
      ? (currentAsset.sourcePath ?? null)
      : null;

  const requestedSource = useMemo(
    () =>
      currentAsset._tag === "Success" && sourceRelativePath
        ? workspacePdfSource({
            environmentId: props.environmentId,
            fileName: props.fileName,
            workspaceRoot: props.root,
            relativePath: sourceRelativePath,
          })
        : null,
    [currentAsset._tag, props.environmentId, props.fileName, props.root, sourceRelativePath],
  );
  const [retainedSource, setRetainedSource] = useState<{
    requestKey: string;
    source: NonNullable<typeof requestedSource>;
  } | null>(null);
  if (
    requestedSource !== null &&
    (retainedSource?.requestKey !== requestKey || retainedSource.source !== requestedSource)
  ) {
    setRetainedSource({ requestKey, source: requestedSource });
  }
  const source =
    requestedSource ?? (retainedSource?.requestKey === requestKey ? retainedSource.source : null);
  const resolver = useMemo<PdfSourceResolver>(
    () => ({ useResolve: () => currentAsset }),
    [currentAsset],
  );
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
