// @effect-diagnostics nodeBuiltinImport:off -- Reads contract and tool sources to keep the tables in step.
import { WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { AnalyticsService } from "./AnalyticsService.ts";
import { featureUsage } from "./FeatureUsage.ts";
import {
  SCIENT_ACTION_TOOLS,
  scientFeatureUsageLayer,
  scientRouteFeatureUsage,
} from "./ScientFeatureUsage.ts";
import { disabledAnalyticsService } from "./ScientAnalytics.ts";

const ROUTE_COUNT = 33;
const serverSource = NodePath.resolve(import.meta.dirname, "..");
const routesSource = NodeFS.readFileSync(
  NodePath.resolve(
    import.meta.dirname,
    "../../../../packages/contracts/src/scient/environmentHttpGroups.ts",
  ),
  "utf8",
);

function sources(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("Scient feature usage", () => {
  it("records Scient's requests through T3's feature table, with closed variants only", () => {
    expect(
      featureUsage(WS_METHODS.computeStartSession, { projectId: "p", languageId: "python" }),
    ).toEqual({ feature: "compute.session.start", variant: "python" });
    expect(
      featureUsage(WS_METHODS.computeStartSession, { languageId: "/Users/someone/python" }),
    ).toEqual({ feature: "compute.session.start" });
    expect(featureUsage(WS_METHODS.accountsPaperForSource, { sourceId: "private" })).toEqual({
      feature: "papers.get",
      variant: "source",
    });
    expect(
      featureUsage(WS_METHODS.extensionsPluginSetEnabled, { pluginId: "x", enabled: false }),
    ).toEqual({ feature: "extensions.plugin.set_enabled", variant: "off" });
    expect(
      featureUsage(WS_METHODS.providerPluginsAct, {
        instanceId: "private",
        action: { type: "install", name: "private" },
      }),
    ).toEqual({ feature: "providers.plugin.action", variant: "install" });
    expect(featureUsage(WS_METHODS.accountsUniversitySignIn, { universityId: "private" })).toEqual({
      feature: "university.sign_in",
    });
    // Reads, refreshes and subscriptions are not features someone chose.
    expect(featureUsage(WS_METHODS.computeListSessions, { projectId: "p" })).toBe(undefined);
    expect(featureUsage(WS_METHODS.accountsSnapshot, {})).toBe(undefined);
  });

  it("maps only POSTs to Scient routes that exist", () => {
    expect(scientRouteFeatureUsage("POST", "/api/scient/overleaf/v1/sync?x=1")).toEqual({
      feature: "overleaf.sync",
    });
    expect(scientRouteFeatureUsage("GET", "/api/scient/overleaf/v1/sync")).toBe(undefined);
    expect(scientRouteFeatureUsage("POST", "/api/scient/overleaf/v1/status")).toBe(undefined);
    const paths = [...routesSource.matchAll(/"(\/api\/scient\/[^"]+)"/gu)].map((m) => m[1]);
    const mapped = paths.filter((path) => scientRouteFeatureUsage("POST", path!) !== undefined);
    // Every route in the table still exists; a renamed route drops out and fails here.
    expect(mapped.length).toBe(ROUTE_COUNT);
  });

  it("names only tools Scient registers", () => {
    const registered = new Set(
      sources(serverSource).flatMap((path) =>
        [...NodeFS.readFileSync(path, "utf8").matchAll(/Tool\.make\("([a-z_]+)"/gu)].map(
          (match) => match[1],
        ),
      ),
    );
    for (const tool of SCIENT_ACTION_TOOLS) expect(registered, tool).toContain(tool);
  });

  it("records an HTTP action with its outcome, and never fails the request", async () => {
    const recorded: Array<readonly [string, Readonly<Record<string, unknown>> | undefined]> = [];
    const analytics = Layer.succeed(AnalyticsService, {
      ...disabledAnalyticsService,
      record: (event: string, properties?: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => void recorded.push([event, properties])),
    });
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", "/api/scient/overleaf/v1/sync", HttpServerResponse.text("ok")),
      HttpRouter.add(
        "POST",
        "/api/scient/overleaf/v1/connect",
        HttpServerResponse.text("no", { status: 409 }),
      ),
      HttpRouter.add("POST", "/api/scient/overleaf/v1/status", HttpServerResponse.text("ok")),
      scientFeatureUsageLayer,
    ).pipe(Layer.provide(analytics));
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      for (const path of ["sync", "connect", "status"]) {
        await handler(
          new Request(`http://localhost/api/scient/overleaf/v1/${path}`, { method: "POST" }),
        );
      }
    } finally {
      await dispose();
    }
    expect(recorded).toEqual([
      ["feature.used", { feature: "overleaf.sync", outcome: "ok", durationMs: expect.any(Number) }],
      [
        "feature.used",
        { feature: "overleaf.connect", outcome: "error", durationMs: expect.any(Number) },
      ],
    ]);
  });
});
