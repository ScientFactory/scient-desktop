import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  confirmProjectFileQueryData,
  refreshProjectEntriesQuery,
  setProjectFileQueryData,
  useProjectEntriesQuery,
} from "~/components/files/projectFilesQueryState";
import { anchoredToastManager, toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { resolvePathLinkTarget } from "~/terminal-links";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { ScientMarkdownWorkspaceSurface } from "./ScientMarkdownWorkspaceSurface";
import type { ScientMarkdownLinkCopyRequest, ScientMarkdownLinkKind } from "./linkContextMenu";
import { isScientMarkdownDocumentPath } from "./markdownDocumentPaths";
import { uploadMarkdownImage } from "./assets/client";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import {
  markdownWikiTargetForPath,
  resolveMarkdownUrlPath,
  resolveWikiLinkPath,
} from "./workspacePaths";
import {
  EMPTY_WIKI_LINK_RECENT_PATHS,
  promoteRecentWikiLinkPath,
  sanitizeRecentWikiLinkPaths,
  WikiLinkRecentPaths,
  wikiLinkRecentsStorageKey,
} from "./wikiLinkPicker";

const LINK_FEEDBACK_TIMEOUT_MS = 1_800;

function workspacePathParent(relativePath: string): {
  readonly directory: string;
  readonly name: string;
} {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: relativePath }
    : {
        directory: relativePath.slice(0, separator),
        name: relativePath.slice(separator + 1),
      };
}

export interface ScientMarkdownFileSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly contents: string;
  readonly revision: string;
  readonly resolvedTheme: "light" | "dark";
  readonly authoritativeSnapshot: {
    readonly source: string;
    readonly revision: string;
  } | null;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  readonly onSaveFailure: (relativePath: string, error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly contents: string;
    readonly revision: string;
  } | null;
  readonly onSaveResolutionApplied?: () => void;
}

export function ScientMarkdownFileSurface(props: ScientMarkdownFileSurfaceProps) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const listDirectory = useAtomCommand(projectEnvironment.listDirectory, {
    reportDefect: false,
    reportFailure: false,
  });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.cwd);
  const workspaceResourceIndexKey = useMemo(
    () =>
      JSON.stringify([
        httpBaseUrl,
        entriesQuery.data?.truncated ?? true,
        ...(entriesQuery.data?.entries ?? []).map((entry) => [entry.kind, entry.path]),
      ]),
    [entriesQuery.data?.entries, entriesQuery.data?.truncated, httpBaseUrl],
  );
  const allMarkdownPaths = useMemo(
    () =>
      (entriesQuery.data?.entries ?? [])
        .filter((entry) => entry.kind === "file" && isScientMarkdownDocumentPath(entry.path))
        .map((entry) => entry.path),
    [entriesQuery.data?.entries],
  );
  const markdownPaths = useMemo(
    () => allMarkdownPaths.filter((path) => path !== props.relativePath),
    [allMarkdownPaths, props.relativePath],
  );
  const markdownPathSet = useMemo(() => new Set(allMarkdownPaths), [allMarkdownPaths]);
  const wikiLinkCandidates = useMemo(
    () =>
      markdownPaths.flatMap((path) => {
        const target = markdownWikiTargetForPath(props.relativePath, path);
        return target === null ? [] : [{ path, target }];
      }),
    [markdownPaths, props.relativePath],
  );
  const wikiLinkCandidatePathSet = useMemo(
    () => new Set(wikiLinkCandidates.map((candidate) => candidate.path)),
    [wikiLinkCandidates],
  );
  const wikiLinkStorageKey = wikiLinkRecentsStorageKey(String(props.environmentId), props.cwd);
  const [storedRecentWikiLinkPaths, setStoredRecentWikiLinkPaths] = useLocalStorage(
    wikiLinkStorageKey,
    EMPTY_WIKI_LINK_RECENT_PATHS,
    WikiLinkRecentPaths,
  );
  const recentWikiLinkPaths = useMemo(
    () =>
      sanitizeRecentWikiLinkPaths(storedRecentWikiLinkPaths).filter((path) =>
        wikiLinkCandidatePathSet.has(path),
      ),
    [storedRecentWikiLinkPaths, wikiLinkCandidatePathSet],
  );
  const markdownPathSetRef = useRef<ReadonlySet<string>>(markdownPathSet);
  const entriesTruncatedRef = useRef(entriesQuery.data?.truncated ?? true);
  const mountedRef = useRef(true);
  const linkOpenRequestRef = useRef(0);
  const linkFeedbackToastRef = useRef<ReturnType<typeof anchoredToastManager.add> | null>(null);
  markdownPathSetRef.current = markdownPathSet;
  entriesTruncatedRef.current = entriesQuery.data?.truncated ?? true;

  const dismissLinkFeedback = useCallback(() => {
    if (linkFeedbackToastRef.current === null) return;
    anchoredToastManager.close(linkFeedbackToastRef.current);
    linkFeedbackToastRef.current = null;
  }, []);
  const beginLinkOpen = useCallback(() => {
    dismissLinkFeedback();
    linkOpenRequestRef.current += 1;
    return linkOpenRequestRef.current;
  }, [dismissLinkFeedback]);
  const showLinkFeedback = useCallback(
    (anchor: HTMLElement, title: string) => {
      if (!mountedRef.current || !anchor.isConnected) return;
      dismissLinkFeedback();
      linkFeedbackToastRef.current = anchoredToastManager.add({
        data: { tooltipStyle: true },
        positionerProps: { anchor, side: "top" },
        timeout: LINK_FEEDBACK_TIMEOUT_MS,
        title,
      });
    },
    [dismissLinkFeedback],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      linkOpenRequestRef.current += 1;
      dismissLinkFeedback();
    };
  }, [dismissLinkFeedback]);
  const wikiLinkTargetExists = useCallback(
    (target: string): boolean | null => {
      const resolved = resolveWikiLinkPath(props.relativePath, target);
      if (resolved === null) return false;
      if (markdownPathSetRef.current.has(resolved)) return true;
      return entriesTruncatedRef.current ? null : false;
    },
    [props.relativePath],
  );
  const persist = useCallback(
    async (intent: MarkdownSaveIntent) => {
      const result = await writeFile({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          relativePath: props.relativePath,
          contents: intent.source,
          expectedRevision: intent.expectedRevision,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return { revision: result.value.revision };
    },
    [props.cwd, props.environmentId, props.relativePath, writeFile],
  );
  const resolveImageSource = useCallback(
    async (authoredSource: string): Promise<string | null> => {
      if (/^https:\/\//iu.test(authoredSource) || authoredSource.startsWith("data:image/")) {
        return authoredSource;
      }
      if (!httpBaseUrl) return null;
      const resolved = resolveMarkdownUrlPath(props.relativePath, authoredSource);
      if (!resolved) return null;
      const { relativePath, suffix } = resolved;
      const absolutePath = resolvePathLinkTarget(relativePath, props.cwd);
      const result = await createAssetUrl({
        environmentId: props.environmentId,
        input: {
          resource: {
            _tag: "workspace-file",
            cwd: props.cwd,
            relativePath,
            threadId: props.threadRef.threadId,
            path: absolutePath,
          },
        },
      });
      if (result._tag === "Failure") return null;
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      return url === null ? null : `${url}${suffix}`;
    },
    [
      createAssetUrl,
      httpBaseUrl,
      props.cwd,
      props.environmentId,
      props.relativePath,
      props.threadRef.threadId,
    ],
  );
  const uploadImage = useCallback(
    async (file: File) => {
      const result = await uploadMarkdownImage(props.environmentId, {
        cwd: props.cwd,
        documentRelativePath: props.relativePath,
        file,
      });
      refreshProjectEntriesQuery(props.environmentId, props.cwd);
      return {
        src: result.markdownSource,
        alt: file.name.replace(/\.[^.]+$/u, ""),
      };
    },
    [props.cwd, props.environmentId, props.relativePath],
  );
  const openWorkspaceFile = useCallback(
    async (relativePath: string, anchor: HTMLElement) => {
      const request = beginLinkOpen();
      const { directory, name } = workspacePathParent(relativePath);
      const result = await listDirectory({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          relativeDirectory: directory,
          view: "with-internals",
        },
      });
      if (!mountedRef.current || request !== linkOpenRequestRef.current || !anchor.isConnected) {
        return;
      }
      if (result._tag === "Failure") {
        showLinkFeedback(anchor, "Couldn't check this link.");
        return;
      }
      const entry = result.value.entries.find(
        (candidate) => candidate.name === name && candidate.relativePath === relativePath,
      );
      if (entry && entry.kind !== "directory") {
        props.onOpenFile(relativePath);
        return;
      }
      showLinkFeedback(
        anchor,
        result.value.complete ? "Linked file isn't available." : "Couldn't check this link.",
      );
    },
    [
      beginLinkOpen,
      listDirectory,
      props.cwd,
      props.environmentId,
      props.onOpenFile,
      showLinkFeedback,
    ],
  );
  const handleOpenLink = useCallback(
    (target: string, anchor: HTMLElement) => {
      if (/^(?:https?:|mailto:)/iu.test(target)) {
        beginLinkOpen();
        void readLocalApi()
          ?.shell.openExternal(target)
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Unable to open link",
              description: error instanceof Error ? error.message : "The link could not open.",
            });
          });
        return;
      }
      if (target.startsWith("#")) {
        beginLinkOpen();
        showLinkFeedback(anchor, "Linked section wasn't found.");
        return;
      }
      const path = resolveMarkdownUrlPath(props.relativePath, target);
      if (!path) {
        beginLinkOpen();
        showLinkFeedback(anchor, "This link isn't available.");
        return;
      }
      void openWorkspaceFile(path.relativePath, anchor);
    },
    [beginLinkOpen, openWorkspaceFile, props.relativePath, showLinkFeedback],
  );
  const handleOpenWikiLink = useCallback(
    (target: string, anchor: HTMLElement) => {
      const path = resolveWikiLinkPath(props.relativePath, target);
      if (!path) {
        beginLinkOpen();
        showLinkFeedback(anchor, "This link isn't available.");
        return;
      }
      void openWorkspaceFile(path, anchor);
    },
    [beginLinkOpen, openWorkspaceFile, props.relativePath, showLinkFeedback],
  );
  const resolveLinkFullPath = useCallback(
    (kind: ScientMarkdownLinkKind, target: string): string | null => {
      const relativePath =
        kind === "wiki-link"
          ? resolveWikiLinkPath(props.relativePath, target)
          : target.startsWith("#")
            ? props.relativePath
            : resolveMarkdownUrlPath(props.relativePath, target)?.relativePath;
      return relativePath ? resolvePathLinkTarget(relativePath, props.cwd) : null;
    },
    [props.cwd, props.relativePath],
  );
  const handleCopyLink = useCallback(
    (request: ScientMarkdownLinkCopyRequest, anchor: HTMLElement) => {
      const requestId = beginLinkOpen();
      const fullPath = request.format === "full-path";
      void writeTextToClipboard(request.value, fullPath ? "full path" : "link").then(
        (copied) => {
          if (requestId !== linkOpenRequestRef.current) return;
          if (copied) showLinkFeedback(anchor, fullPath ? "Full path copied." : "Link copied.");
        },
        () => {
          if (requestId !== linkOpenRequestRef.current) return;
          showLinkFeedback(
            anchor,
            fullPath ? "Couldn't copy the full path." : "Couldn't copy the link.",
          );
        },
      );
    },
    [beginLinkOpen, showLinkFeedback],
  );
  return (
    <ScientMarkdownWorkspaceSurface
      key={JSON.stringify([props.environmentId, props.cwd, props.relativePath])}
      source={props.contents}
      revision={props.revision}
      authoritativeSnapshot={props.authoritativeSnapshot}
      ariaLabel={`${props.relativePath} Markdown document`}
      resolvedTheme={props.resolvedTheme}
      workspaceResourceIndexKey={workspaceResourceIndexKey}
      persist={persist}
      onPendingChange={(pending) => props.onPendingChange(props.relativePath, pending)}
      onDraftSourceChange={(source) =>
        setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, source)
      }
      onSaveConfirmed={(source, revision) => {
        confirmProjectFileQueryData(
          props.environmentId,
          props.cwd,
          props.relativePath,
          source,
          revision,
        );
        props.onSaveConfirmed(props.relativePath, source, revision);
      }}
      onSaveFailure={(error) => props.onSaveFailure(props.relativePath, error)}
      onExternalConflict={props.onExternalConflict}
      onLocalHeadingOpened={() => {
        beginLinkOpen();
      }}
      onOpenWikiLink={handleOpenWikiLink}
      resolveLinkFullPath={resolveLinkFullPath}
      onCopyLink={handleCopyLink}
      wikiLinkTargetExists={wikiLinkTargetExists}
      wikiLinkCandidates={wikiLinkCandidates}
      recentWikiLinkPaths={recentWikiLinkPaths}
      onWikiLinkSelected={(path) => {
        setStoredRecentWikiLinkPaths((current) =>
          promoteRecentWikiLinkPath(
            sanitizeRecentWikiLinkPaths(current).filter((candidatePath) =>
              wikiLinkCandidatePathSet.has(candidatePath),
            ),
            path,
          ),
        );
      }}
      onOpenLink={handleOpenLink}
      resolveImageSource={resolveImageSource}
      uploadImage={uploadImage}
      onImageUploadFailure={(error) => {
        toastManager.add({
          type: "error",
          title: "Unable to add image",
          description: error instanceof Error ? error.message : "The image upload failed.",
        });
      }}
      {...(props.saveResolution === undefined ? {} : { saveResolution: props.saveResolution })}
      {...(props.onSaveResolutionApplied
        ? { onSaveResolutionApplied: props.onSaveResolutionApplied }
        : {})}
    />
  );
}
