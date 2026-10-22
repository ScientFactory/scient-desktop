import type {
  AttachmentPdfLocator,
  PdfSourceActions,
  PdfSourceResolution,
  PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";

import { attachmentPdfSource, pdfSourceAssetResource, saveResolvedPdfCopy } from "./pdfSource";

import "./scientPdfReader.css";

const ScientPdfReader = lazy(() =>
  import("./ScientPdfReader").then((module) => ({ default: module.ScientPdfReader })),
);

const noRefresh = () => undefined;

const attachmentPdfActions: PdfSourceActions = {
  saveCopy: async (pdf, resolved) => {
    // Route by the presented URL, not the current props: a retained page can still show local bytes.
    if (!resolved.url.startsWith("blob:")) return saveResolvedPdfCopy(pdf, resolved);
    // Native copy accepts only HTTP(S) sources, so local bytes download in the renderer.
    const anchor = document.createElement("a");
    anchor.href = resolved.url;
    anchor.download = pdf.fileName;
    anchor.click();
    return { _tag: "download-started" };
  },
};

/**
 * A chat attachment PDF in Scient's reader. A draft that is not uploaded yet
 * reads its local bytes; everything else goes through the attachment's signed
 * asset URL, re-minted like any other reader source.
 */
export function AttachmentPdfPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly locator: AttachmentPdfLocator;
  /** The draft's local bytes, when it has them. */
  readonly file?: Blob | null;
}) {
  const localFile = props.locator._tag === "draft" ? (props.file ?? null) : null;
  const [localUrl, setLocalUrl] = useState<{ file: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!localFile) return;
    const url = URL.createObjectURL(localFile);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish an object URL only after its cleanup is registered for this Blob.
    setLocalUrl({ file: localFile, url });
    return () => URL.revokeObjectURL(url);
  }, [localFile]);

  // Callers rebuild the locator on every render, and the compiler caches by
  // reference, so the document is kept until one of its fields changes.
  const sourceKey = JSON.stringify([props.environmentId, props.fileName, props.locator]);
  const [retained, setRetained] = useState(() => ({
    key: sourceKey,
    source: attachmentPdfSource(props),
  }));
  if (retained.key !== sourceKey)
    setRetained({ key: sourceKey, source: attachmentPdfSource(props) });
  const source = retained.key === sourceKey ? retained.source : attachmentPdfSource(props);

  const currentLocalUrl = localFile && localUrl?.file === localFile ? localUrl.url : null;
  // Authorized here, not inside the resolver, so the hook path stays the same
  // when a draft gains its upload or loses its local bytes under a mounted reader.
  const remote = useAssetUrlState(
    props.environmentId,
    localFile ? null : pdfSourceAssetResource(source),
  );
  const resolution: PdfSourceResolution = !localFile
    ? remote
    : currentLocalUrl === null
      ? { _tag: "Loading", refresh: noRefresh }
      : {
          _tag: "Success",
          url: currentLocalUrl,
          expiresAt: Number.MAX_SAFE_INTEGER,
          refresh: noRefresh,
        };
  const resolver: PdfSourceResolver = { useResolve: () => resolution };

  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <ScientPdfReader
        source={source}
        resolver={resolver}
        actions={attachmentPdfActions}
        readerScope={props.locator.threadId}
      />
    </Suspense>
  );
}
