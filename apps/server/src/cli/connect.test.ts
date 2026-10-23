import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";

import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TestConsole from "effect/testing/TestConsole";

import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { acquireRelayClientForLink, reportServiceOnboarding } from "./connect.ts";
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
        NodeServices.layer,
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
