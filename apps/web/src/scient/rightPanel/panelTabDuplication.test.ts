import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { duplicatePanelSurface } from "./panelTabDuplication";

const openPreviewSession = vi.hoisted(() => vi.fn());
vi.mock("~/components/preview/openPreviewSession", () => ({ openPreviewSession }));
const addToast = vi.hoisted(() => vi.fn());
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: addToast } }));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("duplicate"));
const panelTabs = () =>
  useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces.map((s) => s.id) ?? [];
// Only the fields the copy reads matter here.
const previewTab = { id: "preview:page-1", kind: "preview", resourceId: "page-1" };
const session = {
  navStatus: { url: "https://example.com/docs" },
  profileId: "work",
} as unknown as PreviewSessionSnapshot;

afterEach(() => {
  vi.clearAllMocks();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("duplicatePanelSurface", () => {
  it("opens a new terminal for a terminal tab", () => {
    const addTerminal = vi.fn();
    duplicatePanelSurface({
      surface: { id: "terminal:a", kind: "terminal" } as unknown as RightPanelSurface,
      threadRef: ref,
      openPreview: vi.fn(),
      previewSessions: {},
      addTerminal,
    });
    expect(addTerminal).toHaveBeenCalledTimes(1);
    expect(openPreviewSession).not.toHaveBeenCalled();
  });

  it("opens the same page in the same profile as a new browser tab", async () => {
    openPreviewSession.mockResolvedValue({ _tag: "Success", value: { tabId: "page-2" } });
    duplicatePanelSurface({
      surface: previewTab as unknown as RightPanelSurface,
      threadRef: ref,
      openPreview: vi.fn(),
      previewSessions: { "page-1": session },
      addTerminal: vi.fn(),
    });
    expect(openPreviewSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/docs", profileId: "work" }),
    );
    await vi.waitFor(() => expect(panelTabs()).toHaveLength(1));
    expect(addToast).not.toHaveBeenCalled();
  });

  it("says so when the copy could not open", async () => {
    openPreviewSession.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("closed")),
    });
    duplicatePanelSurface({
      surface: previewTab as unknown as RightPanelSurface,
      threadRef: ref,
      openPreview: vi.fn(),
      previewSessions: { "page-1": session },
      addTerminal: vi.fn(),
    });
    await vi.waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(panelTabs()).toEqual([]);
  });
});
