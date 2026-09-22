import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeOpenRouterAnalytics } from "./openRouterAnalytics.ts";

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("OpenRouter analytics", () => {
  it.effect("groups analytics by API key and model in one query", () =>
    Effect.gen(function* () {
      const requests: Array<{ path: string; body?: unknown }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.headers.authorization).toBe("Bearer mgmt-secret");
          const path = new URL(request.url).pathname;
          const body =
            request.body._tag === "Uint8Array"
              ? decodeBody(new TextDecoder().decode(request.body.body))
              : undefined;
          requests.push({ path, ...(body === undefined ? {} : { body }) });
          if (path === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (path === "/api/v1/keys")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    hash: "hash-a",
                    name: "Scient",
                    label: "sk-or-…aaaa",
                    disabled: false,
                    limit: 10,
                    limit_remaining: 7,
                    limit_reset: "monthly",
                    include_byok_in_limit: true,
                    usage: 3,
                    usage_daily: 0.1,
                    usage_weekly: 0.5,
                    usage_monthly: 2,
                    byok_usage: 0.25,
                    workspace_id: "workspace-a",
                    expires_at: null,
                  },
                ],
              }),
            );
          if (path === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 20, total_usage: 5 } }),
            );
          if (path === "/api/v1/models")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    id: "z-ai/glm-5.3-flash",
                    canonical_slug: "z-ai/glm-5.3-flash-20260826",
                    name: "GLM 5.3 Flash",
                  },
                ],
              }),
            );
          if (path === "/api/v1/analytics/meta")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: {
                  metrics: [
                    "request_count",
                    "tokens_total",
                    "tokens_prompt",
                    "tokens_completion",
                    "reasoning_tokens",
                    "cached_tokens",
                    "total_usage",
                    "credits_usage",
                    "byok_usage",
                    "usage_upstream",
                    "usage_cache",
                    "usage_data",
                    "usage_web",
                  ],
                  dimensions: ["api_key_id", "model", "provider"],
                },
              }),
            );
          expect(path).toBe("/api/v1/analytics/query");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                data: [
                  {
                    date__day: "2026-09-20T00:00:00.000Z",
                    api_key_id: "…Scient",
                    model: "z-ai/glm-5.3-flash-20260826",
                    request_count: "3",
                    tokens_total: "1200",
                    tokens_prompt: "1000",
                    tokens_completion: "200",
                    reasoning_tokens: "50",
                    cached_tokens: "400",
                    total_usage: 0.12,
                    credits_usage: 0.12,
                    byok_usage: 0,
                    usage_upstream: 0.09,
                    usage_cache: 0.01,
                    usage_data: -0.005,
                    usage_web: 0.015,
                  },
                ],
                metadata: { row_count: 1, truncated: false },
              },
            }),
          );
        }),
      );
      const api = yield* makeOpenRouterAnalytics.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const result = yield* api.readSnapshot(
        { kind: "openrouter", managementKey: "mgmt-secret", enabled: true },
        "2026-09-01",
        "2026-09-20",
      );
      expect(result.keys[0]).toMatchObject({
        id: "hash-a",
        name: "Scient",
        limitUsd: 10,
        limitRemainingUsd: 7,
        limitReset: "monthly",
        includeByokInLimit: true,
        usageUsd: 3,
        byokUsageUsd: 0.25,
      });
      expect(result.rows[0]).toMatchObject({
        keyId: "hash-a",
        model: "z-ai/glm-5.3-flash-20260826",
        modelName: "GLM 5.3 Flash",
        metrics: {
          requests: 3,
          totalTokens: 1200,
          totalCostUsd: 0.12,
          dataCostUsd: -0.005,
        },
      });
      const query = requests.find((entry) => entry.path.endsWith("analytics/query"))
        ?.body as Record<string, unknown>;
      expect(query["dimensions"]).toEqual(["api_key_id", "model"]);
      expect(query["filters"]).toBeUndefined();
      expect(query["limit"]).toBe(10_000);
      expect(requests.filter((entry) => entry.path.endsWith("analytics/query"))).toHaveLength(1);
    }),
  );

  it.effect("discovers and deduplicates keys across personal and organization workspaces", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: [{ id: "workspace-a", name: "Research" }] }),
            );
          if (url.pathname === "/api/v1/keys") {
            const workspace = url.searchParams.get("workspace_id");
            const common = {
              name: "Shared",
              disabled: false,
              usage: 0,
              byok_usage: 0,
              limit: null,
              limit_remaining: null,
              limit_reset: null,
              include_byok_in_limit: false,
              expires_at: null,
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data:
                  workspace === null
                    ? [{ ...common, hash: "personal" }]
                    : [
                        { ...common, hash: "personal" },
                        { ...common, hash: "workspace", workspace_id: workspace },
                      ],
              }),
            );
          }
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 0, total_usage: 0 } }),
            );
          if (url.pathname === "/api/v1/models")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/analytics/meta")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: { metrics: ["request_count", "tokens_total", "total_usage"] },
              }),
            );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: { data: [], metadata: { truncated: false } } }),
          );
        }),
      );
      const api = yield* makeOpenRouterAnalytics.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const result = yield* api.readSnapshot(
        { kind: "openrouter", managementKey: "mgmt-secret", enabled: true },
        "2026-09-01",
        "2026-09-20",
      );
      expect(result.keys.map((key) => key.id).sort()).toEqual(["personal", "workspace"]);
    }),
  );

  it.effect("advances key pagination by the number of rows actually returned", () =>
    Effect.gen(function* () {
      const offsets: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/keys") {
            const offset = url.searchParams.get("offset") ?? "0";
            offsets.push(offset);
            const ids = offset === "0" ? ["key-a", "key-b"] : ["key-c"];
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                total_count: 3,
                data: ids.map((hash) => ({
                  hash,
                  name: hash,
                  disabled: false,
                  usage: 0,
                  byok_usage: 0,
                  limit: hash === "key-c" ? "not-a-number" : null,
                  limit_remaining: null,
                  expires_at: null,
                })),
              }),
            );
          }
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 0, total_usage: 0 } }),
            );
          if (url.pathname === "/api/v1/models")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/analytics/meta")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: { metrics: ["request_count", "tokens_total", "total_usage"] },
              }),
            );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: { data: [], metadata: { truncated: false } } }),
          );
        }),
      );
      const api = yield* makeOpenRouterAnalytics.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const result = yield* api.readSnapshot(
        { kind: "openrouter", managementKey: "mgmt-secret", enabled: true },
        "2026-09-01",
        "2026-09-20",
      );

      expect(offsets).toEqual(["0", "2"]);
      expect(result.keys.map((key) => key.id)).toEqual(["key-a", "key-b", "key-c"]);
      expect(result.keys[2]?.limitUsd).toBeNull();
    }),
  );

  it.effect("falls back to per-key queries when a grouped query is rejected", () =>
    Effect.gen(function* () {
      const queryDimensions: unknown[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (path === "/api/v1/keys")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    hash: "hash-a",
                    name: "Scient",
                    disabled: false,
                    usage: 0,
                    byok_usage: 0,
                    limit: null,
                    limit_remaining: null,
                    expires_at: null,
                  },
                  {
                    hash: "hash-b",
                    name: "Backup",
                    disabled: false,
                    usage: 0,
                    byok_usage: 0,
                    limit: null,
                    limit_remaining: null,
                    expires_at: null,
                  },
                ],
              }),
            );
          if (path === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 0, total_usage: 0 } }),
            );
          if (path === "/api/v1/models")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (path === "/api/v1/analytics/meta")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: {
                  metrics: ["request_count", "tokens_total", "total_usage"],
                  dimensions: ["api_key_id", "model"],
                },
              }),
            );
          const body =
            request.body._tag === "Uint8Array"
              ? (decodeBody(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
              : {};
          queryDimensions.push(body["dimensions"]);
          if ((body["dimensions"] as unknown[]).includes("api_key_id")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "unsupported grouping" }, { status: 400 }),
            );
          }
          const filters = body["filters"] as Array<{ value?: unknown }> | undefined;
          if (filters?.[0]?.value === "hash-b") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "temporarily unavailable" }, { status: 503 }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                data: [
                  {
                    date__day: "2026-09-20T00:00:00.000Z",
                    model: "z-ai/glm",
                    request_count: 1,
                    tokens_total: 100,
                    total_usage: 0.01,
                  },
                ],
                metadata: { truncated: false },
              },
            }),
          );
        }),
      );
      const api = yield* makeOpenRouterAnalytics.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const result = yield* api.readSnapshot(
        { kind: "openrouter", managementKey: "mgmt-secret", enabled: true },
        "2026-09-01",
        "2026-09-20",
      );
      expect(queryDimensions).toEqual([["api_key_id", "model"], ["model"], ["model"]]);
      expect(result.rows[0]).toMatchObject({ keyId: "hash-a", model: "z-ai/glm" });
      expect(result.failedKeys).toBe(1);
      expect(result.failedKeyIds).toEqual(["hash-b"]);
    }),
  );

  it.effect("rejects an inference-key-shaped 403 without exposing the credential", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "forbidden" }, { status: 403 }),
          ),
        ),
      );
      const api = yield* makeOpenRouterAnalytics.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const error = yield* Effect.flip(
        api.readSnapshot(
          { kind: "openrouter", managementKey: "never-print-me", enabled: true },
          "2026-09-01",
          "2026-09-20",
        ),
      );
      expect(error.detail).not.toContain("never-print-me");
    }),
  );
});
