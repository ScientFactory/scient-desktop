"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentFilePath,
  type EditorId,
  type EnvironmentFilePrepareResult,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { FileQuestion, Globe2, LoaderCircle, Music2, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { PreviewImageSurface } from "~/components/preview/PreviewImageSurface";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { environmentPdfSource } from "~/scient/pdf/pdfSource";
import { scientificSourceLanguageOverride } from "~/scient/presentation/sourceLanguage";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { formatEnvironmentQueryError } from "~/state/query";
import { assetEnvironment } from "~/state/assets";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import type { ScientRightPanelSurface } from "../rightPanel/surfaces";
import { environmentFilePreparation } from "./environmentFileState";
import {
  environmentFileAssetResource,
  openEnvironmentFileInPreview,
} from "./openEnvironmentFileInPreview";
import {
  decodeEnvironmentTextPreview,
  ENVIRONMENT_TEXT_PREVIEW_BYTE_LIMIT,
} from "./environmentTextPreview";

const ScientPdfReader = lazy(() =>
  import("~/scient/pdf/ScientPdfReader").then((module) => ({
    default: module.ScientPdfReader,
  })),
);

type EnvironmentFileSurface = Extract<ScientRightPanelSurface, { module: "file" }>;
type TextLoadState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly message: string }
  | { readonly _tag: "Success"; readonly contents: string; readonly truncated: boolean };

function formatByteLength(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength.toLocaleString()} B`;
  if (byteLength < 1_024 * 1_024) return `${(byteLength / 1_024).toFixed(1)} KB`;
  if (byteLength < 1_024 * 1_024 * 1_024) {
    return `${(byteLength / (1_024 * 1_024)).toFixed(1)} MB`;
  }
  return `${(byteLength / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}

function pathDirectory(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex <= 0 ? path : path.slice(0, separatorIndex);
}

function useEnvironmentTextAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly file: EnvironmentFilePrepareResult;
  readonly refreshToken: number;
}): { readonly state: TextLoadState; readonly refresh: () => void } {
  const asset = useAssetUrlState(
    input.environmentId,
    environmentFileAssetResource({ path: input.file.canonicalPath }),
  );
  const [state, setState] = useState<TextLoadState>({ _tag: "Loading" });
  const previousRefreshTokenRef = useRef(input.refreshToken);
  const autoRetriedUrlRef = useRef<string | null>(null);
  const refreshAsset = asset.refresh;
  const assetUrl = asset._tag === "Success" ? asset.url : null;
  const assetFailed = asset._tag === "Failure";

  useEffect(() => {
    if (previousRefreshTokenRef.current === input.refreshToken) return;
    previousRefreshTokenRef.current = input.refreshToken;
    autoRetriedUrlRef.current = null;
    refreshAsset();
  }, [input.refreshToken, refreshAsset]);

  useEffect(() => {
    if (assetFailed) {
      setState({ _tag: "Failure", message: "Scient could not authorize this file." });
      return;
    }
    if (assetUrl === null) {
      setState({ _tag: "Loading" });
      return;
    }

    const controller = new AbortController();
    const url = assetUrl;
    setState({ _tag: "Loading" });
    void fetch(url, {
      signal: controller.signal,
      ...(input.file.byteLength === 0
        ? {}
        : { headers: { Range: `bytes=0-${ENVIRONMENT_TEXT_PREVIEW_BYTE_LIMIT - 1}` } }),
    })
      .then(async (response) => {
        if (response.status === 409 && autoRetriedUrlRef.current !== url) {
          autoRetriedUrlRef.current = url;
          refreshAsset();
          return;
        }
        if (!response.ok) throw new Error(`The file server returned ${response.status}.`);
        const bytes = await response.arrayBuffer();
        const encoding = input.file.presentation.textEncoding ?? "utf-8";
        const truncated = input.file.byteLength > bytes.byteLength;
        setState({
          _tag: "Success",
          contents: decodeEnvironmentTextPreview(bytes, encoding, truncated),
          truncated,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          _tag: "Failure",
          message: cause instanceof Error ? cause.message : "Unable to read this file.",
        });
      });
    return () => controller.abort();
  }, [
    assetFailed,
    assetUrl,
    input.file.byteLength,
    input.file.presentation.textEncoding,
    refreshAsset,
  ]);

  return { state, refresh: refreshAsset };
}

function EnvironmentImageSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly file: EnvironmentFilePrepareResult;
  readonly refreshToken: number;
}) {
  const asset = useAssetUrlState(
    props.environmentId,
    environmentFileAssetResource({ path: props.file.canonicalPath }),
  );
  const previousRefreshTokenRef = useRef(props.refreshToken);
  const autoRetriedUrlRef = useRef<string | null>(null);
  const refreshAsset = asset.refresh;
  useEffect(() => {
    if (previousRefreshTokenRef.current === props.refreshToken) return;
    previousRefreshTokenRef.current = props.refreshToken;
    autoRetriedUrlRef.current = null;
    refreshAsset();
  }, [props.refreshToken, refreshAsset]);

  if (asset._tag === "Failure") {
    return (
      <CenteredFailure message="Scient could not authorize this image." onRetry={refreshAsset} />
    );
  }
  if (asset._tag !== "Success") return <CenteredLoading label="Preparing image…" />;
  return (
    <PreviewImageSurface
      className="absolute inset-0"
      source={{
        url: asset.url,
        alt: props.file.fileName,
        revisionKey: `${props.file.canonicalPath}:${props.file.byteLength}:${props.file.mtimeMs}`,
      }}
      onLoadError={() => {
        if (autoRetriedUrlRef.current === asset.url) return;
        autoRetriedUrlRef.current = asset.url;
        refreshAsset();
      }}
    />
  );
}

function EnvironmentMediaSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly file: EnvironmentFilePrepareResult;
  readonly refreshToken: number;
  readonly kind: "audio" | "video";
}) {
  const asset = useAssetUrlState(
    props.environmentId,
    environmentFileAssetResource({ path: props.file.canonicalPath }),
  );
  const previousRefreshTokenRef = useRef(props.refreshToken);
  const autoRetryRef = useRef({ refreshToken: props.refreshToken, attempted: false });
  const [failure, setFailure] = useState<{
    readonly refreshToken: number;
    readonly url: string;
  } | null>(null);
  const refreshAsset = asset.refresh;
  useEffect(() => {
    if (previousRefreshTokenRef.current === props.refreshToken) return;
    previousRefreshTokenRef.current = props.refreshToken;
    autoRetryRef.current = { refreshToken: props.refreshToken, attempted: false };
    refreshAsset();
  }, [props.refreshToken, refreshAsset]);
  if (asset._tag === "Failure") {
    return (
      <CenteredFailure
        message="Scient could not authorize this media file."
        onRetry={refreshAsset}
      />
    );
  }
  if (asset._tag !== "Success") return <CenteredLoading label="Preparing media…" />;
  if (failure?.url === asset.url && failure.refreshToken === props.refreshToken) {
    return (
      <CenteredFailure
        message="Scient could not play this media file. Its codec may not be supported."
        onRetry={() => {
          autoRetryRef.current = { refreshToken: props.refreshToken, attempted: false };
          setFailure(null);
          refreshAsset();
        }}
      />
    );
  }
  const handleMediaError = () => {
    const alreadyRetried =
      autoRetryRef.current.refreshToken === props.refreshToken && autoRetryRef.current.attempted;
    if (!alreadyRetried) {
      autoRetryRef.current = { refreshToken: props.refreshToken, attempted: true };
      refreshAsset();
      return;
    }
    setFailure({ refreshToken: props.refreshToken, url: asset.url });
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      {props.kind === "audio" ? (
        <div className="flex w-full max-w-xl flex-col items-center gap-4">
          <Music2 className="size-8 text-muted-foreground" aria-hidden="true" />
          <audio
            className="w-full"
            controls
            preload="metadata"
            src={asset.url}
            aria-label={props.file.fileName}
            onError={handleMediaError}
          >
            Your browser cannot play this audio file.
          </audio>
        </div>
      ) : (
        <video
          className="max-h-full max-w-full rounded-md bg-black shadow-sm"
          controls
          preload="metadata"
          src={asset.url}
          aria-label={props.file.fileName}
          onError={handleMediaError}
        >
          Your browser cannot play this video file.
        </video>
      )}
    </div>
  );
}

function CenteredLoading(props: { readonly label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {props.label}
    </div>
  );
}

function CenteredFailure(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3 text-xs text-muted-foreground">
        <FileQuestion className="size-6" aria-hidden="true" />
        <span>{props.message}</span>
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function EnvironmentTextSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly file: EnvironmentFilePrepareResult;
  readonly line: number | null;
  readonly refreshToken: number;
  readonly threadRef: ScopedThreadRef;
}) {
  const loadedAsset = useEnvironmentTextAsset(props);
  const load = loadedAsset.state;
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const { resolvedTheme } = useTheme();
  const revealedTargetRef = useRef<string | null>(null);
  const revealTarget = `${props.file.canonicalPath}:${props.line ?? "none"}:${props.refreshToken}`;
  const onPostRender = useCallback<NonNullable<FileOptions<unknown>["onPostRender"]>>(
    (container, _instance, phase) => {
      if (
        phase === "unmount" ||
        props.line === null ||
        revealedTargetRef.current === revealTarget
      ) {
        return;
      }
      const root = container.shadowRoot ?? container;
      const target = root.querySelector<HTMLElement>(`[data-line="${props.line}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      revealedTargetRef.current = revealTarget;
    },
    [props.line, revealTarget],
  );

  if (load._tag === "Loading") return <CenteredLoading label="Reading file…" />;
  if (load._tag === "Failure") {
    return <CenteredFailure message={load.message} onRetry={loadedAsset.refresh} />;
  }
  if (props.file.presentation.kind === "markdown") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {load.truncated ? <TruncatedNotice file={props.file} /> : null}
        <div className="min-h-0 flex-1 overflow-auto">
          <ChatMarkdown
            text={load.contents}
            cwd={pathDirectory(props.file.canonicalPath)}
            fileLinkWorkspaceRoot={null}
            threadRef={props.threadRef}
            contentDirection="auto"
            className="mx-auto max-w-4xl px-6 py-5"
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {load.truncated ? <TruncatedNotice file={props.file} /> : null}
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1_200 }}
      >
        <File
          file={{
            name: props.file.fileName,
            contents: load.contents,
            ...scientificSourceLanguageOverride(props.file.fileName),
            cacheKey: `${props.file.canonicalPath}:${props.file.byteLength}:${props.file.mtimeMs}`,
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </div>
  );
}

function TruncatedNotice(props: { readonly file: EnvironmentFilePrepareResult }) {
  return (
    <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
      Read-only preview limited to the first {formatByteLength(ENVIRONMENT_TEXT_PREVIEW_BYTE_LIMIT)}{" "}
      of a {formatByteLength(props.file.byteLength)} file.
    </div>
  );
}

function EnvironmentFileBody(props: {
  readonly environmentId: EnvironmentId;
  readonly file: EnvironmentFilePrepareResult;
  readonly line: number | null;
  readonly refreshToken: number;
  readonly threadRef: ScopedThreadRef;
}) {
  switch (props.file.presentation.kind) {
    case "image":
      return (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <EnvironmentImageSurface {...props} />
        </div>
      );
    case "pdf":
      return (
        <Suspense fallback={<CenteredLoading label="Preparing PDF…" />}>
          <ScientPdfReader
            refreshKey={props.refreshToken}
            source={environmentPdfSource({
              environmentId: props.environmentId,
              canonicalPath: props.file.canonicalPath,
              fileName: props.file.fileName,
            })}
          />
        </Suspense>
      );
    case "html":
    case "markdown":
    case "text":
      return <EnvironmentTextSurface {...props} />;
    case "audio":
      return <EnvironmentMediaSurface {...props} kind="audio" />;
    case "video":
      return <EnvironmentMediaSurface {...props} kind="video" />;
    case "binary":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="flex max-w-sm flex-col items-center gap-2 text-xs text-muted-foreground">
            <FileQuestion className="size-7" aria-hidden="true" />
            <span className="font-medium text-foreground">No rich preview for this file yet</span>
            <span>
              {props.file.presentation.mediaType} · {formatByteLength(props.file.byteLength)}
            </span>
            <span>You can still open it in your preferred editor from the header.</span>
          </div>
        </div>
      );
  }
}

export default function EnvironmentFilePreview(props: {
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly environmentId: EnvironmentId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly surface: EnvironmentFileSurface;
  readonly threadRef: ScopedThreadRef;
}) {
  const prepareAtom = environmentFilePreparation({
    environmentId: props.environmentId,
    input: { path: EnvironmentFilePath.make(props.surface.path) },
  });
  const preparation = useAtomValue(prepareAtom);
  const refreshPreparation = useAtomRefresh(prepareAtom);
  const [refreshToken, setRefreshToken] = useState(0);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const file = preparation._tag === "Success" ? preparation.value : null;
  const error =
    preparation._tag === "Failure" ? formatEnvironmentQueryError(preparation.cause) : null;

  const refresh = useCallback(() => {
    refreshPreparation();
    setRefreshToken((value) => value + 1);
  }, [refreshPreparation]);

  const openHtml = useCallback(() => {
    if (!file || !httpBaseUrl) return;
    void (async () => {
      try {
        const result = await openEnvironmentFileInPreview({
          threadRef: props.threadRef,
          path: file.canonicalPath,
          httpBaseUrl,
          createAssetUrl,
          openPreview,
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open HTML",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open HTML",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [createAssetUrl, file, httpBaseUrl, openPreview, props.threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="surface-subheader gap-1 px-2" data-surface-subheader>
        <ScientTooltip content={file?.canonicalPath ?? props.surface.path}>
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
            {file?.fileName ?? props.surface.path.replaceAll("\\", "/").split("/").at(-1)}
          </span>
        </ScientTooltip>
        {file && props.environmentId === primaryEnvironmentId ? (
          <OpenInPicker
            environmentId={props.environmentId}
            keybindings={props.keybindings}
            availableEditors={props.availableEditors}
            openInCwd={file.canonicalPath}
            compact
            enableShortcut={false}
          />
        ) : null}
        {file?.presentation.kind === "html" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openHtml}
                  aria-label="Open HTML in integrated browser"
                />
              }
            >
              <Globe2 />
            </TooltipTrigger>
            <TooltipPopup>Open in Browser</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-xs" onClick={refresh} aria-label="Refresh file" />
            }
          >
            <RefreshCw />
          </TooltipTrigger>
          <TooltipPopup>Refresh file</TooltipPopup>
        </Tooltip>
      </div>
      {error ? (
        <CenteredFailure message={error} onRetry={refresh} />
      ) : file ? (
        <EnvironmentFileBody
          environmentId={props.environmentId}
          file={file}
          line={props.surface.line}
          refreshToken={refreshToken}
          threadRef={props.threadRef}
        />
      ) : (
        <CenteredLoading label="Inspecting file…" />
      )}
    </div>
  );
}
