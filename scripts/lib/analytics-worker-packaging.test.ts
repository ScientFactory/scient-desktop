// @effect-diagnostics nodeBuiltinImport:off -- Exercises a standalone packaged backend with synthetic state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { build } from "vite-plus/pack";

import { CLI_BUNDLE_ALIASES } from "./cli-bundle-aliases.ts";
import { isExternalCliDependency, shouldBundleCliDependency } from "./cli-external-packages.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const CapturedBatch = Schema.fromJsonString(
  Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        distinct_id: Schema.String,
        session_id: Schema.String,
        properties: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);
const decodeCapturedBatch = Schema.decodeSync(CapturedBatch);

it("delivers from a relocated CLI chunk, preserves identity across restarts, and respects Off", async () => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient analytics bundle-"));
  const batches: Array<typeof CapturedBatch.Type> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/events");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const batch = decodeCapturedBatch(Buffer.concat(chunks).toString("utf8"));
      batches.push(batch);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ accepted: batch.events.length }));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
    const serverRequire = NodeModule.createRequire(
      NodePath.join(repoRoot, "apps/server/package.json"),
    );
    const entry = NodePath.join(scratch, "bin.mjs");
    const probe = NodePath.join(scratch, "probe.mjs");
    const output = NodePath.join(scratch, "relocated package");
    await NodeFSP.writeFile(
      entry,
      `
      // The product server keeps the process alive; this probe only has an unreferenced worker.
      const keepAlive = setInterval(() => {}, 1000);
      try { await import("./probe.mjs"); }
      finally { clearInterval(keepAlive); }
    `,
    );
    await NodeFSP.writeFile(
      probe,
      `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import path from 'node:path';
      import { DatabaseSync } from 'node:sqlite';
      import * as Effect from ${JSON.stringify(serverRequire.resolve("effect/Effect"))};
      import * as Layer from ${JSON.stringify(serverRequire.resolve("effect/Layer"))};
      import * as ConfigProvider from ${JSON.stringify(serverRequire.resolve("effect/ConfigProvider"))};
      import * as NodeServices from ${JSON.stringify(serverRequire.resolve("@effect/platform-node/NodeServices"))};
      import { make } from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/telemetry/ScientAnalytics.ts"))};
      import { ServerConfig } from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/config.ts"))};

      const [baseDir, endpoint, mode] = process.argv.slice(2);
      const config = Layer.mergeAll(
        ServerConfig.layerTest(baseDir, baseDir),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
          SCIENT_ANALYTICS_ENABLED: mode === 'master-off' ? 'false' : 'true',
          SCIENT_ANALYTICS_CONSENT: 'product',
          SCIENT_ANALYTICS_APP_VERSION: '9.9.9',
          SCIENT_ANALYTICS_BUILD_CHANNEL: 'stable',
          SCIENT_ANALYTICS_TEST_ENDPOINT: endpoint,
        } })),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      await Effect.runPromise(Effect.gen(function* () {
        const server = yield* ServerConfig;
        const analytics = yield* make;
        const outbox = path.join(server.stateDir, 'analytics/outbox.sqlite');
        assert.deepEqual(yield* analytics.status, {
          available: mode !== 'master-off',
          consent: mode === 'collect' ? 'product' : 'off',
        });
        for (let index = 0; index < 600; index++) {
          yield* analytics.record('provider.turn.sent', { provider: 'codex', prompt: 'must-not-leave' });
        }
        yield* analytics.flush;
        if (mode === 'collect') {
          assert.ok(existsSync(outbox), 'packaged analytics worker must initialize its outbox');
          const database = new DatabaseSync(outbox, { readOnly: true });
          try {
            const pending = database.prepare('SELECT COUNT(*) AS n FROM analytics_outbox');
            for (let attempt = 0; pending.get().n > 0 && attempt < 30; attempt++) {
              yield* analytics.flush;
            }
            assert.equal(pending.get().n, 0, 'all queued batches must be acknowledged');
          } finally {
            database.close();
          }
        } else if (mode === 'master-off') {
          assert.equal(existsSync(outbox), false);
        }
      }).pipe(Effect.provide(config), Effect.scoped));
    `,
    );
    await build({
      config: false,
      alias: CLI_BUNDLE_ALIASES,
      entry: {
        bin: entry,
        "analytics-worker": NodePath.join(repoRoot, "apps/server/src/analytics-worker.ts"),
      },
      outDir: output,
      platform: "node",
      format: "esm",
      dts: false,
      logLevel: "error",
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: isExternalCliDependency,
        onlyBundle: false,
      },
    });
    assert.ok((await NodeFSP.readdir(output)).some((name) => /^probe-.+\.mjs$/.test(name)));
    const profile = NodePath.join(scratch, "synthetic profile");
    const run = (baseDir: string, mode: string) =>
      execFile(
        process.execPath,
        ["--no-global-search-paths", NodePath.join(output, "bin.mjs"), baseDir, endpoint, mode],
        {
          cwd: output,
          env: {
            HOME: scratch,
            USERPROFILE: scratch,
            PATH: "",
            SystemRoot: process.env.SystemRoot ?? "",
            ELECTRON_RUN_AS_NODE: "1",
          },
          timeout: 30_000,
        },
      );
    for (let restart = 0; restart < 4; restart++) await run(profile, "collect");
    const events = batches.flatMap((batch) => batch.events);
    const turns = events.filter((event) => event.name === "provider.turn.sent");
    const sessions = events.filter((event) => event.name === "app.session.started");
    assert.equal(turns.length, 2_400);
    assert.equal(new Set(turns.map((event) => event.id)).size, 2_400);
    assert.equal(new Set(turns.map((event) => event.distinct_id)).size, 1);
    assert.equal(sessions.length, 4);
    assert.equal(new Set(sessions.map((event) => event.session_id)).size, 4);
    assert.ok(events.every((event) => event.properties.appVersion === "9.9.9"));
    assert.ok(events.every((event) => event.properties.buildChannel === "stable"));
    assert.ok(events.every((event) => !("prompt" in event.properties)));
    const beforeOff = batches.length;
    await NodeFSP.writeFile(
      NodePath.join(profile, "userdata/analytics/preferences.json"),
      JSON.stringify({ version: 1, consent: "off" }),
    );
    await run(profile, "saved-off");
    await run(NodePath.join(scratch, "disabled profile"), "master-off");
    assert.equal(batches.length, beforeOff);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
});
