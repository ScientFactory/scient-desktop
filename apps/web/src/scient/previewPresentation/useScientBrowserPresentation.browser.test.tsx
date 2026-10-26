import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { startAgentOpenedPreviews } from "../../components/preview/agentOpenedPreviews";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "../../previewStateStore";
import type { PreviewStaticImageSurfaceDescriptor } from "../../previewStaticImageSurface";
import { useRightPanelStore } from "../../rightPanelStore";

const settings = vi.hoisted(() => ({ autoShowFloatingPreview: true }));
vi.mock("../../state/entities", () => ({ readEnvironmentSupportsServerBrowser: () => true }));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ browserAutoShowFloatingPreview: settings.autoShowFloatingPreview }),
}));

const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const otherRef = scopeThreadRef(EnvironmentId.make("env-b"), ref.threadId);

function session(
  id: string,
  reveal: boolean,
  requestId?: string,
  force = false,
): PreviewSessionSnapshot {
  return {
    threadId: ref.threadId,
    tabId: PreviewTabId.make(id),
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    runtime: "server",
    reveal,
    ...(requestId ? { revealRequest: { id: requestId, force } } : {}),
    updatedAt: "2026-10-08T00:00:00Z",
  };
}

function setup(initial: readonly PreviewSessionSnapshot[] = [], beforeStart?: () => void) {
  const stack = new DisposableStack();
  const previousPlayer = usePreviewMiniPlayerStore.getState();
  const previousPanel = useRightPanelStore.getState();
  stack.defer(() => {
    resetPreviewStateForTests();
    usePreviewMiniPlayerStore.setState(previousPlayer, true);
    useRightPanelStore.setState(previousPanel, true);
  });
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  settings.autoShowFloatingPreview = true;
  let revision = 0;
  const update = (sessions: readonly PreviewSessionSnapshot[]) =>
    reconcilePreviewServerSessions(ref, {
      sessions,
      serverEpoch: "server-a",
      revision: ++revision,
    });
  update(initial);
  beforeStart?.();
  stack.defer(startAgentOpenedPreviews());
  return { update, [Symbol.dispose]: () => stack.dispose() };
}

const player = () =>
  selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, ref);
const tab = () =>
  selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, ref);

it("closes only the matching floating browser on a fresh hidden request", () => {
  using app = setup();
  app.update([session("tab-a", true, "shown")]);
  usePreviewMiniPlayerStore.getState().open(otherRef, browserMiniPlayerSource("tab-a"));
  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  const rightPanel = useRightPanelStore.getState().byThreadKey;
  expect(tab()).toBe("tab-a");
  app.update([session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  expect(
    selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, otherRef),
  ).toBe("tab-a");
  expect(useRightPanelStore.getState().byThreadKey).toEqual(rightPanel);
});

it("does not replay an old hidden request after the user manually reopens the browser", () => {
  using app = setup();
  app.update([session("tab-a", true, "shown")]);
  app.update([session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  app.update([{ ...session("tab-a", false, "hidden"), updatedAt: "2026-10-08T00:00:01Z" }]);
  expect(tab()).toBe("tab-a");
  // The store keeps the newer snapshot, so a later request must also be later.
  app.update([{ ...session("tab-a", false, "hidden-again"), updatedAt: "2026-10-08T00:00:02Z" }]);
  expect(player()).toBeNull();
});

it("leaves a different floating browser untouched", () => {
  using app = setup([session("tab-b", true)]);
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-b"));
  app.update([session("tab-b", true), session("tab-a", false, "hidden")]);
  expect(tab()).toBe("tab-b");
});

it("leaves a floating device untouched", () => {
  using app = setup();
  usePreviewMiniPlayerStore.getState().open(ref, {
    kind: "device",
    hostId: "host-a",
    deviceId: "device-a",
    platform: "android",
    name: "Pixel",
  });
  const before = player();
  app.update([session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("leaves a Scient artifact untouched", () => {
  using app = setup();
  const artifact: PreviewStaticImageSurfaceDescriptor = {
    surfaceId: "project-a:script.m:figure-001",
    label: "Figure 1",
    fileName: "figure-001.png",
    mediaType: "image/png",
    sourcePath: "script.m",
    resource: {
      _tag: "analysis-artifact",
      projectId: "project-a",
      runId: "run-a",
      artifactId: "figure-001",
      representationId: "static-png",
    } as PreviewStaticImageSurfaceDescriptor["resource"],
  };
  usePreviewMiniPlayerStore.getState().openArtifact(ref, artifact);
  const before = player();
  app.update([session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("suppresses a matching browser even when automatic floating is disabled", () => {
  using app = setup();
  settings.autoShowFloatingPreview = false;
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  app.update([session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
});

it("preserves default automatic reveal and explicit force when automatic floating is disabled", () => {
  using app = setup();
  app.update([session("tab-a", true, "default")]);
  expect(tab()).toBe("tab-a");
  usePreviewMiniPlayerStore.getState().close(ref);
  settings.autoShowFloatingPreview = false;
  app.update([session("tab-b", true, "unforced")]);
  expect(player()).toBeNull();
  app.update([session("tab-c", true, "forced", true)]);
  expect(tab()).toBe("tab-c");
});

it("activates an existing panel for a forced reveal instead of floating it", () => {
  using app = setup();
  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  useRightPanelStore.getState().open(ref, "diff");
  app.update([session("tab-a", true, "forced", true)]);
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.activeSurfaceId).toBe(
    "browser:tab-a",
  );
  expect(player()).toBeNull();
});

it("baselines old positive and negative requests on mount without changing manual presentation", () => {
  const sessions = [
    session("tab-hidden", false, "old-hidden"),
    session("tab-shown", true, "old-shown", true),
  ];
  using app = setup(sessions, () => {
    usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-hidden"));
  });
  expect(tab()).toBe("tab-hidden");
  app.update(sessions);
  expect(tab()).toBe("tab-hidden");
});

it("does not interpret an initial hidden tab without a request as fresh suppression", () => {
  using app = setup();
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  app.update([session("tab-a", false)]);
  expect(tab()).toBe("tab-a");
});
