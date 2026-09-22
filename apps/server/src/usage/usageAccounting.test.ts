import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { UsageAccountingSourceId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeUsageAccounting } from "./usageAccounting.ts";

const QUERY: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-20"),
  untilDay: UsageDay.make("2026-09-20"),
  includeAccounting: true,
};
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

describe("usage accounting cache", () => {
  it.effect("keeps the last successful ledger when OpenRouter later fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-accounting-cache-" });
      const cachePath = `${directory}/usage-accounting-cache.json`;
      let available = true;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (!available)
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "offline" }, { status: 503 }),
            );
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/keys")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    hash: "key-hash",
                    name: "Scient",
                    disabled: false,
                    limit: 10,
                    limit_remaining: 8,
                    usage: 2,
                    byok_usage: 0,
                    expires_at: null,
                  },
                ],
              }),
            );
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 10, total_usage: 2 } }),
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
            Response.json({
              data: {
                data: [
                  {
                    date__day: "2026-09-20T00:00:00.000Z",
                    model: "z-ai/glm-5.3-flash",
                    request_count: 4,
                    tokens_total: 1_500,
                    total_usage: 0.25,
                  },
                ],
                metadata: { truncated: false },
              },
            }),
          );
        }),
      );
      const service = yield* makeUsageAccounting.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const sourceId = UsageAccountingSourceId.make("openrouter-primary");
      const sources = {
        [sourceId]: {
          kind: "openrouter" as const,
          label: "OpenRouter",
          managementKey: "must-not-reach-cache",
          enabled: true,
        },
      };

      const fresh = yield* service.read({ cachePath, query: QUERY, sources });
      expect(fresh[0]).toMatchObject({
        status: "ok",
        totalCreditsUsd: 10,
        rows: [{ keyId: "key-hash", model: "z-ai/glm-5.3-flash" }],
      });
      expect(yield* fs.readFileString(cachePath)).not.toContain("must-not-reach-cache");

      available = false;
      const fallback = yield* service.read({ cachePath, query: QUERY, sources });
      expect(fallback[0]).toMatchObject({
        status: "cached",
        totalCreditsUsd: 10,
        rows: [
          {
            keyId: "key-hash",
            model: "z-ai/glm-5.3-flash",
            metrics: { requests: 4, totalTokens: 1_500, totalCostUsd: 0.25 },
          },
        ],
      });
      expect(fallback[0]?.message).not.toContain("must-not-reach-cache");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps cached rows for only the API keys whose refresh failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-accounting-partial-" });
      const cachePath = `${directory}/usage-accounting-cache.json`;
      yield* fs.writeFileString(
        cachePath,
        encodeUnknownJson({
          version: 1,
          sources: {
            "openrouter-primary": {
              lastSyncedAt: "2026-09-20T00:00:00.000Z",
              totalCreditsUsd: 10,
              totalUsageUsd: 2,
              keys: [],
              rows: [
                {
                  day: "2026-09-20",
                  keyId: "key-b",
                  model: "cached/model",
                  metrics: {
                    requests: 2,
                    totalTokens: 200,
                    promptTokens: 150,
                    completionTokens: 50,
                    reasoningTokens: 0,
                    cachedTokens: 0,
                    totalCostUsd: 0.02,
                    creditsCostUsd: 0.02,
                    byokCostUsd: 0,
                    upstreamCostUsd: 0,
                    cacheCostUsd: 0,
                    dataCostUsd: 0,
                    webCostUsd: 0,
                  },
                },
              ],
            },
          },
        }),
      );
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/keys")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: ["key-a", "key-b"].map((hash) => ({
                  hash,
                  name: hash,
                  disabled: false,
                  usage: 0,
                  byok_usage: 0,
                  limit: null,
                  limit_remaining: null,
                  expires_at: null,
                })),
              }),
            );
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 10, total_usage: 2 } }),
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
          const body =
            request.body._tag === "Uint8Array"
              ? (decodeUnknownJson(new TextDecoder().decode(request.body.body)) as {
                  filters?: Array<{ value?: string }>;
                })
              : {};
          if (body.filters?.[0]?.value === "key-b")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "offline" }, { status: 503 }),
            );
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                data: [
                  {
                    date__day: "2026-09-20T00:00:00.000Z",
                    model: "fresh/model",
                    request_count: 3,
                    tokens_total: 300,
                    total_usage: 0.03,
                  },
                ],
                metadata: { truncated: false },
              },
            }),
          );
        }),
      );
      const service = yield* makeUsageAccounting.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const sourceId = UsageAccountingSourceId.make("openrouter-primary");
      const summaries = yield* service.read({
        cachePath,
        query: QUERY,
        sources: {
          [sourceId]: {
            kind: "openrouter",
            managementKey: "must-not-reach-cache",
            enabled: true,
          },
        },
      });

      expect(summaries[0]).toMatchObject({
        status: "partial",
        rows: [
          { keyId: "key-a", model: "fresh/model" },
          { keyId: "key-b", model: "cached/model" },
        ],
      });
      expect(summaries[0]?.message).toContain("cached rows are shown where available");
      expect(yield* fs.readFileString(cachePath)).not.toContain("must-not-reach-cache");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps historical rows when an API key is removed from OpenRouter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-accounting-removed-key-",
      });
      const cachePath = `${directory}/usage-accounting-cache.json`;
      yield* fs.writeFileString(
        cachePath,
        encodeUnknownJson({
          version: 1,
          sources: {
            "openrouter-primary": {
              lastSyncedAt: "2026-09-20T00:00:00.000Z",
              totalCreditsUsd: 10,
              totalUsageUsd: 2,
              keys: [],
              rows: [
                {
                  day: "2026-09-20",
                  keyId: "removed-key",
                  model: "historical/model",
                  metrics: {
                    requests: 2,
                    totalTokens: 200,
                    promptTokens: 150,
                    completionTokens: 50,
                    reasoningTokens: 0,
                    cachedTokens: 0,
                    totalCostUsd: 0.02,
                    creditsCostUsd: 0.02,
                    byokCostUsd: 0,
                    upstreamCostUsd: 0,
                    cacheCostUsd: 0,
                    dataCostUsd: 0,
                    webCostUsd: 0,
                  },
                },
              ],
            },
          },
        }),
      );
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/keys")
            return HttpClientResponse.fromWeb(request, Response.json({ data: [] }));
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 10, total_usage: 2 } }),
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
      const service = yield* makeUsageAccounting.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const sourceId = UsageAccountingSourceId.make("openrouter-primary");
      const [summary] = yield* service.read({
        cachePath,
        query: QUERY,
        sources: {
          [sourceId]: {
            kind: "openrouter",
            managementKey: "must-not-reach-cache",
            enabled: true,
          },
        },
      });

      expect(summary?.status).toBe("ok");
      expect(summary?.rows).toEqual([
        expect.objectContaining({ keyId: "removed-key", model: "historical/model" }),
      ]);
      const persisted = decodeUnknownJson(yield* fs.readFileString(cachePath)) as {
        sources: Record<string, { rows: Array<{ keyId: string }> }>;
      };
      expect(persisted.sources["openrouter-primary"]?.rows).toEqual([
        expect.objectContaining({ keyId: "removed-key" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("marks personal usage partial when organization workspace discovery fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-accounting-workspace-",
      });
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/workspaces")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "temporarily unavailable" }, { status: 503 }),
            );
          if (url.pathname === "/api/v1/keys")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                total_count: 1,
                data: [
                  {
                    hash: "personal-key",
                    name: "Personal",
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
          if (url.pathname === "/api/v1/credits")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ data: { total_credits: 10, total_usage: 1 } }),
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
      const service = yield* makeUsageAccounting.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const sourceId = UsageAccountingSourceId.make("openrouter-primary");
      const [summary] = yield* service.read({
        cachePath: `${directory}/usage-accounting-cache.json`,
        query: QUERY,
        sources: {
          [sourceId]: {
            kind: "openrouter",
            managementKey: "must-not-reach-cache",
            enabled: true,
          },
        },
      });

      expect(summary?.status).toBe("partial");
      expect(summary?.message).toContain("may exclude organization workspaces");
      expect(summary?.keys.map((key) => key.id)).toEqual(["personal-key"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
