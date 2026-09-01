import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useCallback, useMemo, useRef } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  confirmProjectFileQueryData,
  refreshProjectEntriesQuery,
  setProjectFileQueryData,
  useProjectEntriesQuery,
} from "~/components/files/projectFilesQueryState";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { resolvePathLinkTarget } from "~/terminal-links";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { ScientMarkdownWorkspaceSurface } from "./ScientMarkdownWorkspaceSurface";
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

export interface ScientMarkdownFileSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly contents: string;
  readonly revision: string;
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
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.cwd);
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
  const markdownPathsRef = useRef(markdownPaths);
  const markdownPathSetRef = useRef<ReadonlySet<string>>(markdownPathSet);
  const entriesTruncatedRef = useRef(entriesQuery.data?.truncated ?? true);
  markdownPathsRef.current = markdownPaths;
  markdownPathSetRef.current = markdownPathSet;
  entriesTruncatedRef.current = entriesQuery.data?.truncated ?? true;
  const wikiLinkSuggestions = useCallback(
    () =>
      markdownPathsRef.current.flatMap((path) => {
        const target = markdownWikiTargetForPath(props.relativePath, path);
        return target === null ? [] : [target];
      }),
    [props.relativePath],
  );
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
  const handleOpenLink = useCallback(
    (target: string) => {
      if (/^(?:https?:|mailto:)/iu.test(target)) {
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
      const path = resolveMarkdownUrlPath(props.relativePath, target);
      if (path) props.onOpenFile(path.relativePath);
    },
    [props.onOpenFile, props.relativePath],
  );
  return (
    <ScientMarkdownWorkspaceSurface
      key={JSON.stringify([props.environmentId, props.cwd, props.relativePath])}
      source={props.contents}
      revision={props.revision}
      authoritativeSnapshot={props.authoritativeSnapshot}
      ariaLabel={`${props.relativePath} Markdown document`}
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
      onOpenWikiLink={(target) => {
        const path = resolveWikiLinkPath(props.relativePath, target);
        if (path) props.onOpenFile(path);
      }}
      wikiLinkSuggestions={wikiLinkSuggestions}
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
