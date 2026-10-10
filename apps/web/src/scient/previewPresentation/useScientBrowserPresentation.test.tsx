import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "../../previewStaticImageSurface";
import { useRightPanelStore } from "../../rightPanelStore";
import { useScientBrowserPresentation } from "./useScientBrowserPresentation";

const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const otherRef = scopeThreadRef(EnvironmentId.make("env-b"), ref.threadId);
type Input = Parameters<typeof useScientBrowserPresentation>[0];
let renderer: ReactTestRenderer | undefined;
let input: Input;

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

function Probe({ value }: { value: Input }) {
  useScientBrowserPresentation(value);
  return null;
}

function update(sessions: readonly PreviewSessionSnapshot[], overrides: Partial<Input> = {}) {
  input = {
    ...input,
    ...overrides,
    previewState: {
      listLoaded: true,
      sessions: Object.fromEntries(sessions.map((snapshot) => [snapshot.tabId, snapshot])),
    },
  };
  act(() => renderer!.update(<Probe value={input} />));
}

const player = () =>
  selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, ref);
const tab = () =>
  selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, ref);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  input = {
    threadRef: ref,
    serverBrowserAvailable: true,
    previewState: { listLoaded: true, sessions: {} },
    autoShowFloatingPreview: true,
    surfaces: [],
  };
  act(() => {
    renderer = create(<Probe value={input} />);
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("closes only the matching floating browser on a fresh hidden request", () => {
  update([session("tab-a", true, "shown")]);
  usePreviewMiniPlayerStore.getState().open(otherRef, browserMiniPlayerSource("tab-a"));
  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  const rightPanel = useRightPanelStore.getState().byThreadKey;
  expect(tab()).toBe("tab-a");
  update([session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  expect(
    selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, otherRef),
  ).toBe("tab-a");
  expect(useRightPanelStore.getState().byThreadKey).toBe(rightPanel);
});

it("does not replay an old hidden request after the user manually reopens the browser", () => {
  update([session("tab-a", true, "shown")]);
  update([session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  update([{ ...session("tab-a", false, "hidden"), updatedAt: "2026-10-08T00:00:01Z" }]);
  expect(tab()).toBe("tab-a");
  update([session("tab-a", false, "hidden-again")]);
  expect(player()).toBeNull();
});

it("leaves a different floating browser untouched", () => {
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-b"));
  update([session("tab-a", false, "hidden")]);
  expect(tab()).toBe("tab-b");
});

it("leaves a floating device untouched", () => {
  usePreviewMiniPlayerStore.getState().open(ref, {
    kind: "device",
    hostId: "host-a",
    deviceId: "device-a",
    platform: "android",
    name: "Pixel",
  });
  const before = player();
  update([session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("leaves a Scient artifact untouched", () => {
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
  update([session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("suppresses a matching browser even when automatic floating is disabled", () => {
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  update([session("tab-a", false, "hidden")], { autoShowFloatingPreview: false });
  expect(player()).toBeNull();
});

it("preserves default automatic reveal and explicit force when automatic floating is disabled", () => {
  update([session("tab-a", true, "default")]);
  expect(tab()).toBe("tab-a");
  usePreviewMiniPlayerStore.getState().close(ref);
  update([session("tab-a", true, "unforced")], { autoShowFloatingPreview: false });
  expect(player()).toBeNull();
  update([session("tab-a", true, "forced", true)]);
  expect(tab()).toBe("tab-a");
});

it("activates an existing panel for a forced reveal instead of floating it", () => {
  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  const activate = vi.spyOn(useRightPanelStore.getState(), "activateSurface");
  update([session("tab-a", true, "forced", true)], {
    surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
  });
  expect(activate).toHaveBeenCalledWith(ref, "browser:tab-a");
  expect(player()).toBeNull();
});

it("baselines old positive and negative requests on mount without changing manual presentation", () => {
  act(() => renderer!.unmount());
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-hidden"));
  input = {
    ...input,
    previewState: {
      listLoaded: true,
      sessions: {
        "tab-hidden": session("tab-hidden", false, "old-hidden"),
        "tab-shown": session("tab-shown", true, "old-shown", true),
      },
    },
  };
  act(() => {
    renderer = create(<Probe value={input} />);
  });
  expect(tab()).toBe("tab-hidden");
  update(Object.values(input.previewState.sessions));
  expect(tab()).toBe("tab-hidden");
});

it("does not interpret an initial hidden tab without a request as fresh suppression", () => {
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  update([session("tab-a", false)]);
  expect(tab()).toBe("tab-a");
});
