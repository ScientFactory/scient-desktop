import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileText, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

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
  readonly attachmentId: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly root: string;
  readonly sourceId: string;
}) {
  const requestKey = `${props.environmentId}\0${props.root}\0${props.sourceId}\0${props.attachmentId}`;
  const [request, setRequest] = useState(0);
  const refresh = useCallback(() => setRequest((current) => current + 1), []);
  const [asset, setAsset] = useState<SourcePreviewAssetState>({
    _tag: "Loading",
    requestKey,
    refresh,
  });

  useEffect(() => {
    let current = true;
    setAsset({ _tag: "Loading", requestKey, refresh });
    void readScientSourceAttachmentPreview(props.environmentId, {
      root: props.root,
      sourceId: props.sourceId,
      attachmentId: props.attachmentId,
    }).then(
      (result) => {
        if (current) {
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
        if (current) setAsset({ _tag: "Failure", requestKey, refresh });
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
    currentAsset._tag === "Success" ? (currentAsset.sourcePath ?? null) : null;

  const source = useMemo(
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
  const resolver = useMemo<PdfSourceResolver>(
    () => ({ useResolve: () => currentAsset }),
    [currentAsset],
  );
  if (source === null) {
    return (
      <div className="scient-pdf-reader">
        <div
          className={
            currentAsset._tag === "Failure"
              ? "scient-pdf-state-card text-destructive"
              : "scient-pdf-state-card"
          }
        >
          {currentAsset._tag === "Failure" ? (
            <>
              <FileText className="size-6" aria-hidden="true" />
              <h2>Unable to open PDF</h2>
              <p>Scient could not create an authorized preview for this file.</p>
              <Button size="xs" variant="outline" onClick={refresh}>
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
      <ScientPdfReader source={source} resolver={resolver} />
    </Suspense>
  );
}
