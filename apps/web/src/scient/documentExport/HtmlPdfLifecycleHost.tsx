"use client";

import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AssetCreateUrlResult,
  EnvironmentFileChangeEvent,
  ProjectFileWatchEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { waitForNavigationReadiness } from "~/components/preview/previewNavigationReadiness";
import { randomUUID } from "~/lib/utils";
import { readThreadPreviewState, useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { environmentFileChanges } from "./environmentFileChanges";
import { isTrackedDocumentUrl } from "./htmlPdfNavigationGuard";
import { trackedHtmlAssetResource } from "./htmlPdfSource";
import { useHtmlPdfSourceStore } from "./htmlPdfSourceStore";
import { useBrowserPdfExport } from "./useBrowserPdfExport";

type FileChange = EnvironmentFileChangeEvent | ProjectFileWatchEvent;

const EMPTY_FILE_CHANGE_ATOM = Atom.make(AsyncResult.initial<FileChange, never>(false)).pipe(
  Atom.withLabel("scient-html-pdf:file-changes:idle"),
);
const NORMALIZED_FILE_CHANGE_ATOMS = new WeakMap<
  object,
  Atom.Atom<AsyncResult.AsyncResult<FileChange, unknown>>
>();

function normalizedFileChangeAtom<A extends FileChange, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Atom.Atom<AsyncResult.AsyncResult<FileChange, unknown>> {
  const cached = NORMALIZED_FILE_CHANGE_ATOMS.get(atom);
  if (cached) return cached;
  const normalized = Atom.map(
    atom,
    (result): AsyncResult.AsyncResult<FileChange, unknown> => result,
  );
  NORMALIZED_FILE_CHANGE_ATOMS.set(atom, normalized);
  return normalized;
}

function navigationUrl(snapshot: ReturnType<typeof readThreadPreviewState>["snapshot"]): string {
  const status = snapshot?.navStatus;
  return !status || status._tag === "Idle" ? "" : status.url;
}

function resultValue<E>(result: AtomCommandResult<AssetCreateUrlResult, E>): AssetCreateUrlResult {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

function HtmlPdfRelationObserver(props: { readonly relationId: string }) {
  const relation = useHtmlPdfSourceStore((state) => state.relations[props.relationId]);
  const threadKey = relation ? scopedThreadKey(relation.threadRef) : "";
  const previewState = useThreadPreviewState(relation?.threadRef);
  const generatedSurfaceOpen = useRightPanelStore((state) => {
    if (!relation) return false;
    return Boolean(
      state.byThreadKey[threadKey]?.surfaces.some(
        (surface) =>
          surface.kind === "scient" &&
          surface.module === "generated-pdf" &&
          surface.source.logicalDocumentKey === relation.logicalDocumentKey,
      ),
    );
  });
  const browserSessionOpen = relation ? Boolean(previewState.sessions[relation.tabId]) : false;
  const shouldWatch = Boolean(relation && (browserSessionOpen || generatedSurfaceOpen));
  const fileChangeAtom: Atom.Atom<AsyncResult.AsyncResult<FileChange, unknown>> =
    !relation || !shouldWatch
      ? EMPTY_FILE_CHANGE_ATOM
      : relation.source._tag === "workspace-html"
        ? normalizedFileChangeAtom(
            projectEnvironment.fileChanges({
              environmentId: relation.threadRef.environmentId,
              input: {
                cwd: relation.source.workspaceRoot,
                relativePath: relation.source.relativePath,
              },
            }),
          )
        : normalizedFileChangeAtom(
            environmentFileChanges({
              environmentId: relation.threadRef.environmentId,
              input: { path: relation.source.canonicalPath },
            }),
          );
  const fileChangeResult = useAtomValue(fileChangeAtom);
  const fileChange = Option.getOrNull(AsyncResult.value(fileChangeResult));
  const httpBaseUrl = useEnvironmentHttpBaseUrl(relation?.threadRef.environmentId ?? null);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const exportBrowserPdf = useBrowserPdfExport();
  const lastFileChangeRef = useRef<object | null>(null);
  const lastManualRequestRef = useRef(relation?.manualRequestId ?? 0);
  const changeGenerationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const rerunManualRef = useRef(false);

  const performUpdate = useEffectEvent(async (manual: boolean) => {
    const latest = useHtmlPdfSourceStore.getState().relations[props.relationId];
    if (!latest) return;
    if (!previewBridge || httpBaseUrl === null) {
      useHtmlPdfSourceStore
        .getState()
        .setUpdateState(
          latest.id,
          "failed",
          previewBridge
            ? "The environment connection is unavailable."
            : "The desktop Browser is unavailable.",
        );
      return;
    }
    const generation = changeGenerationRef.current;
    const currentPreview = readThreadPreviewState(latest.threadRef);
    const session = currentPreview.sessions[latest.tabId];
    const overlay = currentPreview.desktopByTabId[latest.tabId];
    if (!session || !overlay?.hasWebContents) {
      useHtmlPdfSourceStore
        .getState()
        .setUpdateState(
          latest.id,
          "update-available",
          "Open the HTML Browser tab to update this PDF.",
        );
      return;
    }
    const currentUrl = navigationUrl(session);
    if (!manual && !isTrackedDocumentUrl(latest, currentUrl)) {
      useHtmlPdfSourceStore
        .getState()
        .setUpdateState(
          latest.id,
          "update-available",
          "The source changed after this Browser tab navigated elsewhere.",
        );
      return;
    }

    runningRef.current = true;
    useHtmlPdfSourceStore.getState().setUpdateState(latest.id, "updating");
    try {
      const issued = resultValue(
        await createAssetUrl({
          environmentId: latest.threadRef.environmentId,
          input: { resource: trackedHtmlAssetResource(latest.source, latest.threadRef) },
        }),
      );
      const renewedUrl = resolveAssetUrl(httpBaseUrl, issued.relativeUrl);
      if (renewedUrl === null) throw new Error("The environment returned an invalid HTML URL.");
      useHtmlPdfSourceStore.getState().setAuthorizedUrl(latest.id, renewedUrl);
      const runtimeTabId = previewRuntimeTabId(
        latest.threadRef,
        currentPreview.serverEpoch,
        latest.tabId,
      );
      await previewBridge.navigate(runtimeTabId, renewedUrl);
      await waitForNavigationReadiness(
        latest.threadRef,
        `html-pdf-update-${randomUUID()}`,
        latest.tabId,
        runtimeTabId,
        "navigate",
        "load",
        10_000,
      );
      if (generation !== changeGenerationRef.current) {
        throw new Error("The HTML source changed again while it was reloading.");
      }
      const refreshed = useHtmlPdfSourceStore.getState().relations[latest.id];
      if (!refreshed?.artifactId) {
        useHtmlPdfSourceStore.getState().setUpdateState(latest.id, "idle");
        return;
      }
      await exportBrowserPdf({
        threadRef: latest.threadRef,
        tabId: latest.tabId,
        runtimeTabId,
        pageUrl: renewedUrl,
        activate: false,
        isCurrent: () => generation === changeGenerationRef.current,
      });
      useHtmlPdfSourceStore.getState().setUpdateState(latest.id, "idle");
    } catch (error) {
      if (generation === changeGenerationRef.current) {
        useHtmlPdfSourceStore
          .getState()
          .setUpdateState(
            latest.id,
            "failed",
            error instanceof Error ? error.message : "The HTML PDF update failed.",
          );
      }
    } finally {
      runningRef.current = false;
      if (rerunRef.current) {
        const nextManual = rerunManualRef.current;
        rerunRef.current = false;
        rerunManualRef.current = false;
        globalThis.setTimeout(() => void performUpdate(nextManual), 0);
      }
    }
  });

  const scheduleUpdate = useEffectEvent((manual: boolean, delayMs = 300) => {
    if (runningRef.current) {
      rerunRef.current = true;
      rerunManualRef.current ||= manual;
      return;
    }
    if (timerRef.current !== null) globalThis.clearTimeout(timerRef.current);
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = null;
      void performUpdate(manual);
    }, delayMs);
  });

  useEffect(() => {
    if (!fileChange || lastFileChangeRef.current === fileChange) return;
    lastFileChangeRef.current = fileChange;
    if (fileChange._tag !== "file-changed") return;
    changeGenerationRef.current += 1;
    scheduleUpdate(false);
  }, [fileChange]);

  useEffect(() => {
    const requestId = relation?.manualRequestId ?? 0;
    if (requestId === lastManualRequestRef.current) return;
    lastManualRequestRef.current = requestId;
    scheduleUpdate(true, 0);
  }, [relation?.manualRequestId]);

  useEffect(() => {
    if (fileChangeResult._tag !== "Failure" || !relation?.artifactId) return;
    useHtmlPdfSourceStore
      .getState()
      .setUpdateState(
        relation.id,
        "update-available",
        "Automatic source watching is unavailable. Update the PDF manually.",
      );
  }, [fileChangeResult._tag, relation?.artifactId, relation?.id]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) globalThis.clearTimeout(timerRef.current);
    },
    [],
  );

  return null;
}

export function HtmlPdfLifecycleHost() {
  const relations = useHtmlPdfSourceStore((state) => state.relations);
  return Object.keys(relations).map((relationId) => (
    <HtmlPdfRelationObserver key={relationId} relationId={relationId} />
  ));
}
