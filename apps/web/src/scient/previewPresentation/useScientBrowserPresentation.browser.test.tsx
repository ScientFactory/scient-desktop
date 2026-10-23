import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";

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

async function update(
  _fixture: _Fixture,
  sessions: readonly PreviewSessionSnapshot[],
  overrides: Partial<Input> = {},
) {
  _fixture.input = {
    ..._fixture.input,
    ...overrides,
    previewState: {
      listLoaded: true,
      sessions: Object.fromEntries(sessions.map((snapshot) => [snapshot.tabId, snapshot])),
    },
  };
  await act(async () => await _fixture.root0!.rerender(<Probe value={_fixture.input} />));
}

const player = () =>
  selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, ref);
const tab = () =>
  selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, ref);

async function _setupFixture0(_fixture: _Fixture) {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  _fixture.input = {
    threadRef: ref,
    serverBrowserAvailable: true,
    previewState: { listLoaded: true, sessions: {} },
    autoShowFloatingPreview: true,
    surfaces: [],
  };
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe value={_fixture.input} />);
  });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

it("closes only the matching floating browser on a fresh hidden request", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, [session("tab-a", true, "shown")]);
  usePreviewMiniPlayerStore.getState().open(otherRef, browserMiniPlayerSource("tab-a"));
  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  const rightPanel = useRightPanelStore.getState().byThreadKey;
  expect(tab()).toBe("tab-a");
  await update(_fixture, [session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  expect(
    selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, otherRef),
  ).toBe("tab-a");
  expect(useRightPanelStore.getState().byThreadKey).toBe(rightPanel);
});

it("does not replay an old hidden request after the user manually reopens the browser", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, [session("tab-a", true, "shown")]);
  await update(_fixture, [session("tab-a", false, "hidden")]);
  expect(player()).toBeNull();
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  await update(_fixture, [
    { ...session("tab-a", false, "hidden"), updatedAt: "2026-10-08T00:00:01Z" },
  ]);
  expect(tab()).toBe("tab-a");
  await update(_fixture, [session("tab-a", false, "hidden-again")]);
  expect(player()).toBeNull();
});

it("leaves a different floating browser untouched", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-b"));
  await update(_fixture, [session("tab-a", false, "hidden")]);
  expect(tab()).toBe("tab-b");
});

it("leaves a floating device untouched", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().open(ref, {
    kind: "device",
    hostId: "host-a",
    deviceId: "device-a",
    platform: "android",
    name: "Pixel",
  });
  const before = player();
  await update(_fixture, [session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("leaves a Scient artifact untouched", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

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
  await update(_fixture, [session("tab-a", false, "hidden")]);
  expect(player()).toBe(before);
});

it("suppresses a matching browser even when automatic floating is disabled", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  await update(_fixture, [session("tab-a", false, "hidden")], { autoShowFloatingPreview: false });
  expect(player()).toBeNull();
});

it("preserves default automatic reveal and explicit force when automatic floating is disabled", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, [session("tab-a", true, "default")]);
  expect(tab()).toBe("tab-a");
  usePreviewMiniPlayerStore.getState().close(ref);
  await update(_fixture, [session("tab-a", true, "unforced")], { autoShowFloatingPreview: false });
  expect(player()).toBeNull();
  await update(_fixture, [session("tab-a", true, "forced", true)]);
  expect(tab()).toBe("tab-a");
});

it("activates an existing panel for a forced reveal instead of floating it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  useRightPanelStore.getState().openBrowser(ref, "tab-a");
  const activate = vi.spyOn(useRightPanelStore.getState(), "activateSurface");
  await update(_fixture, [session("tab-a", true, "forced", true)], {
    surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
  });
  expect(activate).toHaveBeenCalledWith(ref, "browser:tab-a");
  expect(player()).toBeNull();
});

it("baselines old positive and negative requests on mount without changing manual presentation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(async () => await _fixture.root0!.unmount());
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-hidden"));
  _fixture.input = {
    ..._fixture.input,
    previewState: {
      listLoaded: true,
      sessions: {
        "tab-hidden": session("tab-hidden", false, "old-hidden"),
        "tab-shown": session("tab-shown", true, "old-shown", true),
      },
    },
  };
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe value={_fixture.input} />);
  });
  expect(tab()).toBe("tab-hidden");
  await update(_fixture, Object.values(_fixture.input.previewState.sessions));
  expect(tab()).toBe("tab-hidden");
});

it("does not interpret an initial hidden tab without a request as fresh suppression", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab-a"));
  await update(_fixture, [session("tab-a", false)]);
  expect(tab()).toBe("tab-a");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    input: undefined! as Input,

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
