// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

const roots: ReturnType<typeof createRoot>[] = [];
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  if (originalGetAnimations)
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

it("offers an accessible inactive issue tab without adding routine Markdown indicators", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const file = {
    id: "file:notes.md" as const,
    kind: "file" as const,
    relativePath: "notes.md",
    revealLine: null,
    revealRequestId: 0,
  };
  const onActivate = vi.fn();
  const noop = () => undefined;
  const props: ComponentProps<typeof RightPanelTabs> = {
    mode: "inline",
    surfaces: [file, { id: "diff", kind: "diff" }],
    environmentId: null,
    activeSurfaceId: "diff",
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddAgents: noop,
    onAddSources: noop,
    onAddCompute: noop,
    browserAvailable: false,
    terminalAvailable: false,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: false,
    agentsAvailable: false,
    sourcesAvailable: false,
    computeAvailable: false,
    liveAgentCount: 0,
    children: <div>Editor</div>,
  };
  await act(() => root.render(<RightPanelTabs {...props} />));
  expect(host.querySelector('[aria-label*="changes need attention"]')).toBeNull();
  expect(host.querySelector(".rounded-full")).toBeNull();

  await act(() =>
    root.render(<RightPanelTabs {...props} attentionSurfaceIds={new Set([file.id])} />),
  );
  const attentionButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="notes.md — changes need attention"]',
  );
  expect(attentionButton).not.toBeNull();
  expect(attentionButton?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  await act(() => attentionButton?.click());
  expect(onActivate).toHaveBeenCalledExactlyOnceWith(file);

  await act(() =>
    root.render(
      <RightPanelTabs
        {...props}
        activeSurfaceId={file.id}
        attentionSurfaceIds={new Set([file.id])}
      />,
    ),
  );
  expect(host.querySelector('[aria-label*="changes need attention"]')).toBeNull();
  expect(host.textContent).toContain("notes.md");
});
