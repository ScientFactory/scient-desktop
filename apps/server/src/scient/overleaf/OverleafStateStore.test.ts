// @effect-diagnostics nodeBuiltinImport:off -- Real directories, a real second process, real fsync.
// Coordinator contract step 1: the store-level parts of acceptance cases A04
// (second process, lease), A17 (corrupt/unsupported state), A20 (retention
// location: remount, unplug, no volume UUID, exFAT, read-only, disk root), and A19 only for failures injected at the store's
// write boundaries (not partial writes or process death mid-write).
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import type {
  OverleafConnectionDocument,
  OverleafOperationReceipt,
} from "./OverleafConnectionState.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import type { OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import { fileExchangeTestHelper } from "../workspace/fileExchange.testkit.ts";

const VOLUME = "0A1B2C3D-0000-4000-8000-000000000001";
const fakeVolume: OverleafVolumeIdentityResolver = async () => VOLUME;
const helper = await fileExchangeTestHelper();
const diskImagesAvailable =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync("/usr/bin/hdiutil", ["help"]).status !== null;

/** A disposable disk image; attach mounts it at a chosen path, as a reconnected disk would be. */
const diskImage = (root: string, format: "APFS" | "ExFAT") =>
  Effect.gen(function* () {
    const file = NodePath.join(root, `${format}.dmg`);
    yield* Effect.promise(async () => {
      NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
        "create",
        "-quiet",
        "-size",
        "20m",
        "-fs",
        format,
        "-volname",
        `SCT${format.toUpperCase()}`,
        file,
      ]);
    });
    let mounted: string | null = null;
    const detach = Effect.sync(() => {
      if (mounted === null) return;
      NodeChildProcess.execFileSync("/usr/bin/hdiutil", ["detach", "-force", "-quiet", mounted]);
      mounted = null;
    });
    yield* Effect.addFinalizer(() => detach);
    return {
      attach: (name: string) =>
        Effect.promise(async () => {
          const point = NodePath.join(root, `mount-${name}`);
          await NodeFSP.mkdir(point);
          NodeChildProcess.execFileSync("/usr/bin/hdiutil", [
            "attach",
            "-quiet",
            "-nobrowse",
            "-mountpoint",
            point,
            file,
          ]);
          mounted = point;
          return NodeFSP.realpath(point);
        }),
      detach,
    };
  });

type Point = Parameters<NonNullable<OverleafStateStore.OverleafStateStoreHooks["at"]>>[0];

const temporaryRoot = () =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-overleaf-state-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

/**
 * A store whose lifetime (and lease) ends when `close` runs, like a server
 * exit, or at the latest when the test's scope closes.
 */
const openStore = (
  root: string,
  hooks?: OverleafStateStore.OverleafStateStoreHooks,
  volumeUuid?: OverleafVolumeIdentityResolver,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const store = yield* OverleafStateStore.make({
      root,
      ...(hooks === undefined ? {} : { hooks }),
      ...(volumeUuid === undefined ? {} : { volumeUuid }),
    }).pipe(Scope.provide(scope));
    return { store, close: Scope.close(scope, Exit.void) };
  });

const revised = (
  document: OverleafConnectionDocument,
  change: Partial<OverleafConnectionDocument> = {},
): OverleafConnectionDocument => ({
  ...document,
  revision: document.revision + 1,
  updatedAt: "2026-10-13T11:00:00.000Z",
  ...change,
});

const receipt = (change: Partial<OverleafOperationReceipt> = {}): OverleafOperationReceipt => ({
  schemaVersion: 1,
  connectionId: "connection-1",
  requestId: "request-1",
  kind: "confirm",
  payloadDigest: "a".repeat(64),
  operationId: "operation-1",
  status: "running",
  resultCategory: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  ...change,
});

const connectionsDirectory = (root: string) => NodePath.join(root, "connections");
const listTemporaries = (root: string) =>
  NodeFSP.readdir(connectionsDirectory(root)).then((entries) =>
    entries.filter((entry) => entry.endsWith(".tmp")),
  );

/**
 * Holds the lease from a separate OS process, exactly as another server would.
 * Resolves once the child has reported whether it got the lock.
 */
function leaseHolder(root: string) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;");
      db.exec("CREATE TABLE IF NOT EXISTS overleaf_lease (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at INTEGER NOT NULL)");
      db.exec("INSERT OR REPLACE INTO overleaf_lease (id, acquired_at) VALUES (1, 0)");
      process.stdout.write("held\\n");
    } catch (error) {
      process.stdout.write("busy\\n");
      process.exit(0);
    }
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", script, NodePath.join(root, "lease.sqlite")],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const status = new Promise<"held" | "busy">((resolve, reject) => {
    child.stdout.once("data", (data: Buffer) =>
      resolve(data.toString().trim() === "held" ? "held" : "busy"),
    );
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    status,
    /** Ends the process abruptly, as a crash would; the kernel drops its lock. */
    kill: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

describe("OverleafStateStore", () => {
  it.live("creates once, reads back, and replaces only by compare-and-set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        const document = overleafConnectionFixture();
        expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "missing" });
        yield* store.createConnection(document);
        expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "ready", document });
        expect(yield* store.listConnections).toEqual(["connection-1"]);

        const duplicate = yield* Effect.flip(store.createConnection(document));
        expect(duplicate._tag).toBe("OverleafConnectionExistsError");

        const second = revised(document);
        yield* store.replaceConnection({ expectedRevision: 1, next: second });
        // A writer that read revision 1 cannot overwrite revision 2.
        const stale = yield* Effect.flip(
          store.replaceConnection({ expectedRevision: 1, next: revised(document) }),
        );
        expect(stale).toMatchObject({
          _tag: "OverleafConnectionStaleError",
          expectedRevision: 1,
          actualRevision: 2,
        });
        expect(yield* store.readConnection("connection-1")).toEqual({
          _tag: "ready",
          document: second,
        });
        const mode = (yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(connectionsDirectory(root), "connection-1.json")),
        )).mode;
        expect(mode & 0o077).toBe(0);
      }),
    ),
  );

  it.live("persists nothing when a replacement would drop publication evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        const document = overleafConnectionFixture();
        yield* store.createConnection(document);
        const unknown = revised(document, {
          lastAttemptNumber: 1,
          attempts: [
            {
              attemptNumber: 1,
              operationId: "operation-1",
              requestId: "request-1",
              planDigest: "a".repeat(64),
              authority: { bindingId: "binding-1", authorityGeneration: 1, scopeRevision: 1 },
              branch: "main",
              parentCommit: "1".repeat(40),
              candidateCommit: "2".repeat(40),
              candidateTree: "3".repeat(40),
              baseGeneration: 0,
              outcome: "unknown",
              evidence: null,
              recordedAt: "2026-10-13T11:00:00.000Z",
            },
          ],
        });
        yield* store.replaceConnection({ expectedRevision: 1, next: unknown });
        const rejected = yield* Effect.flip(
          store.replaceConnection({
            expectedRevision: 2,
            next: revised(unknown, { attempts: [] }),
          }),
        );
        expect(rejected).toMatchObject({
          _tag: "OverleafTransitionRejectedError",
          violation: "unresolved-attempt-dropped",
        });
        expect(yield* store.readConnection("connection-1")).toEqual({
          _tag: "ready",
          document: unknown,
        });
      }),
    ),
  );

  it.live.each(["temporary-written", "temporary-synced", "before-publish", "published"] as const)(
    "keeps a whole document when a replacement stops at %s",
    (point) =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          let failAt: Point | null = null;
          const first = yield* openStore(root, {
            at: async (reached) => {
              if (reached !== failAt) return;
              // Disk full or a crash at this boundary; nothing later runs.
              throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
            },
          });
          const document = overleafConnectionFixture();
          yield* first.store.createConnection(document);
          failAt = point;
          const failed = yield* Effect.flip(
            first.store.replaceConnection({ expectedRevision: 1, next: revised(document) }),
          );
          expect(failed).toMatchObject({ _tag: "OverleafStateIoError", operation: "write" });
          // Before the rename the old document stands; after it, the new one does.
          const visible = yield* first.store.readConnection("connection-1");
          expect(visible).toEqual({
            _tag: "ready",
            document: point === "published" ? revised(document) : document,
          });
          yield* first.close;

          // The next server owns the directory: orphaned temporaries are removed
          // and writes continue from whatever document is on disk.
          const second = yield* openStore(root);
          const current = yield* second.store.readConnection("connection-1");
          if (current._tag !== "ready") throw new Error("expected a readable document");
          yield* second.store.replaceConnection({
            expectedRevision: current.document.revision,
            next: revised(current.document),
          });
          expect(yield* Effect.promise(() => listTemporaries(root))).toEqual([]);
        }),
      ),
  );

  it.live(
    "reports unreadable documents, refuses to write over them, and quarantines bytes intact",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const { store } = yield* openStore(root);
          const document = overleafConnectionFixture();
          yield* store.createConnection(document);
          const file = NodePath.join(connectionsDirectory(root), "connection-1.json");

          const refusedValid = yield* Effect.flip(store.quarantineConnection("connection-1"));
          expect(refusedValid).toMatchObject({ condition: "valid" });

          yield* Effect.promise(() => NodeFSP.writeFile(file, '{"schemaVersion":1,"revis'));
          expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "corrupt" });
          const refused = yield* Effect.flip(
            store.replaceConnection({ expectedRevision: 1, next: revised(document) }),
          );
          expect(refused).toMatchObject({
            _tag: "OverleafConnectionUnavailableError",
            condition: "corrupt",
          });
          // An unreadable document is never mistaken for a missing one and reset.
          expect((yield* Effect.flip(store.createConnection(document)))._tag).toBe(
            "OverleafConnectionExistsError",
          );

          yield* Effect.promise(() =>
            NodeFSP.writeFile(file, JSON.stringify({ ...document, schemaVersion: 2 })),
          );
          expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "unsupported" });
          const unsupportedBytes = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
          const name = yield* store.quarantineConnection("connection-1");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, "quarantine", name), "utf8"),
            ),
          ).toBe(unsupportedBytes);
          expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "missing" });

          // A valid document filed under another connection's name is not trusted.
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(connectionsDirectory(root), "connection-2.json"),
              JSON.stringify(document),
            ),
          );
          expect(yield* store.readConnection("connection-2")).toEqual({ _tag: "corrupt" });
        }),
      ),
  );

  it.live("returns the original receipt for a repeated request and refuses a reused ID", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        expect(yield* store.beginReceipt(receipt())).toEqual({ _tag: "created" });
        expect(yield* store.beginReceipt(receipt({ operationId: "operation-2" }))).toEqual({
          _tag: "existing",
          receipt: receipt(),
        });
        const reused = yield* Effect.flip(
          store.beginReceipt(receipt({ payloadDigest: "b".repeat(64) })),
        );
        expect(reused._tag).toBe("OverleafRequestReusedError");

        yield* store.finishReceipt({
          connectionId: "connection-1",
          requestId: "request-1",
          status: "unknown",
          resultCategory: "publication-unknown",
        });
        // Repeating the same terminal report is harmless; changing it is refused.
        yield* store.finishReceipt({
          connectionId: "connection-1",
          requestId: "request-1",
          status: "unknown",
          resultCategory: "publication-unknown",
        });
        const changed = yield* Effect.flip(
          store.finishReceipt({
            connectionId: "connection-1",
            requestId: "request-1",
            status: "completed",
            resultCategory: "accepted",
          }),
        );
        expect(changed._tag).toBe("OverleafRequestReusedError");
        const repeated = yield* store.beginReceipt(receipt());
        expect(repeated).toMatchObject({
          _tag: "existing",
          receipt: { status: "unknown", resultCategory: "publication-unknown" },
        });
      }),
    ),
  );

  it.live(
    "refuses writes while another process holds the lease and acquires it after that process dies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const { store } = yield* openStore(root);
          const other = leaseHolder(root);
          yield* Effect.addFinalizer(() => Effect.promise(other.kill));
          expect(yield* Effect.promise(() => other.status)).toBe("held");

          const refused = yield* Effect.flip(store.createConnection(overleafConnectionFixture()));
          expect(refused._tag).toBe("OverleafStateLockedError");
          expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "missing" });

          yield* Effect.promise(other.kill);
          // The same running store acquires the lease at its next write.
          yield* store.createConnection(overleafConnectionFixture());
          expect((yield* store.readConnection("connection-1"))._tag).toBe("ready");

          const late = leaseHolder(root);
          yield* Effect.addFinalizer(() => Effect.promise(late.kill));
          expect(yield* Effect.promise(() => late.status)).toBe("busy");
        }),
      ),
  );

  it.live("does not return a receipt filed under another request's name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        yield* store.beginReceipt(receipt());
        const directory = NodePath.join(root, "receipts", "connection-1");
        yield* Effect.promise(() =>
          NodeFSP.copyFile(
            NodePath.join(directory, "request-1.json"),
            NodePath.join(directory, "request-2.json"),
          ),
        );
        const misplaced = yield* Effect.flip(
          store.beginReceipt(receipt({ requestId: "request-2" })),
        );
        expect(misplaced).toMatchObject({ _tag: "OverleafStateIoError", operation: "read" });
      }),
    ),
  );

  it.live("keeps the lease for the store's lifetime and releases it when the store closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const first = yield* openStore(root);
        const second = yield* openStore(root);
        yield* first.store.createConnection(overleafConnectionFixture("connection-1"));
        const refused = yield* Effect.flip(
          second.store.createConnection(overleafConnectionFixture("connection-2")),
        );
        expect(refused._tag).toBe("OverleafStateLockedError");
        yield* first.close;
        yield* second.store.createConnection(overleafConnectionFixture("connection-2"));
        expect(yield* second.store.listConnections).toEqual(["connection-1", "connection-2"]);
      }),
    ),
  );

  it.live("refuses to write a document that claims an outcome without its evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        const invalid = {
          ...overleafConnectionFixture(),
          lastAttemptNumber: 1,
          attempts: [
            {
              attemptNumber: 1,
              operationId: "operation-1",
              requestId: "request-1",
              planDigest: "a".repeat(64),
              authority: { bindingId: "binding-1", authorityGeneration: 1, scopeRevision: 1 },
              branch: "main" as const,
              parentCommit: "1".repeat(40),
              candidateCommit: "2".repeat(40),
              candidateTree: "3".repeat(40),
              baseGeneration: 0,
              outcome: "accepted" as const,
              evidence: null,
              recordedAt: "2026-10-13T11:00:00.000Z",
            },
          ],
        };
        const refused = yield* Effect.flip(store.createConnection(invalid));
        expect(refused).toMatchObject({ _tag: "OverleafRecordInvalidError", record: "connection" });
        expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "missing" });
      }),
    ),
  );

  it.live("creates nothing, and keeps a running receipt, when publishing the file fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        let failing = false;
        const { store } = yield* openStore(root, {
          at: async (point) => {
            if (failing && point === "before-publish")
              throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
          },
        });
        failing = true;
        const failedCreate = yield* Effect.flip(
          store.createConnection(overleafConnectionFixture()),
        );
        expect(failedCreate._tag).toBe("OverleafStateIoError");
        expect(yield* store.readConnection("connection-1")).toEqual({ _tag: "missing" });
        const failedReceipt = yield* Effect.flip(store.beginReceipt(receipt()));
        expect(failedReceipt._tag).toBe("OverleafStateIoError");

        failing = false;
        yield* store.beginReceipt(receipt());
        failing = true;
        const failedFinish = yield* Effect.flip(
          store.finishReceipt({
            connectionId: "connection-1",
            requestId: "request-1",
            status: "completed",
            resultCategory: "accepted",
          }),
        );
        expect(failedFinish._tag).toBe("OverleafStateIoError");
        failing = false;
        expect(yield* store.beginReceipt(receipt())).toEqual({
          _tag: "existing",
          receipt: receipt(),
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(root, "receipts", "connection-1")),
          ),
        ).toEqual(["request-1.json"]);
      }),
    ),
  );

  it.live("finishes an interrupted write before another writer can start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        let pause: { reached: () => void; release: Promise<void> } | null = null;
        const { store } = yield* openStore(root, {
          at: async (point) => {
            if (point !== "before-publish" || pause === null) return;
            const current = pause;
            pause = null;
            current.reached();
            await current.release;
          },
        });
        const document = overleafConnectionFixture();
        yield* store.createConnection(document);

        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => {
          pause = { reached: resolve, release: released };
        });
        const first = revised(document, { updatedAt: "2026-10-13T11:00:01.000Z" });
        const writer = yield* Effect.forkChild(
          store.replaceConnection({ expectedRevision: 1, next: first }),
        );
        yield* Effect.promise(() => reached);
        // The caller gives up while its rename is still pending.
        const interruption = yield* Effect.forkChild(Fiber.interrupt(writer));
        const competitor = yield* Effect.forkChild(
          Effect.flip(
            store.replaceConnection({
              expectedRevision: 1,
              next: revised(document, { updatedAt: "2026-10-13T11:00:02.000Z" }),
            }),
          ),
        );
        // Give the interruption and the competitor time to act while the write is held.
        // If the write were abandoned, the competitor would publish within this window.
        yield* Effect.sleep("100 millis");
        release();
        yield* Fiber.join(interruption);
        // The competitor ran only after the first write landed, so it sees revision 2.
        expect(yield* Fiber.join(competitor)).toMatchObject({
          _tag: "OverleafConnectionStaleError",
          actualRevision: 2,
        });
        expect(yield* store.readConnection("connection-1")).toEqual({
          _tag: "ready",
          document: first,
        });
      }),
    ),
  );

  it.live("drops a lease whose file was replaced and defers to whoever holds the new one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot();
        const { store } = yield* openStore(root);
        yield* store.createConnection(overleafConnectionFixture("connection-1"));
        // Someone removes the lock file this store holds; another server locks a new one.
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "lease.sqlite")));
        const other = leaseHolder(root);
        yield* Effect.addFinalizer(() => Effect.promise(other.kill));
        expect(yield* Effect.promise(() => other.status)).toBe("held");
        const refused = yield* Effect.flip(
          store.createConnection(overleafConnectionFixture("connection-2")),
        );
        expect(refused._tag).toBe("OverleafStateLockedError");
        expect(yield* store.listConnections).toEqual(["connection-1"]);
        yield* Effect.promise(other.kill);
        yield* store.createConnection(overleafConnectionFixture("connection-2"));
        expect(yield* store.listConnections).toEqual(["connection-1", "connection-2"]);
      }),
    ),
  );

  describe("prepareRetention", () => {
    const prepare = (
      store: OverleafStateStore.OverleafStateStore["Service"],
      checkoutRoot: string,
      expected: { volume: string; fileId: string } | null = null,
    ) =>
      store.prepareRetention({
        environmentId: "environment-1",
        connectionId: "connection-1",
        checkoutRoot,
        exchangeHelper: helper ?? null,
        expected,
      });
    const refusal = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
      Effect.flip(effect).pipe(
        Effect.map((error) => ("reason" in error ? error.reason : error._tag)),
      );

    it.live("keeps copies in the state directory when it shares the checkout's volume", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const checkout = NodePath.join(root, "checkout");
          yield* Effect.promise(() => NodeFSP.mkdir(checkout));
          const { store } = yield* openStore(NodePath.join(root, "state"), undefined, fakeVolume);
          const prepared = yield* prepare(store, checkout);
          expect(prepared.directory).toBe(
            yield* Effect.promise(() =>
              NodeFSP.realpath(NodePath.join(root, "state", "retained", "connection-1")),
            ),
          );
          expect(prepared.identity.volume).toBe(VOLUME);
          const stat = yield* Effect.promise(() => NodeFSP.stat(prepared.directory));
          expect(stat.mode & 0o077).toBe(0);
          expect(yield* prepare(store, checkout, prepared.identity)).toEqual(prepared);
          // Capability probes leave nothing behind.
          expect(yield* Effect.promise(() => NodeFSP.readdir(prepared.directory))).toEqual([]);
        }),
      ),
    );

    it.live(
      "puts copies in a hidden folder beside the checkout otherwise, and never recreates it",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* temporaryRoot();
            const checkout = NodePath.join(root, "paper");
            yield* Effect.promise(() => NodeFSP.mkdir(checkout));
            // State inside the checkout could be erased by checkout cleanup, so it is not used.
            const { store } = yield* openStore(
              NodePath.join(checkout, ".state", "overleaf"),
              undefined,
              fakeVolume,
            );
            const prepared = yield* prepare(store, checkout);
            const expectedDirectory = yield* Effect.promise(async () =>
              NodePath.join(
                await NodeFSP.realpath(root),
                ".scient-overleaf",
                "environment-1",
                "connection-1",
              ),
            );
            expect(prepared.directory).toBe(expectedDirectory);

            // A recorded folder that disappeared is reported, and nothing is created in its place.
            yield* Effect.promise(() => NodeFSP.rm(expectedDirectory, { recursive: true }));
            expect(yield* refusal(prepare(store, checkout, prepared.identity))).toBe(
              "vault-missing",
            );
            expect(
              yield* Effect.promise(() =>
                NodeFSP.access(expectedDirectory).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false);
            // A different folder at the same place is not the recorded one.
            yield* Effect.promise(() => NodeFSP.mkdir(expectedDirectory, { mode: 0o700 }));
            expect(yield* refusal(prepare(store, checkout, prepared.identity))).toBe(
              "vault-replaced",
            );
          }),
        ),
    );

    it.live("refuses a disk without a volume identity, never using the device number", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const checkout = NodePath.join(root, "checkout");
          yield* Effect.promise(() => NodeFSP.mkdir(checkout));
          const { store } = yield* openStore(
            NodePath.join(root, "state"),
            undefined,
            async () => null,
          );
          expect(yield* refusal(prepare(store, checkout))).toBe("no-volume-identity");
        }),
      ),
    );

    it.live("refuses a read-only location beside the checkout", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const parent = NodePath.join(root, "parent");
          const checkout = NodePath.join(parent, "paper");
          yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
          const { store } = yield* openStore(
            NodePath.join(checkout, ".state", "overleaf"),
            undefined,
            fakeVolume,
          );
          // Create the state tree first, then make the parent read-only.
          yield* store.createConnection(overleafConnectionFixture());
          yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.chmod(parent, 0o500)),
            () => Effect.promise(() => NodeFSP.chmod(parent, 0o700)),
          );
          expect(yield* refusal(prepare(store, checkout))).toBe("read-only-parent");
        }),
      ),
    );

    it.live("refuses a symlinked retention folder", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot();
          const checkout = NodePath.join(root, "checkout");
          const elsewhere = NodePath.join(root, "elsewhere");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(checkout);
            await NodeFSP.mkdir(NodePath.join(root, "state"), { recursive: true });
            await NodeFSP.mkdir(elsewhere);
            await NodeFSP.symlink(elsewhere, NodePath.join(root, "state", "retained"));
          });
          const { store } = yield* openStore(NodePath.join(root, "state"), undefined, fakeVolume);
          expect(yield* refusal(prepare(store, checkout))).toBe("unsafe-directory");
        }),
      ),
    );

    // Real disks: APFS for remount and unplug, exFAT for the capability check.
    describe.skipIf(!diskImagesAvailable || helper === undefined)("on mounted disk images", () => {
      it.live(
        "finds the folder after the disk is mounted elsewhere and waits while it is unplugged",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const root = yield* temporaryRoot();
              const image = yield* diskImage(root, "APFS");
              const first = yield* image.attach("first");
              yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(first, "paper")));
              const { store } = yield* openStore(NodePath.join(root, "state"));
              const prepared = yield* prepare(store, NodePath.join(first, "paper"));
              expect(prepared.directory).toBe(
                NodePath.join(first, ".scient-overleaf", "environment-1", "connection-1"),
              );
              yield* image.detach;
              expect(
                yield* refusal(prepare(store, NodePath.join(first, "paper"), prepared.identity)),
              ).toBe("volume-unavailable");

              const second = yield* image.attach("second");
              const again = yield* prepare(
                store,
                NodePath.join(second, "paper"),
                prepared.identity,
              );
              expect(again.identity).toEqual(prepared.identity);
              expect(again.directory).toBe(
                NodePath.join(second, ".scient-overleaf", "environment-1", "connection-1"),
              );
              // The root of a disk has no place beside it on the same disk.
              expect(yield* refusal(prepare(store, second))).toBe("disk-root-checkout");
            }),
          ),
      );

      it.live("refuses exFAT, which can neither exchange nor link files", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* temporaryRoot();
            const image = yield* diskImage(root, "ExFAT");
            const mounted = yield* image.attach("exfat");
            const checkout = NodePath.join(mounted, "paper");
            yield* Effect.promise(() => NodeFSP.mkdir(checkout));
            const { store } = yield* openStore(NodePath.join(root, "state"));
            expect(yield* refusal(prepare(store, checkout))).toBe("unsupported-filesystem");
            // The declared development fallback needs hard links, which exFAT lacks too.
            expect(
              yield* refusal(
                store.prepareRetention({
                  environmentId: "environment-1",
                  connectionId: "connection-1",
                  checkoutRoot: checkout,
                  exchangeHelper: null,
                  expected: null,
                }),
              ),
            ).toBe("unsupported-filesystem");
          }),
        ),
      );
    });
  });
});
