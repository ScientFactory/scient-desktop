import * as NodeZlib from "node:zlib";

import {
  LEASE_GENERATION_HEADER,
  THREAD_META_HEADER,
  cloudPaths,
  encodeThreadMetaHeader,
  type ThreadMeta,
} from "@scientfactory/scient-cloud/api";
import { computerJwsCryptoLayer } from "@scientfactory/scient-cloud/computer-jws";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Local from "./Local.ts";
import { memoryObjects, type Objects } from "./Objects.ts";
import { Shares, Users } from "./Services.ts";
import {
  call,
  enroll,
  newComputer,
  readBytes,
  readJson,
  signedHeaders,
  type Computer,
} from "./testing.ts";

const NOW = 1_800_000_000_000;
const MiB = 1024 * 1024;

const people = new Map<string, Local.LocalPerson>([
  ["ada-token", { userId: "user_ada", emails: ["ada@example.test"] }],
  ["bob-token", { userId: "user_bob", emails: ["Bob@Example.test"] }],
  ["eve-token", { userId: "user_eve", emails: ["eve@example.test"] }],
]);

const cloud = (
  options: {
    readonly freeBytes?: number;
    readonly objects?: Map<string, Uint8Array> | Objects["Service"];
  } = {},
) =>
  Layer.mergeAll(
    Local.layer({
      people,
      settings: {
        appOrigins: ["https://app.scientfactory.com"],
        allowLocalhostOrigins: false,
        limits: {
          freeBytes: options.freeBytes ?? 64 * MiB,
          maxSnapshotBytes: 8 * MiB,
          maxBlobBytes: 4 * MiB,
          maxThreads: 100,
        },
      },
      ...(options.objects ? { objects: options.objects } : {}),
    }),
    computerJwsCryptoLayer,
  );

const gzip = (text: string) => new Uint8Array(NodeZlib.gzipSync(text));

const meta = (overrides: Partial<ThreadMeta> = {}): ThreadMeta =>
  ({
    title: "Protein folding notes",
    projectKey: "github.com/lab/folding",
    projectLabel: "folding",
    updatedAt: "2027-01-15T08:00:00.000Z",
    archived: false,
    contentDigest: `sha256:${"a".repeat(64)}`,
    generation: 0,
    ...overrides,
  }) as ThreadMeta;

const putThread = (
  computer: Computer,
  thread: string,
  body: Uint8Array,
  threadMeta: ThreadMeta = meta(),
) =>
  call("PUT", cloudPaths.thread(computer.environmentId, thread), {
    computer,
    body,
    headers: { [THREAD_META_HEADER]: encodeThreadMetaHeader(threadMeta) },
  });

const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(async () =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const computer = yield* newComputer("env-a", "user_ada");
  expect((yield* enroll("ada-token", computer)).status).toBe(200);
  return computer;
});

describe("auth and enrollment", () => {
  it.effect("refuses missing, unknown and unenrolled credentials", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      expect((yield* call("GET", cloudPaths.threads())).status).toBe(401);
      expect((yield* call("GET", cloudPaths.threads(), { person: "nobody" })).status).toBe(401);
      const stranger = yield* newComputer("env-x", "user_ada");
      const response = yield* putThread(stranger, "t1", gzip("{}"));
      expect(response.status).toBe(401);
      expect((yield* readJson(response)).error).toBe("unauthorized");
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("enrolls once per nonce and only for the signed-in person", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const listed = yield* readJson(
        yield* call("GET", cloudPaths.computers(), { person: "ada-token" }),
      );
      expect(listed.computers).toMatchObject([{ environmentId: "env-a", lastSeenAt: null }]);

      // A proof made for Ada does not enroll on Bob's account.
      const forBob = yield* enroll("bob-token", computer);
      expect(forBob.status).toBe(401);
      const bobs = yield* readJson(
        yield* call("GET", cloudPaths.computers(), { person: "bob-token" }),
      );
      expect(bobs.computers).toEqual([]);
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("rejects a replayed computer request and a token bound to another path", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const path = cloudPaths.computerMoved(computer.environmentId);
      const headers = yield* signedHeaders(computer, "GET", path, new Uint8Array(0));
      const first = yield* call("GET", path, { headers });
      expect(first.status).toBe(200);
      const replay = yield* call("GET", path, { headers });
      expect(replay.status).toBe(401);
      expect((yield* readJson(replay)).error).toBe("replayed");

      const moved = yield* call("GET", path, { computer, signedTarget: cloudPaths.threads() });
      expect((yield* readJson(moved)).message).toContain("target_mismatch");
    }).pipe(Effect.provide(cloud())),
  );
});

describe("sync", () => {
  it.effect("stores encrypted, skips unchanged digests and serves the gzip back", () => {
    const objects = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      const computer = yield* setup;
      const body = gzip(JSON.stringify({ snapshot: { title: "secret result 42" } }));
      const stored = yield* putThread(computer, "t1", body);
      expect(yield* readJson(stored)).toEqual({ status: "stored" });
      expect((yield* readJson(yield* putThread(computer, "t1", body))).status).toBe("unchanged");

      const [key, ciphertext] = [...objects][0]!;
      expect(key).toMatch(/^u\/user_ada\/t\/env-a\/t1\//u);
      expect(Buffer.from(ciphertext).includes(Buffer.from(body.subarray(10, 30)))).toBe(false);

      const read = yield* call("GET", cloudPaths.thread("env-a", "t1"), { person: "ada-token" });
      expect(read.headers.get("content-encoding")).toBe("gzip");
      expect(yield* readBytes(read)).toEqual(body);
      // Another person cannot read it.
      const other = yield* call("GET", cloudPaths.thread("env-a", "t1"), { person: "bob-token" });
      expect(other.status).toBe(404);

      const index = yield* readJson(
        yield* call("GET", cloudPaths.threads(), { person: "ada-token" }),
      );
      expect(index.threads).toMatchObject([
        { environmentId: "env-a", threadId: "t1", ownerEnvironmentId: "env-a", movedTo: null },
      ]);
    }).pipe(Effect.provide(cloud({ objects })));
  });

  it.effect("reserves quota per user and refuses oversize copies", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const big = gzip("x".repeat(10));
      const padded = new Uint8Array(600 * 1024);
      padded.set(big);
      expect((yield* putThread(computer, "t1", padded)).status).toBe(200);
      const full = yield* putThread(computer, "t2", padded);
      expect(full.status).toBe(413);
      expect((yield* readJson(full)).error).toBe("quota_exceeded");
      // Replacing the same thread's copy only counts the difference.
      const replaced = yield* putThread(
        computer,
        "t1",
        padded,
        meta({ contentDigest: `sha256:${"b".repeat(64)}` }),
      );
      expect(replaced.status).toBe(200);
      const limits = yield* readJson(
        yield* call("GET", cloudPaths.limits(), { person: "ada-token" }),
      );
      expect(limits.freeBytes).toBe(1 * MiB);
      expect(Number(limits.usedBytes)).toBeGreaterThanOrEqual(600 * 1024);
    }).pipe(Effect.provide(cloud({ freeBytes: 1 * MiB }))),
  );

  it.effect("refuses uploads after another computer continues the thread", () =>
    Effect.gen(function* () {
      const computerA = yield* setup;
      const computerB = yield* newComputer("env-b", "user_ada");
      expect((yield* enroll("ada-token", computerB)).status).toBe(200);
      const body = gzip("{}");
      yield* putThread(computerA, "t1", body);

      const leased = yield* call("POST", cloudPaths.threadLease("env-a", "t1"), {
        person: "ada-token",
        body: { to: "env-b" },
      });
      expect(leased.status).toBe(200);
      expect(leased.headers.get(LEASE_GENERATION_HEADER)).toBe("1");
      expect(yield* readBytes(leased)).toEqual(body);
      // The new computer downloads the copy with its own signature.
      const imported = yield* call("GET", cloudPaths.thread("env-a", "t1"), {
        computer: computerB,
      });
      expect(yield* readBytes(imported)).toEqual(body);

      const lost = yield* putThread(
        computerA,
        "t1",
        gzip('{"more":1}'),
        meta({ contentDigest: `sha256:${"c".repeat(64)}` }),
      );
      expect(lost.status).toBe(409);
      expect(yield* readJson(lost)).toMatchObject({ error: "lease_lost", movedTo: "env-b" });

      const moved = yield* readJson(
        yield* call("GET", cloudPaths.computerMoved("env-a"), { computer: computerA }),
      );
      expect(moved.threads).toMatchObject([{ threadId: "t1", movedTo: "env-b", generation: 1 }]);
      const index = yield* readJson(
        yield* call("GET", cloudPaths.threads(), { person: "ada-token" }),
      );
      expect(index.threads).toMatchObject([{ ownerEnvironmentId: "env-b", movedTo: "env-b" }]);

      // A lease to a computer that is not the user's is refused.
      const foreign = yield* call("POST", cloudPaths.threadLease("env-a", "t1"), {
        person: "ada-token",
        body: { to: "env-zzz" },
      });
      expect(foreign.status).toBe(403);
      // Only the thread's own computer may upload it.
      expect(
        (yield* putThread({ ...computerB, environmentId: computerA.environmentId }, "t1", body))
          .status,
      ).toBe(401);
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("serves blobs only once a stored thread refers to them", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const bytes = new TextEncoder().encode("figure bytes");
      const sha = yield* sha256Hex(bytes);
      const blobPath = cloudPaths.blob(sha, {
        env: computer.environmentId,
        thread: ThreadId.make("t1"),
      });
      expect((yield* call("HEAD", blobPath, { computer })).status).toBe(404);
      const wrongHash = yield* call(
        "PUT",
        `${cloudPaths.blob("0".repeat(64))}?env=env-a&thread=t1`,
        { computer, body: bytes },
      );
      expect(wrongHash.status).toBe(400);
      expect(
        (yield* call("PUT", `${cloudPaths.blob(sha)}`, { computer, body: bytes })).status,
      ).toBe(400);
      expect((yield* call("PUT", blobPath, { computer, body: bytes })).status).toBe(200);
      expect((yield* call("HEAD", blobPath, { computer })).status).toBe(200);

      // Uploaded but no stored thread refers to it yet.
      expect((yield* call("GET", cloudPaths.blob(sha), { person: "ada-token" })).status).toBe(404);
      yield* putThread(computer, "t1", gzip("{}"));
      const read = yield* call("GET", cloudPaths.blob(sha), { person: "ada-token" });
      expect(read.status).toBe(200);
      expect(read.headers.get("x-content-type-options")).toBe("nosniff");
      expect(yield* readBytes(read)).toEqual(bytes);
      expect((yield* call("GET", cloudPaths.blob(sha), { person: "bob-token" })).status).toBe(404);

      // Deleting the thread drops the file with it.
      expect((yield* call("DELETE", cloudPaths.thread("env-a", "t1"), { computer })).status).toBe(
        204,
      );
      expect((yield* call("HEAD", blobPath, { computer })).status).toBe(404);
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("keeps copies when a computer stops syncing; deleting them is separate", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const bytes = new TextEncoder().encode("figure bytes");
      const sha = yield* sha256Hex(bytes);
      const usedBy = { env: computer.environmentId, thread: ThreadId.make("t1") };
      yield* call("PUT", cloudPaths.blob(sha, usedBy), { computer, body: bytes });
      const body = gzip("{}");
      yield* putThread(computer, "t1", body);

      expect(
        (yield* call("DELETE", cloudPaths.computer("env-a"), { person: "ada-token" })).status,
      ).toBe(204);
      // The computer is unlinked...
      expect((yield* putThread(computer, "t2", body)).status).toBe(401);
      // ...and its copies are still there to read.
      const read = yield* call("GET", cloudPaths.thread("env-a", "t1"), { person: "ada-token" });
      expect(yield* readBytes(read)).toEqual(body);
      expect((yield* call("GET", cloudPaths.blob(sha), { person: "ada-token" })).status).toBe(200);

      expect(
        (yield* call("DELETE", cloudPaths.computerThreads("env-a"), { person: "ada-token" }))
          .status,
      ).toBe(204);
      expect(
        (yield* call("GET", cloudPaths.thread("env-a", "t1"), { person: "ada-token" })).status,
      ).toBe(404);
      expect((yield* call("GET", cloudPaths.blob(sha), { person: "ada-token" })).status).toBe(404);
    }).pipe(Effect.provide(cloud())),
  );

  /** Object storage whose writes wait until the test opens the gate. */
  const gatedObjects = () => {
    const store = new Map<string, Uint8Array>();
    const base = memoryObjects(store);
    let started = () => {};
    let open = () => {};
    const putStarted = new Promise<void>((done) => (started = done));
    const gate = new Promise<void>((done) => (open = done));
    const objects: Objects["Service"] = {
      ...base,
      put: (key, body, length) =>
        Effect.promise(() => {
          started();
          return gate;
        }).pipe(Effect.andThen(base.put(key, body, length))),
    };
    return { store, objects, putStarted, open };
  };

  it.effect.each([
    { name: "the computer was removed", path: cloudPaths.computer("env-a"), status: 401 },
    { name: "its first copy was deleted", path: cloudPaths.thread("env-a", "t1"), status: 404 },
  ])("does not let an upload begun before $name land after it", (removal) => {
    const gated = gatedObjects();
    return Effect.gen(function* () {
      const computer = yield* setup;
      const upload = yield* Effect.forkChild(putThread(computer, "t1", gzip("{}")));
      yield* Effect.promise(() => gated.putStarted);
      expect((yield* call("DELETE", removal.path, { person: "ada-token" })).status).toBe(204);
      gated.open();
      expect((yield* Fiber.join(upload)).status).toBe(removal.status);
      const index = yield* readJson(
        yield* call("GET", cloudPaths.threads(), { person: "ada-token" }),
      );
      expect(index.threads).toEqual([]);
      expect(gated.store.size).toBe(0);
    }).pipe(Effect.provide(cloud({ objects: gated.objects })));
  });

  it.effect("refuses bodies past their limits before holding them", () =>
    Effect.gen(function* () {
      const computer = yield* setup;
      const body = gzip("{}");
      const upload = (length: number) =>
        call("PUT", cloudPaths.thread("env-a", "t1"), {
          computer,
          body,
          headers: {
            [THREAD_META_HEADER]: encodeThreadMetaHeader(meta()),
            "content-length": String(length),
          },
        });
      const declaredTooLarge = yield* upload(9 * MiB);
      expect(declaredTooLarge.status).toBe(413);
      expect((yield* readJson(declaredTooLarge)).error).toBe("too_large");
      // More bytes than declared are never written past the buffer.
      expect((yield* upload(body.length - 1)).status).toBe(400);

      const report = yield* call("POST", cloudPaths.publicShareReport("A".repeat(22)), {
        body: { reason: "x".repeat(10 * 1024) },
      });
      expect(report.status).toBe(413);
    }).pipe(Effect.provide(cloud())),
  );
});

const publishShare = (access: object, extra: object = {}) =>
  Effect.gen(function* () {
    const created = yield* readJson(
      yield* call("POST", cloudPaths.shares(), {
        person: "ada-token",
        body: {
          source: { env: "env-a", thread: "t1" },
          encrypted: true,
          access,
          indexable: false,
          ...extra,
        },
      }),
    );
    const id = created.id as string;
    const put = yield* call("PUT", cloudPaths.shareObject(id, 1, "snapshot"), {
      person: "ada-token",
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(put.status).toBe(204);
    const published = yield* call("POST", cloudPaths.sharePublish(id, 1), { person: "ada-token" });
    expect(published.status).toBe(200);
    return id;
  });

describe("shares", () => {
  it.effect(
    "keeps usage equal to a link's stored bytes when replacements report out of order",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const created = yield* readJson(
          yield* call("POST", cloudPaths.shares(), {
            person: "ada-token",
            body: {
              source: { env: "env-a", thread: "t1" },
              encrypted: true,
              access: { mode: "link" },
              indexable: false,
            },
          }),
        );
        const id = created.id as string;
        const share = (yield* Shares).get(id);
        const user = (yield* Users).get("user_ada");
        const write = (bytes: number) =>
          Effect.gen(function* () {
            const input = { owner: "user_ada", version: 1, name: "snapshot", now: NOW };
            const begun = yield* share.beginPut(input);
            return yield* share.commitPut({ ...input, objectKey: begun.objectKey, bytes });
          });
        const report = (written: { readonly totalBytes: number; readonly revision: number }) =>
          user.commitShareWrite({ id, reservation: "-", ...written });

        yield* report(yield* write(100));
        const larger = yield* write(200);
        const smaller = yield* write(50);
        yield* report(smaller);
        yield* report(larger);
        const limits = yield* readJson(
          yield* call("GET", cloudPaths.limits(), { person: "ada-token" }),
        );
        expect(limits.usedBytes).toBe(50);
      }).pipe(Effect.provide(cloud())),
  );

  it.effect("applies link, people and me access", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const link = yield* publishShare({ mode: "link" });
      const info = yield* readJson(yield* call("GET", cloudPaths.publicShare(link)));
      expect(info).toMatchObject({
        encrypted: true,
        currentVersion: 1,
        objects: [{ name: "snapshot", bytes: 4 }],
      });
      const object = yield* call("GET", cloudPaths.publicShareObject(link, 1, "snapshot"));
      expect(yield* readBytes(object)).toEqual(new Uint8Array([1, 2, 3, 4]));

      const invited = yield* publishShare({ mode: "people", emails: ["bob@example.test"] });
      expect((yield* call("GET", cloudPaths.publicShare(invited))).status).toBe(401);
      expect(
        (yield* call("GET", cloudPaths.publicShare(invited), { person: "eve-token" })).status,
      ).toBe(403);
      expect(
        (yield* call("GET", cloudPaths.publicShare(invited), { person: "bob-token" })).status,
      ).toBe(200);
      expect(
        (yield* call("GET", cloudPaths.publicShare(invited), { person: "ada-token" })).status,
      ).toBe(200);

      const mine = yield* publishShare({ mode: "me" });
      expect(
        (yield* call("GET", cloudPaths.publicShareObject(mine, 1, "snapshot"), {
          person: "bob-token",
        })).status,
      ).toBe(403);
      expect(
        (yield* call("GET", cloudPaths.publicShareObject(mine, 1, "snapshot"), {
          person: "ada-token",
        })).status,
      ).toBe(200);

      // Only the owner manages a link.
      expect((yield* call("DELETE", cloudPaths.share(link), { person: "bob-token" })).status).toBe(
        404,
      );
      const listed = yield* readJson(
        yield* call("GET", cloudPaths.shares(), { person: "ada-token" }),
      );
      expect((listed.shares as Array<unknown>).length).toBe(3);
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("freezes published versions and deletes every object on revoke", () => {
    const objects = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const id = yield* publishShare({ mode: "link" });
      const frozen = yield* call("PUT", cloudPaths.shareObject(id, 1, "snapshot"), {
        person: "ada-token",
        body: new Uint8Array([9]),
      });
      expect(frozen.status).toBe(400);
      expect(
        (yield* call("PUT", cloudPaths.shareObject(id, 2, "snapshot"), {
          person: "ada-token",
          body: new Uint8Array([5, 6]),
        })).status,
      ).toBe(204);
      yield* call("POST", cloudPaths.sharePublish(id, 2), { person: "ada-token" });
      const info = yield* readJson(yield* call("GET", cloudPaths.publicShare(id)));
      expect(info.currentVersion).toBe(2);
      expect((info.versions as Array<unknown>).length).toBe(2);
      expect(objects.size).toBe(2);

      expect((yield* call("DELETE", cloudPaths.share(id), { person: "ada-token" })).status).toBe(
        204,
      );
      expect(objects.size).toBe(0);
      expect((yield* call("GET", cloudPaths.publicShare(id))).status).toBe(404);
      expect((yield* call("GET", cloudPaths.publicShareObject(id, 1, "snapshot"))).status).toBe(
        404,
      );
      const limits = yield* readJson(
        yield* call("GET", cloudPaths.limits(), { person: "ada-token" }),
      );
      expect(limits.usedBytes).toBe(0);
    }).pipe(Effect.provide(cloud({ objects })));
  });

  it.effect("ends an expired link and removes its objects when the alarm runs", () => {
    const objects = new Map<string, Uint8Array>();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const id = yield* publishShare(
        { mode: "link" },
        { expiresAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + 60_000)) },
      );
      expect((yield* call("GET", cloudPaths.publicShare(id))).status).toBe(200);
      yield* TestClock.setTime(NOW + 61_000);
      // Unreadable as soon as it expires, before the alarm deletes anything.
      expect((yield* call("GET", cloudPaths.publicShare(id))).status).toBe(404);
      expect(objects.size).toBe(1);
      const alarms = yield* Local.LocalAlarms;
      yield* alarms.runDue(NOW + 61_000);
      expect(objects.size).toBe(0);
      const listed = yield* readJson(
        yield* call("GET", cloudPaths.shares(), { person: "ada-token" }),
      );
      expect(listed.shares).toEqual([]);
    }).pipe(Effect.provide(cloud({ objects })));
  });

  it.effect("serves the page shell without indexing and a card only for public plain links", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const carded = yield* call("POST", cloudPaths.shares(), {
        person: "ada-token",
        body: {
          source: { env: "env-a", thread: "t1" },
          encrypted: true,
          access: { mode: "link" },
          indexable: false,
          card: { title: "Hidden" },
        },
      });
      expect(carded.status).toBe(400);
      const encrypted = yield* publishShare({ mode: "link" });
      const page = yield* call("GET", cloudPaths.sharePage(encrypted));
      expect(page.status).toBe(200);
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("x-robots-tag")).toContain("noindex");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = yield* Effect.promise(() => page.text());
      expect(html).toContain('name="robots" content="noindex');
      expect(html).not.toContain("Hidden");

      const plain = yield* publishShare(
        { mode: "link" },
        { encrypted: false, indexable: true, card: { title: "Folding <results>" } },
      );
      const plainPage = yield* call("GET", cloudPaths.sharePage(plain));
      const text = yield* Effect.promise(() => plainPage.text());
      expect(plainPage.headers.get("x-robots-tag")).toBeNull();
      expect(text).toContain('property="og:title" content="Folding &lt;results&gt;"');
      expect((yield* call("GET", cloudPaths.sharePage("A".repeat(22)))).status).toBe(404);
    }).pipe(Effect.provide(cloud())),
  );
});

describe("browser access", () => {
  it.effect("serves the content frame sandboxed and frameable only by Scient pages", () =>
    Effect.gen(function* () {
      const frame = yield* call("GET", "/frame");
      const policy = frame.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("sandbox allow-scripts");
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain(
        "frame-ancestors http://localhost:8787 https://app.scientfactory.com",
      );
      expect(yield* Effect.promise(() => frame.text())).toContain("scient-content-frame:ready");
    }).pipe(Effect.provide(cloud())),
  );

  it.effect("allows Scient origins and nothing else", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const allowed = yield* call("OPTIONS", cloudPaths.threads(), {
        headers: { origin: "https://app.scientfactory.com" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "https://app.scientfactory.com",
      );
      const blocked = yield* call("OPTIONS", cloudPaths.threads(), {
        headers: { origin: "https://evil.test" },
      });
      expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
      const local = yield* call("GET", cloudPaths.limits(), {
        headers: { origin: "http://localhost:5173" },
      });
      expect(local.headers.get("access-control-allow-origin")).toBeNull();
    }).pipe(Effect.provide(cloud())),
  );
});
