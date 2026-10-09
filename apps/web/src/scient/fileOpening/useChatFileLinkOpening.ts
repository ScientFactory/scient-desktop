import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentFileLinkResolution,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import {
  BrowserPreviewUnavailableError,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { workspaceFileHostPath } from "~/components/files/filePath";
import { useRightPanelStore } from "~/rightPanelStore";
import type { usePreparedConnection } from "~/state/session";
import { isAbsolutePath } from "~/terminal-links";
import { claimWorkspaceBasenameLookup } from "~/workspaceBasenameLookup";

import {
  chatFileLinkResolveInput,
  chatFileOpenPlan,
  claimLinkClick,
  clientPlacedLinkPath,
  linkOpenLocation,
  settleWithin,
  workspaceLocatorAskPath,
  type ChatFileOpenPlan,
} from "./chatFileLinkResolution";
import type { environmentFileLinkResolution } from "./environmentFileState";
import { openEnvironmentFileInPreview } from "./openEnvironmentFileInPreview";

type OpenInPreviewResult = Promise<AtomCommandResult<unknown, unknown>>;

/**
 * Marks a chat link click as the user's latest intent for the thread's panel:
 * a newer link click, or anything done in the panel, supersedes it.
 */
function claimFileLinkClick(threadRef: ScopedThreadRef): () => boolean {
  return claimLinkClick({
    claimLatest: claimWorkspaceBasenameLookup,
    readUserActionRevision: () => useRightPanelStore.getState().getUserActionRevision(threadRef),
  });
}

// Longer than the environment's own search bound, so a slow search still answers.
const FILE_LINK_RESOLVE_WAIT_MS = 3_000;
/**
 * Opens an environment file that is not a workspace file, such as a page
 * outside the workspace, in the integrated browser.
 */
export function useChatEnvironmentHtmlPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly preparedConnection: ReturnType<typeof usePreparedConnection>;
  readonly createAssetUrl: Parameters<
    typeof openEnvironmentFileInPreview<AssetError, PreviewError>
  >[0]["createAssetUrl"];
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}) {
  const { threadRef, preparedConnection, createAssetUrl, openPreview } = input;
  const openEnvironmentHtmlInPreview = useCallback(
    (path: string) => {
      if (!threadRef || preparedConnection._tag === "None") {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }
      return openEnvironmentFileInPreview({
        threadRef,
        path,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [createAssetUrl, openPreview, preparedConnection, threadRef],
  );
  return openEnvironmentHtmlInPreview;
}

/**
 * How a chat message's file links open: each click asks the environment that
 * owns the files what the link means, then opens it in the file panel, the
 * media viewer or the integrated browser.
 */
export function useChatFileLinkOpening(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly changedFiles: ReadonlyArray<{ readonly path: string }> | undefined;
  readonly resolveEnvironmentFileLink: (
    target: Parameters<typeof environmentFileLinkResolution>[0],
  ) => Promise<AtomCommandResult<EnvironmentFileLinkResolution, unknown>>;
  readonly openMarkdownMedia: (source: string, resolvedFilePath?: string) => void;
  readonly openMarkdownFileInPreview: (
    path: string,
    workspaceRelativePath: string,
  ) => OpenInPreviewResult;
  readonly openEnvironmentHtmlInPreview: (path: string) => OpenInPreviewResult;
}) {
  const {
    threadRef,
    cwd,
    environmentId,
    changedFiles,
    resolveEnvironmentFileLink,
    openMarkdownMedia,
    openMarkdownFileInPreview,
    openEnvironmentHtmlInPreview,
  } = input;
  // Asks the environment that owns the files what a link means; see
  // resolveEnvironmentFileLink on the server. `location` is where the link
  // opens when it opens as written: the client's own placement, except for a
  // home-relative link, which opens where the environment says it is. When
  // the environment could not be asked, the link opens as the client placed it.
  const planFileLinkOpen = useCallback(
    async (
      askedPath: string,
      clientPath: string,
    ): Promise<{ readonly plan: ChatFileOpenPlan; readonly location: string }> => {
      const input = chatFileLinkResolveInput({
        linkPath: askedPath,
        workspaceRoot: cwd,
        changedPaths: changedFiles?.map((file) => file.path) ?? [],
      });
      if (input === null || environmentId === null) {
        return { plan: chatFileOpenPlan(null), location: clientPath };
      }
      const resolution = await settleWithin(
        resolveEnvironmentFileLink({ environmentId, input }).then((result) =>
          result._tag === "Success" ? result.value : null,
        ),
        FILE_LINK_RESOLVE_WAIT_MS,
        null,
      );
      return {
        plan: chatFileOpenPlan(resolution),
        location: linkOpenLocation({ resolution, askedPath, clientPath, workspaceRoot: cwd }),
      };
    },
    [changedFiles, cwd, environmentId, resolveEnvironmentFileLink],
  );
  // Opens the file a chat link means. A link whose location does not exist
  // opens the one workspace file it meant, when there is exactly one; without
  // a single answer it opens as written and the file panel offers the choices.
  // `panelPath` is the client's placement of the link: a workspace locator or
  // a host path. For a link authored from the home folder it is that authored
  // `~/` spelling instead, which only the environment can place.
  const openLinkInPanel = useCallback(
    (panelPath: string, line: number | undefined, authoredHomeRelative: boolean) => {
      if (!threadRef) return;
      const isCurrentClick = claimFileLinkClick(threadRef);
      void (async () => {
        const { plan, location } = await planFileLinkOpen(
          authoredHomeRelative ? panelPath : workspaceLocatorAskPath(panelPath, cwd),
          authoredHomeRelative ? clientPlacedLinkPath(panelPath, cwd) : panelPath,
        );
        if (!isCurrentClick()) return;
        useRightPanelStore
          .getState()
          .openFile(threadRef, plan.kind === "resolved" ? plan.path : location, line);
      })();
    },
    [cwd, planFileLinkOpen, threadRef],
  );
  const openFileInPanel = useCallback(
    (panelPath: string, line: number | undefined) => openLinkInPanel(panelPath, line, false),
    [openLinkInPanel],
  );
  const openHomeRelativeLinkInPanel = useCallback(
    (panelPath: string, line: number | undefined) => openLinkInPanel(panelPath, line, true),
    [openLinkInPanel],
  );
  // Outside media opens in the media viewer when its file exists. A missing
  // one gets the same treatment as any other link, in the file panel.
  const openMarkdownMediaLink = useCallback(
    (mediaPath: string, filePath: string, homeRelativePath?: string) => {
      if (!threadRef) {
        openMarkdownMedia(mediaPath, filePath);
        return;
      }
      const isCurrentClick = claimFileLinkClick(threadRef);
      void (async () => {
        const { plan, location } = await planFileLinkOpen(homeRelativePath ?? filePath, filePath);
        if (!isCurrentClick()) return;
        if (plan.kind === "as-written") {
          // A home-relative link opens from where the environment says it is:
          // in the files panel when that is inside the workspace, like any
          // other workspace media, otherwise in the media viewer.
          if (location === filePath) openMarkdownMedia(mediaPath, filePath);
          else if (isAbsolutePath(location)) openMarkdownMedia(location, location);
          else useRightPanelStore.getState().openFile(threadRef, location);
          return;
        }
        useRightPanelStore
          .getState()
          .openFile(threadRef, plan.kind === "resolved" ? plan.path : location);
      })();
    },
    [openMarkdownMedia, planFileLinkOpen, threadRef],
  );
  // An HTML link opens in the integrated browser: the page the link names, or
  // the one workspace page it meant. With no single answer it goes to the file
  // panel, which explains and offers the choices.
  const openHtmlLinkInBrowser = useCallback(
    async (
      filePath: string,
      workspaceRelativePath: string | null,
      homeRelativePath?: string,
    ): Promise<AtomCommandResult<unknown, unknown>> => {
      const superseded = AsyncResult.success<void, never>(undefined);
      if (!threadRef) return openEnvironmentHtmlInPreview(filePath);
      const isCurrentClick = claimFileLinkClick(threadRef);
      const clientPath = workspaceRelativePath ?? filePath;
      const { plan, location } = await planFileLinkOpen(homeRelativePath ?? filePath, clientPath);
      if (!isCurrentClick()) return superseded;
      if (plan.kind === "missing") {
        useRightPanelStore.getState().openFile(threadRef, location);
        return superseded;
      }
      if (plan.kind === "resolved" && cwd) {
        return openMarkdownFileInPreview(workspaceFileHostPath(plan.path, cwd), plan.path);
      }
      if (location !== clientPath) {
        // A home-relative page, opened where the environment says it is.
        return cwd && !isAbsolutePath(location)
          ? openMarkdownFileInPreview(workspaceFileHostPath(location, cwd), location)
          : openEnvironmentHtmlInPreview(location);
      }
      return cwd && workspaceRelativePath
        ? openMarkdownFileInPreview(filePath, workspaceRelativePath)
        : openEnvironmentHtmlInPreview(filePath);
    },
    [cwd, openEnvironmentHtmlInPreview, openMarkdownFileInPreview, planFileLinkOpen, threadRef],
  );
  return {
    openFileInPanel,
    openHomeRelativeLinkInPanel,
    openMarkdownMediaLink,
    openHtmlLinkInBrowser,
  };
}
