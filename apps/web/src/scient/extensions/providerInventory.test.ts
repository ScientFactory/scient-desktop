import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createProviderInventoryRequest,
  mergeProviderInventory,
  providerInventoryScope,
  type ProviderInventoryView,
} from "./providerInventory";

const instanceId = ProviderInstanceId.make("codex");
const provider = (
  workspaceSnapshots: ReadonlyArray<ServerProviderWorkspaceSnapshot> = [],
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-26T00:00:00.000Z",
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  plugins: [],
  mcpServers: [],
  workspaceSnapshots,
});
const snapshot = (cwd: string): ServerProviderWorkspaceSnapshot => ({
  cwd,
  checkedAt: "2026-10-26T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  plugins: [{ id: cwd, name: cwd, source: "local", enabled: true }],
});

function views() {
  const values: ProviderInventoryView[] = [];
  return {
    values,
    publish: (view: ProviderInventoryView) => {
      values.push(view);
    },
    last: () => values.at(-1)!,
  };
}

describe("page-owned provider inventory", () => {
  it("retains every root across 16-snapshot server eviction and more than 32 roots", async () => {
    const roots = new Set(Array.from({ length: 40 }, (_, index) => `/project-${index}`));
    const output = views();
    let retained: ServerProviderWorkspaceSnapshot[] = [snapshot("/unrelated")];
    const scanned: string[] = [];
    const request = createProviderInventoryRequest({
      roots,
      publish: output.publish,
      read: async (input) => {
        expect(input.workspaceSnapshotsOnDemand).toBe(false);
        expect(input.fresh).toBeUndefined();
        expect(input.refreshModels).toBe(false);
        expect(input.refreshManagedRuntimeCatalog).toBe(false);
        if (input.cwd) {
          scanned.push(input.cwd);
          retained = [...retained, snapshot(input.cwd)].slice(-16);
        }
        return { providers: [provider(retained)] };
      },
    });
    await request.refresh(null);
    expect(scanned).toEqual([...roots]);
    expect(output.last().phase).toBe("ready");
    expect(output.last().providers[0]?.workspaceSnapshots?.map((entry) => entry.cwd)).toEqual([
      ...roots,
    ]);
    expect(retained).toHaveLength(16);
    request.dispose();
  });

  it("coalesces revisions during a read and never rescans roots on its own inventory changes", async () => {
    const output = views();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const rootsRead: string[] = [];
    let installed = true;
    const request = createProviderInventoryRequest({
      roots: new Set(["/unopened"]),
      publish: output.publish,
      read: async (input) => {
        reads++;
        if (reads === 3) {
          entered.resolve();
          await release.promise;
        }
        if (input.cwd) rootsRead.push(input.cwd);
        const current = snapshot("/unopened");
        return {
          providers: [
            provider([{ ...current, plugins: installed ? (current.plugins ?? []) : [] }]),
          ],
        };
      },
    });
    await request.refresh(1);
    expect(rootsRead).toEqual(["/unopened"]);
    installed = false;
    const refreshing = request.refresh(2);
    await entered.promise;
    void request.refresh(3);
    void request.refresh(4);
    release.resolve();
    await refreshing;
    expect(reads).toBe(4);
    expect(rootsRead).toEqual(["/unopened"]);
    expect(output.last().providers[0]?.workspaceSnapshots?.[0]?.plugins).toEqual([]);
    // A new timestamp for the same revision is not another invalidation.
    await request.refresh(4);
    expect(reads).toBe(4);
    request.dispose();
  });

  it("suppresses a disposed scope's reply and does not admit its remaining roots", async () => {
    const output = views();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ providers: ReadonlyArray<ServerProvider> }>();
    let reads = 0;
    const request = createProviderInventoryRequest({
      roots: new Set(["/old"]),
      publish: output.publish,
      read: () => {
        reads++;
        entered.resolve();
        return release.promise;
      },
    });
    const waiting = request.refresh(null);
    await entered.promise;
    const before = output.values.length;
    request.dispose();
    release.resolve({ providers: [provider([snapshot("/old")])] });
    await waiting;
    expect(output.values).toHaveLength(before);
    expect(reads).toBe(1);
  });

  it("keeps successful rows while a root fails or omits its listing, distinct from empty", async () => {
    const output = views();
    const roots = new Set(["/good", "/failed", "/unknown"]);
    const request = createProviderInventoryRequest({
      roots,
      publish: output.publish,
      read: async (input) => {
        if (input.cwd === "/failed") throw new Error("Workspace unavailable");
        const { plugins: _plugins, ...unknown } = snapshot("/unknown");
        return { providers: [provider([snapshot("/good"), unknown])] };
      },
    });
    await request.refresh(null);
    expect(output.last().phase).toBe("partial");
    expect(output.last().errors).toEqual(["/failed: Workspace unavailable"]);
    expect(output.last().providers[0]?.workspaceSnapshots?.[0]?.plugins).toHaveLength(1);
    request.dispose();

    const empty = createProviderInventoryRequest({
      roots: new Set(),
      publish: output.publish,
      read: async () => ({ providers: [provider()] }),
    });
    await empty.refresh(null);
    expect(output.last()).toMatchObject({ phase: "ready", errors: [] });
    empty.dispose();
    const failed = createProviderInventoryRequest({
      roots: new Set(),
      publish: output.publish,
      read: async () => {
        throw new Error("Denied");
      },
    });
    await failed.refresh(null);
    expect(output.last()).toMatchObject({ phase: "error", providers: [], errors: ["Denied"] });
    failed.dispose();
  });

  it("never merges roots across a coalesced generation reset", () => {
    const roots = new Set(["/a", "/b"]);
    const old = { ...provider([snapshot("/a")]), nativeInventoryGeneration: "old" };
    const replacement = { ...provider([snapshot("/b")]), nativeInventoryGeneration: "new" };
    expect(mergeProviderInventory([old], [replacement], roots)[0]?.workspaceSnapshots).toEqual([
      snapshot("/b"),
    ]);
    expect(providerInventoryScope([old])).not.toBe(providerInventoryScope([replacement]));
    expect(providerInventoryScope([old])).toBe(
      providerInventoryScope([
        { ...old, checkedAt: "2026-10-26T01:00:00.000Z", workspaceSnapshots: [] },
      ]),
    );
  });

  it("rejects a retired-generation reply before publishing or admitting another root", async () => {
    const output = views();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ providers: ReadonlyArray<ServerProvider> }>();
    const current = { ...provider(), nativeInventoryGeneration: "current" };
    const request = createProviderInventoryRequest({
      roots: new Set(["/a", "/b"]),
      providerScope: providerInventoryScope([current]),
      publish: output.publish,
      read: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const pending = request.refresh(null);
    await entered.promise;
    const before = output.values.length;
    release.resolve({
      providers: [{ ...provider([snapshot("/a")]), nativeInventoryGeneration: "retired" }],
    });
    await pending;
    expect(output.values).toHaveLength(before);
    expect(output.last().providers).toEqual([]);
    request.dispose();
  });

  it("honors empty lists, provider removal and snapshot reset while retaining evicted roots", () => {
    const roots = new Set(["/a", "/b"]);
    const previous = [provider([snapshot("/a"), snapshot("/b")])];
    const removedPlugin = mergeProviderInventory(
      previous,
      [provider([{ ...snapshot("/b"), plugins: [] }])],
      roots,
    );
    expect(removedPlugin[0]?.workspaceSnapshots).toEqual([
      snapshot("/a"),
      { ...snapshot("/b"), plugins: [] },
    ]);
    expect(mergeProviderInventory(previous, [provider()], roots)[0]?.workspaceSnapshots).toEqual(
      [],
    );
    expect(mergeProviderInventory(previous, [], roots)).toEqual([]);
  });
});
