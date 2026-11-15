import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { droidTurnEndReason, droidTurnFailure } from "./DroidTurnFailure.ts";

const now = DateTime.makeUnsafe("2026-11-12T00:51:04.000Z");
// Factory's 402 bodies as Droid relays them.
const QUOTA_402 = `402 ${JSON.stringify({
  detail:
    "You've reached your 5-hour Droid Core usage limit (resets in 0h 21min).\nReload Extra Usage credits or wait for your limits to reset.",
  status: 402,
  title: "Payment Required",
  displayToUser: true,
})}`;
const SUBSCRIPTION_402 = `402 ${JSON.stringify({
  detail:
    "No active subscription found.\nAdd your own model key or start a plan to keep using Droid.",
  status: 402,
  title: "Payment Required",
  code: "no_active_subscription",
  displayToUser: true,
})}`;

describe("droidTurnFailure", () => {
  it.each([
    {
      name: "a used-up plan named only by its reason",
      reason: "model_usage_exhausted",
      detail: "Agent turn ended: model_usage_exhausted",
      expected: {
        class: "usage_limit",
        message: "Your Droid usage limit for this model is used up.",
        code: "model_usage_exhausted",
        retryable: true,
      },
    },
    {
      name: "a used-up plan with Factory's 402 body",
      reason: undefined,
      detail: QUOTA_402,
      expected: {
        class: "usage_limit",
        message:
          "You've reached your 5-hour Droid Core usage limit (resets in 0h 21min).\nReload Extra Usage credits or wait for your limits to reset.",
        code: "model_usage_exhausted",
        retryable: true,
        resetAt: "2026-11-12T01:12:04.000Z",
        httpStatus: 402,
      },
    },
    {
      name: "a missing subscription, though Droid calls it used-up usage",
      reason: "model_usage_exhausted",
      detail: SUBSCRIPTION_402,
      expected: {
        class: "permission_error",
        message:
          "No active subscription found.\nAdd your own model key or start a plan to keep using Droid.",
        code: "no_active_subscription",
        retryable: false,
        httpStatus: 402,
      },
    },
    {
      name: "an unknown 402",
      reason: undefined,
      detail: `402 ${JSON.stringify({ detail: "Payment Required" })}`,
      expected: {
        class: "provider_error",
        message: "Payment Required",
        code: null,
        retryable: null,
        httpStatus: 402,
      },
    },
    {
      name: "an unknown 402, though Droid calls it used-up usage",
      reason: "model_usage_exhausted",
      detail: `402 ${JSON.stringify({ detail: "Payment Required" })}`,
      expected: {
        class: "provider_error",
        message: "Payment Required",
        code: null,
        retryable: null,
        httpStatus: 402,
      },
    },
    {
      name: "a malformed 402, though Droid calls it used-up usage",
      reason: "model_usage_exhausted",
      detail: "402 usage limit <html>",
      expected: {
        class: "provider_error",
        message: "402 usage limit <html>",
        code: null,
        retryable: null,
        httpStatus: 402,
      },
    },
    {
      name: "a used-up plan whose reset is out of range",
      reason: "model_usage_exhausted",
      detail: `402 ${JSON.stringify({ detail: "Your usage limit resets in 999999999999h." })}`,
      expected: {
        class: "usage_limit",
        message: "Your usage limit resets in 999999999999h.",
        code: "model_usage_exhausted",
        retryable: true,
        httpStatus: 402,
      },
    },
    {
      name: "another reason, with paths and addresses in Droid's text",
      reason: "model_request_rejected",
      detail: "400 /Users/fixture/project/notes.md rejected for fixture@example.invalid",
      expected: {
        class: "validation_error",
        message: "400 notes.md rejected for [REDACTED]",
        code: "model_request_rejected",
        retryable: false,
        httpStatus: 400,
      },
    },
    {
      name: "another reason, with Droid's own text",
      reason: "model_authentication_failed",
      detail: "401 Invalid API key",
      expected: {
        class: "permission_error",
        message: "401 Invalid API key",
        code: "model_authentication_failed",
        retryable: false,
        httpStatus: 401,
      },
    },
    {
      name: "another reason, named only by its reason",
      reason: "model_provider_unreachable",
      detail: "Agent turn ended: model_provider_unreachable",
      expected: {
        class: "transport_error",
        message: "Droid could not reach the model provider.",
        code: "model_provider_unreachable",
        retryable: true,
      },
    },
  ] as const)("classifies $name", ({ reason, detail, expected }) => {
    assert.deepEqual(droidTurnFailure({ reason, detail, now }), expected);
  });

  it("keeps only Droid's fixed reason from its error data", () => {
    assert.equal(
      droidTurnEndReason({ sessionId: "fixture-session", reason: "model_rate_limited" }),
      "model_rate_limited",
    );
    assert.isUndefined(droidTurnEndReason({ sessionId: "fixture-session", reason: "free text" }));
    assert.isUndefined(droidTurnEndReason("model_rate_limited"));
  });
});
