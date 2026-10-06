import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Headers } from "effect/unstable/http";
import {
  HTTP_FAILURE_OBSERVATION_PREFIX,
  MAX_HTTP_FAILURE_OBSERVATION_BYTES,
  observeInitialStaticHtmlAssertion,
  observeInitialStaticHtmlBody,
} from "./ScientHttpInitialResponseObservation.test-support.ts";

const response = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: Headers.fromInput(headers),
});
const decodeObservation = (message: string) =>
  JSON.parse(message.slice(HTTP_FAILURE_OBSERVATION_PREFIX.length));

it("observes the actual strict HTML assertion failure once and rethrows its same error", () => {
  const messages: string[] = [];
  let decidingError: unknown;
  let caughtError: unknown;
  try {
    observeInitialStaticHtmlAssertion(
      response(200, { "content-length": "21", "content-type": "text/html; charset=utf-8" }),
      "",
      () => {
        try {
          expect("").toBe("<html>old build</html>");
        } catch (error) {
          decidingError = error;
          throw error;
        }
      },
      (message) => messages.push(message),
    );
  } catch (error) {
    caughtError = error;
  }
  expect(decidingError).toBeDefined();
  expect(caughtError).toBe(decidingError);
  expect(messages).toHaveLength(1);
  expect(decodeObservation(messages[0]!)).toEqual({
    phase: "assertion",
    status: 200,
    headers: {
      contentLength: "21",
      contentType: "text/html; charset=utf-8",
      contentEncoding: null,
      cacheControl: null,
      transferEncoding: null,
      etagPresent: false,
      lastModifiedPresent: false,
      locationPresent: false,
    },
    decodedBodyUtf8Bytes: 0,
  });
});

it.effect("keeps successful body/assertion results silent and reads the body only once", () =>
  Effect.gen(function* () {
    const messages: string[] = [];
    let reads = 0;
    let assertions = 0;
    const result = yield* observeInitialStaticHtmlBody(
      response(200),
      Effect.sync(() => {
        reads += 1;
        return "<html>old build</html>";
      }),
      (message) => messages.push(message),
    );
    const sentinel = {};
    const returned = observeInitialStaticHtmlAssertion(
      response(200),
      result,
      () => {
        assertions += 1;
        expect(result).toBe("<html>old build</html>");
        return sentinel;
      },
      (message) => messages.push(message),
    );
    expect(returned).toBe(sentinel);
    expect(reads).toBe(1);
    expect(assertions).toBe(1);
    expect(messages).toEqual([]);
  }),
);

it.effect(
  "distinguishes failed body reads and preserves the exact Cause even if publishing throws",
  () =>
    Effect.gen(function* () {
      const originalCause = Cause.die(new Error("private error text"));
      const messages: string[] = [];
      const originalResponse = response(302, { location: "https://private.invalid/?token=secret" });
      const observed = yield* Effect.exit(
        observeInitialStaticHtmlBody(originalResponse, Effect.failCause(originalCause), (message) =>
          messages.push(message),
        ),
      );
      expect(Exit.isFailure(observed)).toBe(true);
      if (Exit.isFailure(observed)) expect(observed.cause).toBe(originalCause);
      expect(messages).toHaveLength(1);
      expect(decodeObservation(messages[0]!)).toMatchObject({
        phase: "body-read",
        status: 302,
        decodedBodyUtf8Bytes: null,
        headers: { locationPresent: true },
      });
      expect(messages[0]).not.toContain("private");
      expect(messages[0]).not.toContain("secret");
      const failedPublisher = yield* Effect.exit(
        observeInitialStaticHtmlBody(originalResponse, Effect.failCause(originalCause), () => {
          throw new Error("observer unavailable");
        }),
      );
      expect(Exit.isFailure(failedPublisher)).toBe(true);
      if (Exit.isFailure(failedPublisher)) expect(failedPublisher.cause).toBe(originalCause);
    }),
);

it("excludes arbitrary header/body values and bounds evidence while preserving assertion errors", () => {
  const messages: string[] = [];
  const privateValue = "Bearer private-token /private/path " + "x".repeat(10_000);
  const body = "private prompt 😀";
  const assertionError = new Error("private deciding error");
  let caught: unknown;
  try {
    observeInitialStaticHtmlAssertion(
      response(200, {
        authorization: privateValue,
        "set-cookie": privateValue,
        "x-secret": privateValue,
        location: privateValue,
        etag: privateValue,
        "last-modified": privateValue,
        "content-length": privateValue,
        "content-type": privateValue,
        "content-encoding": privateValue,
        "cache-control": privateValue,
        "transfer-encoding": privateValue,
      }),
      body,
      () => {
        throw assertionError;
      },
      (message) => messages.push(message),
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(assertionError);
  expect(messages).toHaveLength(1);
  expect(Buffer.byteLength(messages[0]!, "utf8")).toBeLessThanOrEqual(
    MAX_HTTP_FAILURE_OBSERVATION_BYTES,
  );
  expect(messages[0]).not.toContain("private");
  expect(messages[0]).not.toContain("token");
  expect(messages[0]).not.toContain("authorization");
  expect(messages[0]).not.toContain("cookie");
  expect(decodeObservation(messages[0]!)).toMatchObject({
    decodedBodyUtf8Bytes: Buffer.byteLength(body, "utf8"),
    headers: {
      contentLength: "other",
      contentType: "other",
      contentEncoding: "other",
      cacheControl: "other",
      transferEncoding: "other",
      etagPresent: true,
      lastModifiedPresent: true,
      locationPresent: true,
    },
  });
  let publishingCaught: unknown;
  try {
    observeInitialStaticHtmlAssertion(
      response(200),
      body,
      () => {
        throw assertionError;
      },
      () => {
        throw new Error("observer unavailable");
      },
    );
  } catch (error) {
    publishingCaught = error;
  }
  expect(publishingCaught).toBe(assertionError);
});
