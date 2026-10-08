import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectHttp from "./http.ts";

class ConnectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.connect) {}

it("keeps Scient cloud integration disabled unless explicitly opted in", () => {
  expect(
    ConnectHttp.isScientCloudIntegrationDisabled({ SCIENT_NEXT_SAFETY_ENVELOPE: "true" }),
  ).toBe(true);
  expect(
    ConnectHttp.isScientCloudIntegrationDisabled({
      SCIENT_NEXT_SAFETY_ENVELOPE: "true",
      SCIENT_NEXT_CLOUD_ENABLED: "true",
    }),
  ).toBe(false);
  expect(
    ConnectHttp.isScientCloudIntegrationDisabled({
      NODE_ENV: "test",
      SCIENT_NEXT_CLOUD_ROUTE_TEST: "true",
    }),
  ).toBe(false);
  expect(
    ConnectHttp.isScientCloudIntegrationDisabled({
      NODE_ENV: "production",
      SCIENT_NEXT_CLOUD_ROUTE_TEST: "true",
    }),
  ).toBe(true);
  expect(ConnectHttp.isScientCloudIntegrationDisabled({})).toBe(true);
});

// The signed relay routes need no session, so a CloudLink that fails each
// request shows how the transport answers that failure.
const withHealthHandler = async <A>(
  answerHealthRequest: CloudLink.CloudLink["Service"]["answerHealthRequest"],
  body: (handler: (request: Request) => Promise<Response>) => Promise<A>,
) => {
  const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
    Layer.provide(ConnectHttp.layer),
    Layer.provide(
      Layer.mock(CloudLink.CloudLink)({
        answerHealthRequest,
      }),
    ),
    // The session-gated routes are declared too; this request never reaches them.
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, {
    disableLogger: true,
  });
  try {
    return await body(handler);
  } finally {
    await dispose();
  }
};

const requestHealth = async (handler: (request: Request) => Promise<Response>) => {
  const response = await handler(
    new Request("http://127.0.0.1/api/t3-connect/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: "proof" }),
    }),
  );
  return { status: response.status, body: (await response.json()) as unknown };
};

describe("connect routes", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SCIENT_NEXT_CLOUD_ENABLED", undefined);
    vi.stubEnv("SCIENT_NEXT_CLOUD_ROUTE_TEST", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      failure: new CloudLink.CloudLinkProofRejectedError({ request: "health" }),
      status: 401,
      body: { _tag: "EnvironmentHttpUnauthorizedError", message: "Invalid cloud health request." },
    },
    {
      failure: new CloudLink.CloudLinkProofReplayedError({ request: "health" }),
      status: 409,
      body: {
        _tag: "EnvironmentHttpConflictError",
        message: "Cloud health request was already consumed.",
      },
    },
    {
      failure: new CloudLink.CloudLinkInternalError({
        operation: "answer-health",
        cause: new Error("disk full"),
      }),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Could not answer cloud health request.",
      },
    },
    {
      failure: new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud mint public key is not installed for this environment.",
      },
    },
  ])("answers $failure._tag with HTTP $status", async ({ failure, status, body }) => {
    const answerHealthRequest = vi.fn(() => Effect.fail(failure));
    const response = await withHealthHandler(answerHealthRequest, requestHealth);
    expect(response).toEqual({ status, body });
    expect(answerHealthRequest).toHaveBeenCalledExactlyOnceWith({ proof: "proof" });
  });

  it.each([
    { mode: "test", testOptIn: undefined },
    { mode: "production", testOptIn: "true" },
  ])(
    "keeps cloud routes disabled in $mode without operator opt-in",
    async ({ mode, testOptIn }) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("SCIENT_NEXT_CLOUD_ROUTE_TEST", testOptIn);
      const answerHealthRequest = vi.fn(() =>
        Effect.fail(new CloudLink.CloudLinkProofRejectedError({ request: "health" })),
      );

      const response = await withHealthHandler(answerHealthRequest, requestHealth);

      expect(response).toEqual({
        status: 500,
        body: {
          _tag: "EnvironmentHttpInternalServerError",
          message: "Cloud integration is disabled by the current Scient safety policy.",
        },
      });
      expect(answerHealthRequest).not.toHaveBeenCalled();
    },
  );

  it("captures the route policy when each handler layer is built", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const answerHealthRequest = vi.fn(() =>
      Effect.fail(new CloudLink.CloudLinkProofRejectedError({ request: "health" })),
    );

    await withHealthHandler(answerHealthRequest, async (handler) => {
      const disabled = await requestHealth(handler);
      expect(disabled.status).toBe(500);
      expect(disabled.body).toEqual({
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud integration is disabled by the current Scient safety policy.",
      });

      vi.stubEnv("SCIENT_NEXT_CLOUD_ENABLED", "true");
      expect(await requestHealth(handler)).toEqual(disabled);
      expect(answerHealthRequest).not.toHaveBeenCalled();
    });

    await withHealthHandler(answerHealthRequest, async (handler) => {
      const enabled = await requestHealth(handler);
      expect(enabled).toEqual({
        status: 401,
        body: {
          _tag: "EnvironmentHttpUnauthorizedError",
          message: "Invalid cloud health request.",
        },
      });

      vi.stubEnv("SCIENT_NEXT_CLOUD_ENABLED", undefined);
      expect(await requestHealth(handler)).toEqual(enabled);
      expect(answerHealthRequest).toHaveBeenCalledTimes(2);
    });

    expect(await withHealthHandler(answerHealthRequest, requestHealth)).toEqual({
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud integration is disabled by the current Scient safety policy.",
      },
    });
    expect(answerHealthRequest).toHaveBeenCalledTimes(2);
  });
});
