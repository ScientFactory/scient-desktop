import { RegistryContext } from "@effect/atom-react";
import {
  AuthStandardClientScopes,
  EnvironmentFilePath,
  EnvironmentId,
  ThreadId,
  type EnvironmentFilePrepareResult,
  type EnvironmentFileChangeEvent,
  type AssetCreateUrlResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { projectEnvironment } from "~/state/projects";
import { filesystemEnvironment } from "~/state/filesystem";
import { useRightPanelStore } from "~/rightPanelStore";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { environmentFileLinkResolution } from "./environmentFileState";
import EnvironmentFilePreview from "./EnvironmentFilePreview";

const boundary = vi.hoisted(() => ({
  prepare: vi.fn<() => EnvironmentFilePrepareResult>(),
  preparationRequest: vi.fn(),
  watchRequest: vi.fn(),
  assetRequest: vi.fn(),
  mint: vi.fn<() => AssetCreateUrlResult>(),
  resolve: vi.fn(),
  search: vi.fn(),
  metadata: vi.fn(),
  command: vi.fn(),
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("./environmentFileState"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const files = Atom.family((_key: string) => Atom.make(Effect.sync(() => boundary.prepare())));
  return {
    ...actual,
    environmentFilePreparation: (
      target: Parameters<typeof actual.environmentFilePreparation>[0],
    ) => {
      boundary.preparationRequest(target);
      return files(JSON.stringify(target));
    },
  };
});
vi.mock(import("./environmentFileChanges"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const changes = Atom.family((_key: string) =>
    Atom.make(AsyncResult.initial<EnvironmentFileChangeEvent, never>(false)),
  );
  return {
    ...actual,
    environmentFileChanges: (target: Parameters<typeof actual.environmentFileChanges>[0]) => {
      boundary.watchRequest(target);
      return changes(JSON.stringify(target));
    },
  };
});
vi.mock(import("~/state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const urls = Atom.family((_key: string) => Atom.make(Effect.sync(() => boundary.mint())));
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => {
        boundary.assetRequest(target);
        return urls(JSON.stringify(target));
      },
    },
  };
});
vi.mock(import("~/state/use-atom-query-runner"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomQueryRunner: ((
      family: unknown,
      options: Parameters<typeof actual.useAtomQueryRunner>[1],
    ) =>
      family === environmentFileLinkResolution
        ? boundary.resolve
        : family === projectEnvironment.searchEntries
          ? boundary.search
          : family === filesystemEnvironment.getMetadata
            ? boundary.metadata
            : actual.useAtomQueryRunner(
                family as Parameters<typeof actual.useAtomQueryRunner>[0],
                options,
              )) as typeof actual.useAtomQueryRunner,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => boundary.command,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => "https://file-host.test",
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const Option = await import("effect/Option");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("readonly-host"),
    label: "Read-only fixture",
    httpBaseUrl: "https://file-host.test",
    wsBaseUrl: "wss://file-host.test",
  });
  const connection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  } satisfies NonNullable<ReturnType<typeof actual.readPreparedConnection>>;
  const grants = new Set<string>(AuthStandardClientScopes);
  const hasScope = (_id: unknown, scope: string) => grants.has(scope);
  return {
    ...actual,
    readEnvironmentScope: hasScope,
    useEnvironmentScope: hasScope,
    readPreparedConnection: () => connection,
    usePreparedConnection: () => Option.some(connection),
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({
    state: { mode: "remote-unavailable" },
    isResolved: true,
  }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("readonly-host"),
  threadId: ThreadId.make("readonly-thread"),
};
const canonicalPath = "/srv/physics/notes/current.md";
const markdown = "- [ ] Keep the source unchanged\n\n[Linked file](notes/linked.md:7)\n";
const assetUrl = "https://file-host.test/api/assets/readonly-markdown";

function setup() {
  const settings = getClientSettings();
  const panel = useRightPanelStore.getState();
  const registry = AtomRegistry.make();
  __setClientSettingsForTests(settings);
  boundary.prepare.mockReset().mockReturnValue({
    canonicalPath: EnvironmentFilePath.make(canonicalPath),
    fileName: "current.md",
    byteLength: new TextEncoder().encode(markdown).byteLength,
    mtimeMs: 1,
    presentation: { kind: "markdown", mediaType: "text/markdown", textEncoding: "utf-8" },
  });
  boundary.preparationRequest.mockReset();
  boundary.watchRequest.mockReset();
  boundary.assetRequest.mockReset();
  boundary.mint.mockReset().mockReturnValue({
    relativeUrl: "/api/assets/readonly-markdown",
    expiresAt: 1,
  });
  boundary.resolve.mockReset().mockImplementation((target: { input: { path: string } }) =>
    Promise.resolve(
      AsyncResult.success({
        _tag: "literal",
        path: EnvironmentFilePath.make(target.input.path),
      }),
    ),
  );
  boundary.search.mockReset().mockResolvedValue(
    AsyncResult.success({
      entries: [{ path: "linked.md", kind: "file" }],
      truncated: false,
    }),
  );
  boundary.metadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  boundary.command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    registry,
    [Symbol.dispose]() {
      registry.dispose();
      useRightPanelStore.setState(panel, true);
      __setClientSettingsForTests(settings);
    },
  };
}

it("keeps an environment Markdown file read-only and its nested links canonical", async () => {
  using environment = setup();
  const fetchFile = vi.fn<typeof fetch>(async (input) => {
    expect(String(input)).toBe(assetUrl);
    return new Response(new TextEncoder().encode(markdown), {
      status: 206,
      headers: { "Content-Type": "text/markdown" },
    });
  });
  using _fetch = stubGlobal("fetch", fetchFile);
  using opened = vi.spyOn(useRightPanelStore.getState(), "openFile");
  await using screen = await render(
    <RegistryContext.Provider value={environment.registry}>
      <EnvironmentFilePreview
        availableEditors={[]}
        environmentId={threadRef.environmentId}
        keybindings={[]}
        surface={{
          id: "scient:file:readonly",
          kind: "scient",
          module: "file",
          path: "/requested/current.md",
          line: null,
        }}
        threadRef={threadRef}
      />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByRole("link", { name: /linked\.md/ })).toBeVisible();
  const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.readOnly).toBe(true);
  expect(checkbox.checked).toBe(false);
  expect(screen.container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
  await act(() => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(boundary.command).not.toHaveBeenCalled();

  expect(boundary.preparationRequest).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { path: "/requested/current.md" },
  });
  expect(boundary.watchRequest).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { path: canonicalPath },
  });
  expect(boundary.assetRequest).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { resource: { _tag: "environment-file", path: canonicalPath, access: "exact" } },
  });
  expect(fetchFile).toHaveBeenCalledWith(
    assetUrl,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: { Range: "bytes=0-2097151" },
    }),
  );
  await act(() =>
    screen.container.querySelector<HTMLAnchorElement>('a[href$="notes/linked.md:7"]')!.click(),
  );

  expect(boundary.resolve).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: {
      workspaceRoot: "/srv/physics/notes",
      path: "/srv/physics/notes/notes/linked.md",
      changedPaths: [],
    },
  });
  expect(opened).toHaveBeenCalledExactlyOnceWith(
    threadRef,
    "/srv/physics/notes/notes/linked.md",
    7,
  );
  expect(boundary.search).not.toHaveBeenCalled();
  expect(boundary.metadata).not.toHaveBeenCalled();
  expect(boundary.command).not.toHaveBeenCalled();
});
