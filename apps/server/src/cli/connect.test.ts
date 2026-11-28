// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { makeCli } from "../binCli.ts";
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "../cloud/CliState.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
} from "../cloud/config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { acquireRelayClientForLink, reportServiceOnboarding } from "./connect.ts";
import { resolveCliCommand } from "./invocation.ts";
import { offerServiceDuringOnboarding } from "./service.ts";

const unreachableBootService = BootService.BootService.of({
  install: () => Effect.die("D4 service guard was bypassed"),
  uninstall: Effect.die("D4 service guard was bypassed"),
  restart: Effect.die("D4 service guard was bypassed"),
  withStopped: () => Effect.die("D4 service guard was bypassed"),
  status: Effect.die("D4 service guard was bypassed"),
});

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("does not offer the inherited global service during Scient onboarding", () =>
  Effect.gen(function* () {
    const result = yield* offerServiceDuringOnboarding;
    const output = (yield* TestConsole.logLines).join("\n");
    assert.equal(result, "skipped");
    assert.include(output, "safety envelope is enabled");
    assert.notInclude(output, "distinct Scient service identity");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/tmp", { prefix: "t3-connect-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
        TestConsole.layer,
        Layer.succeed(BootService.BootService, unreachableBootService),
      ),
    ),
  ),
);

it.effect("reports a pending handoff without claiming the service is ready", () =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const report = (outcome: "pending" | "ready") =>
      reportServiceOnboarding(outcome).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args) => {
            lines.push(args.map(String).join(" "));
          },
        }),
      );
    yield* report("pending");
    assert.notInclude(lines.join("\n"), "Background service ready");
    assert.notInclude(lines.join("\n"), "Start the server");
    assert.include(lines.join("\n"), "Background service restarting");
    lines.length = 0;
    yield* report("ready");
    assert.include(lines.join("\n"), "Background service ready");
    assert.notInclude(lines.join("\n"), "restarting");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest("/tmp", { prefix: "scient-connect-report-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect next steps",
  (it) => {
    it.effect.each([
      { subcommand: "status", hint: "connect link" },
      { subcommand: "publish", hint: "connect login" },
    ])("t3 connect $subcommand names `t3 $hint` with --base-dir", ({ subcommand, hint }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-hint-test-" });

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          subcommand,
          "--base-dir",
          baseDir,
        ]);

        // SCIENT-FORK:START — Scient names this installation's own command.
        const command = yield* resolveCliCommand([...hint.split(" "), "--base-dir", baseDir]);
        // SCIENT-FORK:END
        assert.include((yield* TestConsole.logLines).join("\n"), `\`${command}\``);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      ),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect unlink and status",
  (it) => {
    const runConnect = (
      recordedPid: number,
      options?: {
        readonly portFreed?: boolean;
        readonly command?: "unlink" | "status";
        readonly linkMode?: "managed" | "publish_only";
        /** Linked from desktop, web, or mobile: no CLI-desired link is stored. */
        readonly linkedByApp?: boolean;
        // SCIENT-FORK:START — Scient Accounts: a running server that fails to unlink keeps its link.
        /** A stored link, and whether the running server fails to unlink it. */
        readonly failUnlink?: boolean;
        /** The running server answers its unlink only once released, as behind the relay's turn. */
        readonly slowUnlink?: { readonly arrived: () => void; readonly released: Promise<void> };
        // SCIENT-FORK:END
      },
    ) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              // SCIENT-FORK:START — Scient Accounts: a running server that fails to unlink.
              if (options?.failUnlink && request.url === "/api/connect/unlink") {
                response.writeHead(500, { "content-type": "application/json" });
                response.end("{}");
                return;
              }
              if (options?.slowUnlink && request.url === "/api/connect/unlink") {
                options.slowUnlink.arrived();
                void options.slowUnlink.released.then(() => {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
                });
                return;
              }
              // SCIENT-FORK:END
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });
        // SCIENT-FORK:START — Scient Accounts: a stored link the unlink may or may not clear.
        if (options?.failUnlink !== undefined) {
          yield* fs.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
          yield* fs.writeFileString(
            `${baseDir}/userdata/secrets/${RELAY_ENVIRONMENT_CREDENTIAL_SECRET}.bin`,
            "relay_credential",
          );
        }
        // SCIENT-FORK:END
        if (options?.command === "status") {
          // Status asks the server for reachability only for a managed link.
          yield* fs.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
          yield* options.linkedByApp
            ? Effect.all([
                fs.writeFileString(
                  `${baseDir}/userdata/secrets/${CLOUD_LINKED_USER_ID}.bin`,
                  "user_app_linked",
                ),
                fs.writeFileString(
                  `${baseDir}/userdata/secrets/${CLOUD_ENDPOINT_RUNTIME_CONFIG}.bin`,
                  "{}",
                ),
                fs.writeFileString(
                  `${baseDir}/userdata/secrets/${RELAY_ENVIRONMENT_CREDENTIAL_SECRET}.bin`,
                  "relay_credential",
                ),
              ])
            : fs.writeFileString(
                `${baseDir}/userdata/secrets/${CLOUD_CLI_DESIRED_LINK_SECRET}.bin`,
                options.linkMode ?? "managed",
              );
        }

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          options?.command ?? "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return {
          requests,
          warnings,
          printed: (yield* TestConsole.logLines).join("\n"),
          // SCIENT-FORK:START — Scient Accounts: whether the link is still stored afterwards.
          linkKept: yield* fs.exists(
            `${baseDir}/userdata/secrets/${RELAY_ENVIRONMENT_CREDENTIAL_SECRET}.bin`,
          ),
          // SCIENT-FORK:END
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    // SCIENT-FORK:START — Scient Accounts: a running server that fails to unlink keeps its link.
    it.effect("leaves the clear to the running server's own unlink", () =>
      Effect.gen(function* () {
        const { requests, linkKept } = yield* runConnect(process.pid, { failUnlink: false });

        assert.include(requests, "POST /api/connect/unlink");
        // regression: the CLI cleared the link again itself, outside the server's turn, where it
        // could erase a relink that came in between.
        assert.isTrue(linkKept);
      }),
    );

    it.effect("waits for a live unlink the server holds behind its relay's turn", () =>
      Effect.gen(function* () {
        let arrived: () => void = () => {};
        const arrival = new Promise<void>((resolve) => (arrived = resolve));
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => (release = resolve));
        const running = yield* runConnect(process.pid, {
          failUnlink: false,
          slowUnlink: { arrived, released },
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => arrival);
        // The server waits out its relay's 15 s turn before it unlinks.
        yield* TestClock.adjust("16 seconds");
        release();
        const { warnings } = yield* Fiber.join(running);
        // regression: the CLI gave up after 5 s and reported the unlink as failed.
        assert.notInclude(warnings.join("\n"), "could not stop its tunnel");
      }),
    );

    it.effect("clears the stored link itself only with no server running", () =>
      Effect.gen(function* () {
        const { linkKept } = yield* runConnect(deadPid, { portFreed: true, failUnlink: false });

        assert.isFalse(linkKept);
      }),
    );

    it.effect("leaves the link to a running server that didn't unlink", () =>
      Effect.gen(function* () {
        const { requests, linkKept } = yield* runConnect(process.pid, { failUnlink: true });

        assert.include(requests, "POST /api/connect/unlink");
        // regression: the CLI cleared the link itself, under the running server's relay.
        assert.isTrue(linkKept);
      }),
    );
    // SCIENT-FORK:END

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(printed, "Scient Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid, { command: "status" });

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status asks a running server to check reachability", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(process.pid, { command: "status" });

        assert.deepEqual(requests, ["POST /api/connect/reachability"]);
      }),
    );

    it.effect("status checks reachability for an environment linked from the app", () =>
      Effect.gen(function* () {
        const { requests, printed } = yield* runConnect(process.pid, {
          command: "status",
          linkedByApp: true,
        });

        assert.deepEqual(requests, ["POST /api/connect/reachability"]);
        assert.notInclude(printed, "Exposure: disabled");
        assert.notInclude(printed, "Authorization: missing");
        assert.notInclude(printed, "Next:");
      }),
    );

    it.effect("status does not report a publish-only link as exposed", () =>
      Effect.gen(function* () {
        const { printed } = yield* runConnect(process.pid, {
          command: "status",
          linkMode: "publish_only",
        });

        assert.include(printed, "Exposure: publish-only");
        assert.notInclude(printed, "Other devices can reach this machine");
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runConnect(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "Scient Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect link next step",
  (it) => {
    it.effect("tells the user to restart a server that is already running, not to start one", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-link-test-" });
        const relayClientPath = `${baseDir}/bin/cloudflared`;
        yield* fs.makeDirectory(`${baseDir}/bin`, { recursive: true });
        yield* fs.writeFileString(
          relayClientPath,
          `#!/bin/sh\necho "cloudflared version ${RelayClient.CLOUDFLARED_VERSION}"\n`,
        );
        yield* fs.chmod(relayClientPath, 0o755);
        yield* fs.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
        yield* fs.writeFileString(
          `${baseDir}/userdata/secrets/cloud-cli-oauth-token.bin`,
          JSON.stringify({
            accessToken: "access",
            refreshToken: "refresh",
            expiresAtEpochMs: 4_102_444_800_000,
            identity: "user@example.com",
          }),
        );
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3773,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: process.pid },
        });

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          "link",
          "--headless",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3CODE_CLOUDFLARED_PATH: relayClientPath } }),
            ),
          ),
        );

        const printed = (yield* TestConsole.logLines).join("\n");
        // SCIENT-FORK:START — Scient's hints are plain command strings.
        const restart = yield* resolveCliCommand(["service", "restart", "--base-dir", baseDir]);
        const serve = yield* resolveCliCommand(["serve", "--base-dir", baseDir]);
        assert.include(printed, "✓ Authorized as user@example.com");
        assert.include(printed, `\`${restart}\``);
        assert.notInclude(printed, `\`${serve}\``);
        // SCIENT-FORK:END
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(Layer.fresh(TestConsole.layer)),
      ),
    );
  },
);
