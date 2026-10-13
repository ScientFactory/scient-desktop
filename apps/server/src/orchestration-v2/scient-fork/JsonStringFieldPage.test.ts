import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { JSON_FIELD_READ_BYTES, readJsonStringFieldPage } from "./JsonStringFieldPage.ts";

it.effect("reads UTF-16 pages across every JSON escape and UTF-8 chunk boundary", () =>
  Effect.gen(function* () {
    const text = 'before\n\t\b\f\r\\"/🧪界\u0000\ud800\udc01after';
    const source = new TextEncoder().encode(
      JSON.stringify({ unrelated: { summary: "Wrong field" }, summary: text }),
    );
    for (const chunkSize of [1, 2, 7, 13, source.length]) {
      for (let offset = 0; offset <= text.length + 1; offset++) {
        const actual = yield* readJsonStringFieldPage({
          field: "summary",
          offset,
          maxChars: 5,
          read: (at, count) => Effect.succeed(source.slice(at, at + Math.min(chunkSize, count))),
        });
        assert.equal(actual.text, text.slice(offset, offset + 5));
        assert.equal(actual.nextTextOffset, text.length > offset + 5 ? offset + 5 : null);
      }
    }
  }),
);

it.effect("stops after one bounded chunk when a source field is very large", () =>
  Effect.gen(function* () {
    const source = new TextEncoder().encode(JSON.stringify({ summaryText: "x".repeat(2_000_000) }));
    let fetched = 0;
    const result = yield* readJsonStringFieldPage({
      field: "summaryText",
      offset: 0,
      maxChars: 4_000,
      read: (at, count) => {
        fetched += Math.min(count, source.length - at);
        return Effect.succeed(source.slice(at, at + count));
      },
    });
    assert.equal(result.text.length, 4_000);
    assert.equal(result.nextTextOffset, 4_000);
    assert.equal(fetched, JSON_FIELD_READ_BYTES);
  }),
);

it.effect("streams a complete source once with intact surrogate pairs and bounded chunks", () =>
  Effect.gen(function* () {
    const text = '🧪🧪\ud800\n\\"界' + "retained ".repeat(9_000);
    const source = new TextEncoder().encode(JSON.stringify({ summaryText: text, after: "Unused" }));
    for (const maxChars of [1, 2, 7, 4_000]) {
      const pages: string[] = [];
      let fetched = 0;
      const result = yield* readJsonStringFieldPage({
        field: "summaryText",
        offset: 0,
        maxChars,
        read: (at, count) => {
          const bytes = source.slice(at, at + count);
          fetched += bytes.length;
          return Effect.succeed(bytes);
        },
        onPage: (part) =>
          Effect.sync(() => {
            assert.isAtMost(part.length, maxChars);
            pages.push(part);
          }),
      });
      assert.equal(pages.join(""), text);
      assert.equal(fetched, source.length);
      assert.deepEqual(result, { text: "", nextTextOffset: null });
    }
  }),
);

it.effect("fails closed for a missing, non-string or incomplete source field", () =>
  Effect.gen(function* () {
    for (const json of ['{"summary":42}', '{"summary":"unfinished', '{"other":"value"}']) {
      const source = new TextEncoder().encode(json);
      const result = yield* readJsonStringFieldPage({
        field: "summary",
        offset: 0,
        maxChars: 100,
        read: (at, count) => Effect.succeed(source.slice(at, at + count)),
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
  }),
);
