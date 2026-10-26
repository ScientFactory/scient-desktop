// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { locateOverleafRetention } from "./OverleafRetentionVault.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { detectableOverleafCloudRoots, overleafCloudRoot } from "./overleafCloudRoots.ts";
vi.mock("node:os", { spy: true });

it("finds configured clients and recognizes absent descendants through a symlink", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cloud-roots-"));
  try {
    const provider = NodePath.join(home, "custom-drive");
    await NodeFSP.mkdir(provider);
    await NodeFSP.mkdir(NodePath.join(home, ".dropbox"));
    await NodeFSP.writeFile(
      NodePath.join(home, ".dropbox/info.json"),
      JSON.stringify({ personal: { path: provider } }),
    );
    await NodeFSP.mkdir(NodePath.join(home, ".config/onedrive"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, ".config/onedrive/config"),
      'sync_dir = "~/one-drive"\n',
    );
    const roots = await detectableOverleafCloudRoots(home, "linux");
    expect(roots).toContain(provider);
    expect(roots).toContain(NodePath.join(home, "one-drive"));
    const alias = NodePath.join(home, "alias");
    await NodeFSP.symlink(provider, alias);
    expect(await overleafCloudRoot(NodePath.join(alias, "absent/retained"), roots)).toBe(
      await NodeFSP.realpath(provider),
    );
    expect(await overleafCloudRoot(NodePath.join(home, "custom-drive-other"), roots)).toBeNull();
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it("detects iCloud and every registered macOS File Provider root", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cloud-mac-"));
  try {
    const provider = NodePath.join(home, "Library/CloudStorage/Provider-account");
    await NodeFSP.mkdir(provider, { recursive: true });
    const roots = await detectableOverleafCloudRoots(home, "darwin");
    expect(await overleafCloudRoot(NodePath.join(provider, ".scient-overleaf"), roots)).toBe(
      await NodeFSP.realpath(provider),
    );
    expect(roots).toContain(NodePath.join(home, "Library/Mobile Documents"));
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});

it.live("refuses cloud-managed state before its first write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cloud-state-")),
        ),
        (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
      );
      const provider = NodePath.join(home, "provider");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(provider);
        await NodeFSP.mkdir(NodePath.join(home, ".dropbox"));
        await NodeFSP.writeFile(
          NodePath.join(home, ".dropbox/info.json"),
          JSON.stringify({ personal: { path: provider } }),
        );
      });
      using _home = vi.spyOn(NodeOS, "homedir").mockReturnValue(home);
      using _host = vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("linux");
      const state = NodePath.join(provider, "state");
      const store = yield* OverleafStateStore.make({ root: state });
      expect(yield* Effect.flip(store.admitWritable)).toMatchObject({
        _tag: "OverleafRetentionUnavailableError",
        reason: "sync-managed-folder",
      });
      yield* Effect.promise(() =>
        expect(NodeFSP.lstat(state)).rejects.toMatchObject({ code: "ENOENT" }),
      );
    }),
  ).pipe(Effect.provideService(HostProcess.UserId, process.getuid?.())),
);

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "never moves or recreates a recorded kept folder after its location becomes managed",
  async () => {
    const home = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cloud-vault-")),
    );
    try {
      const helper = await filePublicationTestHelper();
      const checkout = NodePath.join(home, "paper"),
        state = NodePath.join(home, "state");
      await NodeFSP.mkdir(checkout);
      await NodeFSP.mkdir(state, { mode: 0o700 });
      using _home = vi.spyOn(NodeOS, "homedir").mockReturnValue(home);
      const input = {
        stateRetained: NodePath.join(state, "retained"),
        environmentId: "env",
        connectionId: "conn",
        checkoutRoot: checkout,
        userId: process.getuid?.(),
        publicationHelper: helper ?? null,
        volumeUuid: async () => "0A1B2C3D-0000-4000-8000-000000000001",
        expected: null,
      };
      const first = await locateOverleafRetention(input);
      expect(first._tag).toBe("ready");
      if (first._tag !== "ready") throw new Error("No initial vault");
      const before = await NodeFSP.stat(first.directory, { bigint: true });
      await NodeFSP.mkdir(NodePath.join(home, ".dropbox"));
      await NodeFSP.writeFile(
        NodePath.join(home, ".dropbox/info.json"),
        JSON.stringify({ personal: { path: state } }),
      );
      expect(await locateOverleafRetention({ ...input, expected: first.identity })).toEqual({
        _tag: "refused",
        reason: "sync-managed-folder",
      });
      expect((await NodeFSP.stat(first.directory, { bigint: true })).ino).toBe(before.ino);
      await expect(NodeFSP.lstat(NodePath.join(home, ".scient-overleaf"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);
