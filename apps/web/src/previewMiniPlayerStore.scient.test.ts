import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  type PreviewMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "./previewStaticImageSurface";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const tabA = browserMiniPlayerSource("tab-a");
const pixel: PreviewMiniPlayerSource = {
  kind: "device",
  hostId: "nucbox",
  deviceId: "emulator-5580",
  platform: "android",
  name: "Pixel",
};

const artifact = (runId: string, label = "Figure 1"): PreviewStaticImageSurfaceDescriptor => ({
  surfaceId: "project-a:script.m:figure-001",
  label,
  fileName: "figure-001.png",
  mediaType: "image/png",
  sourcePath: "script.m",
  resource: {
    _tag: "analysis-artifact",
    projectId: "project-a",
    runId,
    artifactId: "figure-001",
    representationId: "static-png",
  } as PreviewStaticImageSurfaceDescriptor["resource"],
});

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("Scient floating previews", () => {
  it("preserves the card rectangle when its content changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().setRect(refA, "browser:tab-a", {
      position: { x: 24, y: 48 },
      size: { width: 480, height: 320 },
    });
    usePreviewMiniPlayerStore.getState().openArtifact(refA, artifact("run-1"));

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      content: {
        kind: "static-artifact",
        id: artifact("run-1").surfaceId,
        artifact: artifact("run-1"),
      },
      position: { x: 24, y: 48 },
      size: { width: 480, height: 320 },
      lastInteraction: "resize",
    });
  });

  it("opens a floating preview at an explicit drag-drop position", () => {
    usePreviewMiniPlayerStore.getState().openArtifact(refA, artifact("run-1"), { x: 180, y: 96 });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ position: { x: 180, y: 96 }, size: null });
  });

  it("updates an open artifact without losing the card layout", () => {
    const first = artifact("run-1");
    const updated = {
      ...artifact("run-2", "Updated figure"),
      reloadKey: "revision-2",
      statusLabel: "Previous figure",
    };
    usePreviewMiniPlayerStore.getState().openArtifact(refA, first, { x: 90, y: 70 });
    usePreviewMiniPlayerStore.getState().resize(refA, first.surfaceId, { width: 500, height: 340 });
    usePreviewMiniPlayerStore.getState().updateArtifact(refA, updated);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      content: { kind: "static-artifact", id: updated.surfaceId, artifact: updated },
      position: { x: 90, y: 70 },
      size: { width: 500, height: 340 },
      lastInteraction: "resize",
    });
  });

  it("never recreates a floating card during a passive artifact update", () => {
    const first = artifact("run-1");
    const updated = artifact("run-2");
    usePreviewMiniPlayerStore.getState().updateArtifact(refA, updated);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});

    usePreviewMiniPlayerStore.getState().openArtifact(refA, first);
    usePreviewMiniPlayerStore.getState().close(refA);
    usePreviewMiniPlayerStore.getState().updateArtifact(refA, updated);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("keeps a resize placement after release and clears it when dragging", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, tabA);
    store.setRect(refA, "browser:tab-a", {
      position: { x: 1112, y: 275 },
      size: { width: 460, height: 300 },
    });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      size: { width: 460 },
      position: { x: 1112, y: 275 },
      lastInteraction: "resize",
    });
    store.move(refA, "browser:tab-a", { x: 1104, y: 275 });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      size: { width: 460 },
      position: { x: 1104, y: 275 },
      lastInteraction: "drag",
    });
  });

  it("floats one source per thread, so a device replaces the browser tab", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, pixel);
    const floating = selectThreadPreviewMiniPlayer(
      usePreviewMiniPlayerStore.getState().byThreadKey,
      refA,
    );

    expect(floating).toMatchObject({ content: { ...pixel, id: expect.any(String) } });
    expect(
      selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBeNull();
    usePreviewMiniPlayerStore.getState().open(refA, { ...pixel, name: "Renamed" });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBe(floating);
  });
});
