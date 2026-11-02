import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { searchSuggestions } from "./searchSuggestions.ts";

const answering = (body: string, status = 200) => {
  const requested: Array<string> = [];
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      requested.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
    }),
  );
  return { layer, requested };
};

describe("searchSuggestions", () => {
  it.effect("returns what the engine suggests", () => {
    const { layer, requested } = answering(
      JSON.stringify(["crispr", ["crispr cas9", "crispr therapeutics"]]),
    );
    return Effect.gen(function* () {
      expect(yield* searchSuggestions({ engine: "google", query: "crispr" })).toEqual({
        searches: ["crispr cas9", "crispr therapeutics"],
      });
      expect(requested[0]).toContain("suggestqueries.google.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an answer with extra fields, as Google's has", () => {
    const { layer } = answering(
      JSON.stringify(["crispr", ["crispr cas9"], [], { "google:suggesttype": ["QUERY"] }]),
    );
    return Effect.gen(function* () {
      expect(yield* searchSuggestions({ engine: "google", query: "crispr" })).toEqual({
        searches: ["crispr cas9"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("encodes what's typed, whatever the language", () => {
    const { layer, requested } = answering(JSON.stringify(["מחקר", ["מחקר איכותני"]]));
    return Effect.gen(function* () {
      const { searches } = yield* searchSuggestions({ engine: "bing", query: "מחקר & more" });
      expect(searches).toEqual(["מחקר איכותני"]);
      expect(requested[0]).toContain(encodeURIComponent("מחקר & more"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps at most five, skipping anything that isn't a usable suggestion", () => {
    const { layer } = answering(
      JSON.stringify(["a", ["1", 2, "", "3", "x".repeat(201), "4", "5", "6", "7"]]),
    );
    return Effect.gen(function* () {
      const { searches } = yield* searchSuggestions({ engine: "kagi", query: "a" });
      expect(searches).toEqual(["1", "3", "4", "5", "6"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["brave", "ecosia", "custom"] as const)("asks nothing of %s", (engine) => {
    const { layer, requested } = answering("[]");
    return Effect.gen(function* () {
      expect(yield* searchSuggestions({ engine, query: "a" })).toEqual({ searches: [] });
      expect(requested).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["an error", "[]", 500],
    ["a refusal", "[]", 429],
    ["an unreadable answer", "<html>", 200],
    ["an unexpected shape", '{"a":1}', 200],
  ])("gives no suggestions for %s", ([, body, status]) => {
    const { layer } = answering(body as string, status as number);
    return Effect.gen(function* () {
      expect(yield* searchSuggestions({ engine: "google", query: "a" })).toEqual({ searches: [] });
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up on an engine that doesn't answer", () => {
    const hanging = Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.never));
    return Effect.gen(function* () {
      const fiber = yield* searchSuggestions({ engine: "google", query: "a" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ searches: [] });
    }).pipe(Effect.provide(hanging));
  });

  it.effect("gives no suggestions when the network fails", () => {
    const failing = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      expect(yield* searchSuggestions({ engine: "google", query: "a" })).toEqual({ searches: [] });
    }).pipe(Effect.provide(failing));
  });
});
