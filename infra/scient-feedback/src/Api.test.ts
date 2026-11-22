import { FEEDBACK_CLIENT_ID_HEADER, type FeedbackReport } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { handle } from "./Api.ts";
import * as Local from "./Local.ts";
import type { StoredFile } from "./Services.ts";

const CLIENT = "c".repeat(43);
const TOKEN = "t".repeat(43);
const OTHER_CLIENT = "d".repeat(43);
const ADMIN = "admin-secret";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const report = (overrides: Partial<FeedbackReport> = {}): FeedbackReport => ({
  schemaVersion: 1,
  id: "0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
  createdAt: "2026-11-17T11:59:00.000Z",
  message: "The PDF panel goes blank when I switch projects.",
  source: "sidebar",
  screen: "chat",
  app: {
    version: "0.6.29",
    channel: "stable",
    platform: "darwin",
    osVersion: "25.6.0",
    arch: "arm64",
    locale: "en-US",
    rendererCrashes24h: 0,
    recentFailures: [],
  },
  attachments: [],
  ...overrides,
});

const submit = (
  body: FeedbackReport,
  options: {
    readonly client?: string;
    readonly token?: string;
    readonly parts?: Record<string, Uint8Array | string>;
  } = {},
) => {
  const form = new FormData();
  form.set("report", JSON.stringify(body));
  for (const [name, part] of Object.entries(options.parts ?? {})) {
    form.set(name, typeof part === "string" ? part : new Blob([part as Uint8Array<ArrayBuffer>]));
  }
  return Effect.promise(async () => {
    const encoded = new Request("http://x", { method: "POST", body: form });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return new Request("https://feedback.test/v1/reports", {
      method: "POST",
      body: bytes,
      headers: {
        "content-type": encoded.headers.get("content-type") ?? "",
        "content-length": String(bytes.length),
        authorization: `Bearer ${options.token ?? TOKEN}`,
        [FEEDBACK_CLIENT_ID_HEADER]: options.client ?? CLIENT,
      },
    });
  }).pipe(Effect.flatMap(handle));
};

const get = (path: string, headers: Record<string, string>) =>
  handle(new Request(`https://feedback.test${path}`, { headers }));

const asClient = (client = CLIENT, token = TOKEN) => ({
  authorization: `Bearer ${token}`,
  [FEEDBACK_CLIENT_ID_HEADER]: client,
});

const body = (response: Response) => Effect.promise(() => response.json() as Promise<any>);

const service = (files = new Map<string, StoredFile>()) =>
  Local.layer({ files: Local.memoryFiles(files), settings: { adminToken: ADMIN } });

describe("feedback Worker", () => {
  it.effect("stores a report once, however often the app retries it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const files = new Map<string, StoredFile>();
      const first = yield* submit(
        report({ attachments: [{ kind: "screenshot", bytes: JPEG.length }] }),
        { parts: { screenshot: JPEG } },
      ).pipe(Effect.provide(service(files)));
      expect(first.status).toBe(201);
      expect(files.get("reports/0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f/screenshot")?.bytes).toEqual(
        JPEG,
      );
    }),
  );

  it.effect("answers a repeat with the first receipt and refuses another installation's id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const first = yield* submit(report());
      const firstReceipt = yield* body(first);
      yield* TestClock.adjust("10 seconds");
      const repeat = yield* submit(report());
      expect(repeat.status).toBe(200);
      expect(yield* body(repeat)).toEqual(firstReceipt);
      const stolen = yield* submit(report(), { client: OTHER_CLIENT });
      expect(stolen.status).toBe(409);
    }).pipe(Effect.provide(service())),
  );

  it.effect("binds a client id to the first token it sends", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      expect((yield* submit(report())).status).toBe(201);
      const forged = yield* submit(report({ id: "1f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f" }), {
        token: "x".repeat(43),
      });
      expect(forged.status).toBe(401);
    }).pipe(Effect.provide(service())),
  );

  it.effect("refuses an image that is not a JPEG and an attachment it was not told about", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const fake = yield* submit(
        report({ attachments: [{ kind: "screenshot", bytes: png.length }] }),
        { parts: { screenshot: png } },
      );
      expect(fake.status).toBe(400);
      const extra = yield* submit(report(), { parts: { logs: "secret" } });
      expect(extra.status).toBe(400);
      const wrongSize = yield* submit(report({ attachments: [{ kind: "logs", bytes: 3 }] }), {
        parts: { logs: "four" },
      });
      expect(wrongSize.status).toBe(400);
    }).pipe(Effect.provide(service())),
  );

  it.effect("refuses a request without a declared length or over the size limit", () =>
    Effect.gen(function* () {
      const chunked = yield* handle(
        new Request("https://feedback.test/v1/reports", {
          method: "POST",
          headers: asClient(),
          body: "x",
        }),
      );
      expect(chunked.status).toBe(411);
      const huge = yield* handle(
        new Request("https://feedback.test/v1/reports", {
          method: "POST",
          headers: { ...asClient(), "content-length": String(5 * 1024 * 1024) },
          body: "x",
        }),
      );
      expect(huge.status).toBe(413);
    }).pipe(Effect.provide(service())),
  );

  it.effect("limits how often one installation can send", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const statuses: Array<number> = [];
      for (let index = 0; index < 4; index += 1) {
        const id = `${index}f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f`;
        statuses.push((yield* submit(report({ id }))).status);
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
    }).pipe(Effect.provide(service())),
  );

  it.effect("keeps reports queued in apps while ingestion is off", () =>
    Effect.gen(function* () {
      const paused = yield* submit(report()).pipe(
        Effect.provide(Local.layer({ settings: { ingestionEnabled: false } })),
      );
      expect(paused.status).toBe(503);
      expect(paused.headers.get("retry-after")).not.toBeNull();
    }),
  );

  it.effect("tells an app about its own reports only, after the team marks one fixed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* submit(report());
      const patch = yield* handle(
        new Request("https://feedback.test/v1/admin/reports/0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f", {
          method: "PATCH",
          headers: { authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify({ status: "fixed", fixedIn: "0.6.31", note: "Thanks!" }),
        }),
      );
      expect(patch.status).toBe(200);
      const ids = "?ids=0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f";
      const own = yield* body(yield* get(`/v1/reports/status${ids}`, asClient()));
      expect(own.reports).toEqual([
        {
          id: "0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
          status: "fixed",
          fixedIn: "0.6.31",
          note: "Thanks!",
        },
      ]);
      const someoneElse = yield* body(
        yield* get(`/v1/reports/status${ids}`, asClient(OTHER_CLIENT)),
      );
      expect(someoneElse.reports).toEqual([]);
    }).pipe(Effect.provide(service())),
  );

  it.effect("hides the admin routes without the secret and refuses a wrong token", () =>
    Effect.gen(function* () {
      const disabled = yield* get("/v1/admin/reports", { authorization: "Bearer anything" }).pipe(
        Effect.provide(Local.layer()),
      );
      expect(disabled.status).toBe(404);
      const wrong = yield* get("/v1/admin/reports", { authorization: "Bearer guess" }).pipe(
        Effect.provide(service()),
      );
      expect(wrong.status).toBe(401);
    }),
  );

  it.effect("serves attachments to the team as downloads, never as pages", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* submit(report({ attachments: [{ kind: "logs", bytes: 5 }] }), {
        parts: { logs: "<svg>" },
      });
      const file = yield* get("/v1/admin/reports/0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f/files/logs", {
        authorization: `Bearer ${ADMIN}`,
      });
      expect(file.headers.get("content-disposition")).toBe("attachment");
      expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    }).pipe(Effect.provide(service())),
  );
});
