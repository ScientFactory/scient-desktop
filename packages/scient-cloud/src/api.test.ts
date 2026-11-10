import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

import {
  CreateShareRequest,
  decodeThreadMetaHeader,
  encodeThreadMetaHeader,
  THREAD_META_HEADER_MAX_BYTES,
  type ThreadMeta,
} from "./api.ts";

const meta: ThreadMeta = {
  title: "Ünïcode — fit residuals",
  projectKey: "github.com/example/analysis",
  projectLabel: "analysis",
  relativePath: "notebooks",
  updatedAt: "2026-11-10T22:00:00.000Z",
  archived: false,
  contentDigest: `sha256:${"a".repeat(64)}`,
  generation: 2,
  continuedFrom: { env: EnvironmentId.make("env-a"), thread: ThreadId.make("thread-1") },
};

describe("thread meta header", () => {
  it.effect("round-trips as a header-safe value", () =>
    Effect.gen(function* () {
      const header = encodeThreadMetaHeader(meta);
      expect(header).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(yield* decodeThreadMetaHeader(header)).toEqual(meta);
    }),
  );

  it.effect("rejects malformed, invalid and oversized values", () =>
    Effect.gen(function* () {
      const reason = (value: string) =>
        Effect.flip(decodeThreadMetaHeader(value)).pipe(Effect.map((error) => error.reason));
      expect(yield* reason("not base64url!")).toBe("malformed");
      expect(yield* reason(Base64Url.encode(JSON.stringify({ ...meta, generation: -1 })))).toBe(
        "malformed",
      );
      expect(yield* reason("A".repeat(THREAD_META_HEADER_MAX_BYTES + 1))).toBe("too_large");
    }),
  );
});

describe("share requests", () => {
  it("refuses a preview card on an encrypted share", () => {
    const request = {
      source: { env: "env-a", thread: "thread-a" },
      encrypted: true,
      access: { mode: "link" },
      indexable: false,
    };
    const decode = Schema.decodeUnknownExit(CreateShareRequest);
    expect(decode(request)._tag).toBe("Success");
    expect(decode({ ...request, card: { title: "Private findings" } })._tag).toBe("Failure");
    expect(decode({ ...request, encrypted: false, card: { title: "Findings" } })._tag).toBe(
      "Success",
    );
  });
});
