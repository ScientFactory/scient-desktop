import "../index.css";
import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { type ComponentProps } from "react";

import { expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

async function _cleanupFixture0(_fixture: _Fixture) {
  for (const root of _fixture.root0.splice(0)) await act(async () => await root.unmount());
  _clearOwnedDOM(_fixture);
}

it("offers an accessible inactive issue tab without adding routine Markdown indicators", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.root0.push(root);
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
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
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
    onAddPullRequests: noop,
    onAddAgents: noop,
    onAddSources: noop,
    onAddCompute: noop,
    onAddDevice: noop,
    browserAvailable: false,
    terminalAvailable: false,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    agentsAvailable: false,
    sourcesAvailable: false,
    computeAvailable: false,
    deviceAvailable: false,
    children: <div>Editor</div>,
  };
  await act(async () => await root.rerender(<RightPanelTabs {...props} />));
  expect(host.querySelector('[aria-label*="changes need attention"]')).toBeNull();
  expect(host.querySelector(".rounded-full")).toBeNull();

  await act(
    async () =>
      await root.rerender(<RightPanelTabs {...props} attentionSurfaceIds={new Set([file.id])} />),
  );
  const attentionButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="notes.md: changes need attention"]',
  );
  expect(attentionButton).not.toBeNull();
  expect(attentionButton?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  await act(() => attentionButton?.click());
  expect(onActivate).toHaveBeenCalledExactlyOnceWith(file);

  await act(
    async () =>
      await root.rerender(
        <RightPanelTabs
          {...props}
          activeSurfaceId={file.id}
          attentionSurfaceIds={new Set([file.id])}
        />,
      ),
  );
  expect(host.querySelector('[aria-label*="changes need attention"]')).toBeNull();
  expect(host.textContent).toContain("notes.md");
  const agents = { id: "agents", kind: "agents" } as const;
  await act(
    async () =>
      await root.rerender(
        <RightPanelTabs
          {...props}
          surfaces={[agents, file]}
          agentsAvailable
          liveAgentCount={2}
          activeSurfaceId={file.id}
        />,
      ),
  );
  expect(host.querySelector('[aria-label="2 agents working"]')?.textContent).toBe("2");
  await act(
    async () =>
      await root.rerender(
        <RightPanelTabs
          {...props}
          surfaces={[agents, file]}
          agentsAvailable
          liveAgentCount={2}
          activeSurfaceId={agents.id}
        />,
      ),
  );
  expect(host.querySelector('[aria-label="2 agents working"]')).toBeNull();
  await act(
    async () =>
      await root.rerender(
        <RightPanelTabs
          {...props}
          surfaces={[agents, file]}
          agentsAvailable
          liveAgentCount={0}
          activeSurfaceId={file.id}
        />,
      ),
  );
  expect(host.querySelector('[aria-label="0 agents working"]')).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
