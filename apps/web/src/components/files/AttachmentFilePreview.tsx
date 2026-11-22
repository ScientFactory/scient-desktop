import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { readFilePreviewResponse } from "@t3tools/client-runtime/file-preview";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import {
  filePreviewKind,
  officePreviewKind,
  FILE_TEXT_PREVIEW_MAX_BYTES,
} from "@t3tools/shared/filePreview";
import {
  ChevronRightIcon,
  DownloadIcon,
  Trash2Icon,
  WrapTextIcon,
  XIcon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  EyeIcon,
  Table2Icon,
} from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { m, type MessageResolver } from "~/i18n/messages";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { mediaFailureCopy, UNSUPPORTED_PREVIEW_TITLE } from "~/scient/fileSurfaces/fileFailureCopy";

// SCIENT-FORK:START — attachment PDFs open in Scient's reader
import { AttachmentPdfPreview } from "~/scient/pdf/AttachmentPdfPreview";
import { attachmentPdfMount } from "~/scient/pdf/attachmentPdfMount";
// SCIENT-FORK:END

import { BinaryFilePreview } from "./BinaryFilePreview";
import { PreviewImage } from "./PreviewImage";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceMessage,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));

const OfficeFilePreview = lazy(() =>
  import("./OfficeFilePreview").then((module) => ({ default: module.OfficeFilePreview })),
);

const FontFilePreview = lazy(() =>
  import("./FontFilePreview").then((module) => ({ default: module.FontFilePreview })),
);

const MermaidFilePreview = lazy(() =>
  import("./MermaidFilePreview").then((module) => ({ default: module.MermaidFilePreview })),
);

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));

const STALE_URL_MS = 5 * 60_000;

export function ReadOnlySourcePreview(props: { name: string; text: string; wordWrap?: boolean }) {
  return (
    <Suspense fallback={<FileSurfaceLoading className="p-4" />}>
      <SourcePreview {...props} />
    </Suspense>
  );
}

function renderedToggleLabel(
  mode: "markdown" | "mermaid" | "html" | "table",
  rendered: boolean,
  resolve: MessageResolver,
): string {
  if (mode === "mermaid")
    return rendered ? resolve(msg("Show Mermaid source")) : resolve(msg("Show rendered diagram"));
  if (mode === "markdown")
    return rendered ? resolve(msg("Show markdown source")) : resolve(msg("Show rendered markdown"));
  if (mode === "table") return rendered ? resolve(msg("Show source")) : resolve(msg("Show table"));
  return rendered ? resolve(msg("Show HTML source")) : resolve(msg("Show rendered page"));
}

export function AttachmentFilePreview(props: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  file?: Blob | null;
  asset?:
    | { environmentId: EnvironmentId; attachmentId: string }
    | {
        environmentId: EnvironmentId;
        resource: Extract<
          AssetResource,
          { _tag: "media-file" | "draft-workspace-file" | "workspace-file" | "environment-file" }
        >;
      };
  htmlRender?: boolean;
  threadRef?: ScopedThreadRef;
  // SCIENT-FORK:START — names a draft attachment to Scient's PDF reader
  draftPdf?: { threadRef: ScopedThreadRef; contextId: string };
  // SCIENT-FORK:END
  origin?: string;
  // SCIENT-FORK:START — Scient's file panel already shows the name and save action above.
  embedded?: boolean;
  // SCIENT-FORK:END
  onSaveCopy?: (() => void) | undefined;
  onRemove?: () => void;
  onClose?: () => void;
}) {
  const kind = filePreviewKind(props);
  const officeKind = officePreviewKind(props);
  const delimiter = filePreviewDelimiter(props);
  const renderedMode =
    kind === "mermaid"
      ? "mermaid"
      : kind === "markdown"
        ? "markdown"
        : kind === "html"
          ? "html"
          : delimiter
            ? "table"
            : null;
  const attachmentId =
    props.asset && "attachmentId" in props.asset ? props.asset.attachmentId : undefined;
  const gt = useGT();
  const messages = useMessages();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(props.name),
  });
  // useAssetUrlRefresh keys its callback on these objects, so they must stay cached. Parents
  // rebuild `asset` on every render, so the attachment resource derives only from its fields.
  const assetResource = props.asset && "resource" in props.asset ? props.asset.resource : null;
  const attachmentResource = attachmentId
    ? {
        _tag: "attachment" as const,
        attachmentId,
        fileName: props.name,
        mimeType: props.mimeType,
        disposition: "inline" as const,
      }
    : null;
  const resource = assetResource ?? attachmentResource;
  const downloadResource = resource
    ? resource._tag === "draft-workspace-file"
      ? resource
      : { ...resource, disposition: "attachment" as const }
    : null;
  const refresh = useAssetUrlRefresh(
    props.file ? null : (props.asset?.environmentId ?? null),
    props.file ? null : resource,
  );
  const prepareDownload = useAssetUrlRefresh(props.asset?.environmentId ?? null, downloadResource);
  const [saving, setSaving] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<AttachmentFailure | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const copyContents = useRef<(() => Promise<string>) | null>(null);
  const authorizedAt = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates an object URL for the local file and revokes it on cleanup
  useEffect(() => {
    if (!props.file) return;
    const url = URL.createObjectURL(props.file);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish an object URL only after its cleanup is registered for this Blob.
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- authorizes a remote attachment URL from the server and ignores the result after cleanup
  useEffect(() => {
    if (props.file) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A new preview request clears its previous URL and error.
    setRemoteUrl(null);
    setError(null);
    void refresh()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error(m(msg("Reconnect to the environment and try again.")));
        authorizedAt.current = Date.now();
        setRemoteUrl(url);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError({
            kind: "load",
            message: thrownErrorMessage(cause, m) ?? m(msg("The attachment is unavailable.")),
          });
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must reauthorize the remote file.
  }, [props.file, refresh, revision]);
  const url = props.file ? localUrl : remoteUrl;
  const streamsText =
    kind === "text" &&
    (props.sizeBytes > FILE_TEXT_PREVIEW_MAX_BYTES ||
      (props.sizeBytes === 0 && (!resource || resource._tag === "attachment")));
  const needsText =
    kind === "text" || kind === "markdown" || kind === "mermaid" || (kind === "html" && !rendered);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the file's text from its URL or Blob stream and aborts the request on cleanup
  useEffect(() => {
    if (!needsText || streamsText || !url) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- A new external resource must clear the previous response before loading.
    setContent(null);
    setContentError(null);
    const file = props.file;
    void (async () => {
      if (!file && Date.now() - authorizedAt.current > STALE_URL_MS) {
        const target = await refresh();
        if (controller.signal.aborted) return;
        if (!target) throw new Error(m(msg("Reconnect to the environment and try again.")));
        authorizedAt.current = Date.now();
        if (target !== url) {
          setRemoteUrl(target);
          return;
        }
      }
      const response = file
        ? { ok: true, body: file.stream() }
        : await fetch(url, {
            signal: controller.signal,
            ...(props.sizeBytes > 0
              ? { headers: { Range: `bytes=0-${FILE_TEXT_PREVIEW_MAX_BYTES}` } }
              : {}),
            cache: revision === 0 ? "default" : "reload",
          });
      const result = await readFilePreviewResponse(response, controller.signal);
      if (!controller.signal.aborted) setContent(result);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setContentError(thrownErrorMessage(cause, m) ?? m(msg("Could not load this file.")));
    });
    return () => controller.abort();
  }, [url, needsText, streamsText, revision, props.sizeBytes, props.file, refresh]);
  const failure: AttachmentFailure | null =
    error ?? (needsText && contentError !== null ? { kind: "load", message: contentError } : null);
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? defaultWordWrap;
  const showsRawText =
    failure === null &&
    needsText &&
    (content !== null || streamsText) &&
    !(delimiter && rendered) &&
    !((kind === "markdown" || kind === "mermaid") && rendered);

  const save = () => {
    setSaving(true);
    void settlePromise(async () => {
      let file = props.file;
      if (!file) {
        const target = await prepareDownload();
        if (!target) throw new Error(gt("Reconnect to the environment and try again."));
        const response = await fetch(target);
        if (!response.ok) throw new Error(gt("The file could not be loaded. Try again."));
        file = await response.blob();
      }
      // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
      const downloadUrl = URL.createObjectURL(file);
      // Scheduled before the click so the URL is revoked even if the click throws.
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = props.name;
      anchor.click();
    }).then((result) => {
      if (!AsyncResult.isSuccess(result)) {
        const cause = Cause.squash(result.cause);
        toastManager.add({
          type: "error",
          title: gt("Could not save file"),
          description: thrownErrorMessage(cause, m) ?? gt("Please try again."),
        });
      }
      setSaving(false);
    });
  };

  // SCIENT-FORK:START — PDFs open in Scient's reader (find, outline, zoom, Ask in chat)
  const scientPdf =
    kind === "pdf"
      ? attachmentPdfMount({
          sizeBytes: props.sizeBytes,
          ...(props.asset && "attachmentId" in props.asset ? { asset: props.asset } : {}),
          ...(props.threadRef ? { threadRef: props.threadRef } : {}),
          ...(props.file ? { file: props.file } : {}),
          ...(props.draftPdf ? { draftPdf: props.draftPdf } : {}),
        })
      : null;
  // SCIENT-FORK:END
  const body = scientPdf ? (
    <AttachmentPdfPreview
      environmentId={scientPdf.environmentId}
      fileName={props.name}
      locator={scientPdf.locator}
      file={props.file ?? null}
    />
  ) : failure ? (
    <FileSurfaceFailure
      {...(failure.kind === "media" && (kind === "image" || kind === "audio" || kind === "video")
        ? // SCIENT-FORK: failure copy in the active language.
          mediaFailureCopy(kind, messages)
        : {
            title: gt("Couldn't open this file"),
            description: gt("Scient couldn't load this attachment."),
            details: failure.kind === "load" ? failure.message : null,
          })}
      onRetry={() => {
        setError(null);
        setRevision((value) => value + 1);
      }}
    />
  ) : streamsText && url ? (
    <Suspense fallback={<FileSurfaceLoading />}>
      <LargeTextViewer
        key={`${url}:${rendered}:${revision}`}
        name={props.name}
        src={url}
        sizeBytes={props.sizeBytes}
        onRetry={() => setRevision((value) => value + 1)}
        delimiter={rendered ? delimiter : null}
        copyContents={copyContents}
        wordWrap={wordWrap}
      />
    </Suspense>
  ) : !url || (needsText && !content) ? (
    <FileSurfaceLoading />
  ) : needsText && content ? (
    delimiter && rendered ? (
      <DelimitedTablePreview name={props.name} text={content.text} delimiter={delimiter} />
    ) : kind === "mermaid" && rendered ? (
      <Suspense fallback={<FileSurfaceLoading />}>
        <MermaidFilePreview text={content.text} />
      </Suspense>
    ) : kind === "markdown" && rendered ? (
      <ScrollArea className="min-h-0 flex-1">
        <ChatMarkdown
          text={maskMarkdownFrontmatter(content.text)}
          cwd={undefined}
          className="mx-auto max-w-4xl px-6 py-5"
        />
      </ScrollArea>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={content.text} wordWrap={wordWrap} />
    )
  ) : kind === "archive" || kind === "sqlite" ? (
    <BinaryFilePreview
      key={revision}
      src={url}
      name={props.name}
      kind={kind}
      onRetry={() => setRevision((value) => value + 1)}
    />
  ) : kind === "font" ? (
    <Suspense fallback={<FileSurfaceLoading />}>
      <FontFilePreview src={url} name={props.name} />
    </Suspense>
  ) : officeKind ? (
    <Suspense fallback={<FileSurfaceLoading />}>
      <OfficeFilePreview
        src={url}
        name={props.name}
        kind={officeKind}
        sizeBytes={props.sizeBytes}
      />
    </Suspense>
  ) : kind === "html" ? (
    <BrowserDocumentFrame
      src={url}
      title={props.name}
      htmlRender={props.htmlRender === true}
      threadRef={props.threadRef}
    />
  ) : kind === "audio" ? (
    <AudioPreview src={url} name={props.name} onError={() => setError(MEDIA_LOAD_FAILURE)} />
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        playsInline
        src={url}
        aria-label={props.name}
        className="max-h-full max-w-full"
        onError={() => setError(MEDIA_LOAD_FAILURE)}
      />
    </div>
  ) : kind === "image" ? (
    <PreviewImage
      key={`${url}:${revision}`}
      src={url}
      name={props.name}
      mimeType={props.mimeType}
      onError={() => setError(MEDIA_LOAD_FAILURE)}
    />
  ) : (
    <FileSurfaceMessage
      // SCIENT-FORK: the title in the active language.
      title={messages(UNSUPPORTED_PREVIEW_TITLE)}
      description={unsupportedPreviewDescription(props.name, messages)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* SCIENT-FORK:START — embedded previews keep only the body; the panel owns the header. */}
      {props.embedded ? null : (
        <div className={cn(FILE_SURFACE_SUBHEADER_CLASS)} data-surface-subheader>
          <div className="flex min-w-0 flex-1 items-center scient-reading-ui text-xs">
            <span className="shrink-0 px-0.5 text-muted-foreground">
              {props.origin ?? gt("Attachment")}
            </span>
            <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
            <span
              aria-current="page"
              className="min-w-0 truncate px-0.5 font-medium text-foreground"
            >
              {props.name}
            </span>
            {props.sizeBytes > 0 ? (
              <span className="ml-2 shrink-0 text-muted-foreground">
                {formatAttachmentSize(props.sizeBytes, messages)}
              </span>
            ) : null}
          </div>
          {renderedMode ? (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode, rendered, messages)}
              pressed={rendered}
              onPress={() => setRendered((value) => !value)}
            >
              {rendered ? (
                <Code2Icon className="size-3.5" />
              ) : renderedMode === "table" ? (
                <Table2Icon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
            </FileSurfaceAction>
          ) : null}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? gt("Disable word wrap") : gt("Enable word wrap")}
              pressed={wordWrap}
              onPress={() => setWordWrapOverride(!wordWrap)}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {content || streamsText ? (
            <FileSurfaceAction
              label={
                isCopied
                  ? gt("Copied")
                  : content?.truncated
                    ? gt("Copy preview")
                    : gt("Copy contents")
              }
              onPress={() => {
                if (content) {
                  void copyToClipboard(content.text, undefined);
                  return;
                }
                const copy = copyContents.current;
                if (!copy) {
                  toastManager.add({
                    type: "error",
                    title: gt("Could not copy file"),
                    description: gt("Wait for the file to finish loading before copying."),
                  });
                  return;
                }
                void copy()
                  .then((text) => copyToClipboard(text, undefined))
                  .catch((cause: unknown) =>
                    toastManager.add({
                      type: "error",
                      title: gt("Could not copy file"),
                      description: thrownErrorMessage(cause, m) ?? gt("Try again."),
                    }),
                  );
              }}
            >
              {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </FileSurfaceAction>
          ) : null}
          {url && !scientPdf ? (
            <FileSurfaceAction
              label={
                props.onSaveCopy
                  ? gt("Save a copy to this device")
                  : saving
                    ? gt("Preparing file…")
                    : gt("Save file")
              }
              disabled={saving}
              onPress={props.onSaveCopy ?? save}
            >
              <DownloadIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {props.onRemove ? (
            <FileSurfaceAction label={gt("Remove from draft")} onPress={props.onRemove}>
              <Trash2Icon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {props.onClose ? (
            <FileSurfaceAction
              label={gt("Close", { $context: "button, closes the file preview" })}
              onPress={props.onClose}
            >
              <XIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      )}
      {/* SCIENT-FORK:END */}
      {content?.truncated ? (
        <FileSurfaceNotice>
          {props.sizeBytes > 0
            ? gt(
                "Preview limited to the first 1 MB of a {size} byte file. Save the file to read it in full.",
                { size: props.sizeBytes.toLocaleString() },
              )
            : gt("Preview limited to the first 1 MB. Save the file to read it in full.")}
        </FileSurfaceNotice>
      ) : null}
      {body}
    </div>
  );
}

/** The browser failed to load or decode the media element; it gives no reason. */
type AttachmentFailure =
  | { readonly kind: "media" }
  | { readonly kind: "load"; readonly message: string };

const MEDIA_LOAD_FAILURE: AttachmentFailure = { kind: "media" };

/** Names "csv files" for report.csv; a name without an extension names no format. */
function unsupportedPreviewDescription(name: string, resolve: MessageResolver): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return extension
    ? resolve(msg("Save it to open in an app that supports {extension} files.", { extension }))
    : resolve(msg("Save it to open in an app that supports this format."));
}
