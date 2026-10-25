import { assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  formatServiceStatus as formatStatus,
  offerServiceDuringOnboarding,
  recoverServiceOnboardingOffer,
  serviceCommand,
} from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const repairCommand = "/resolved/scient service update --base-dir /profile";
const formatServiceStatus = (status: BootService.BootServiceStatus, version: string) =>
  formatStatus(status, version, repairCommand);

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/scient.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "Scient service",
      "  Status: installed · t3@0.0.29",
      "  Unit: /home/me/.config/systemd/user/scient.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `/resolved/scient service update --base-dir /profile`.",
  );
});

it("explains an incomplete nightly installation and keeps repair on its installed version", () => {
  const output = formatServiceStatus(
    {
      ...status,
      current: false,
      installedVersion: "0.0.32-nightly.1",
      problems: ["linger-disabled", "service-stopped"],
    },
    "0.0.32-nightly.1",
  );

  expect(output).toContain("[linger-disabled]");
  expect(output).toContain("last login session ends");
  expect(output).toContain('sudo loginctl enable-linger "$(id -un)"');
  expect(output).toContain("[service-stopped]");
  expect(output).toContain(repairCommand);
  expect(output).not.toContain("npx");
  expect(output).not.toContain("t3@latest");
});

it("suggests the newer CLI version when the installed service needs an update", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.28" },
    "0.0.29",
  );
  expect(output).toContain(repairCommand);
  expect(output).not.toContain("npx t3@0.0.28 service update");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it("reports a newer installed service and gives an exact-version repair command", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );

  assert.include(output, "t3@0.0.32-nightly.1 (newer than this t3@0.0.31 CLI)");
  assert.include(output, "Use a Scient CLI matching t3@0.0.32-nightly.1 to repair it");
  assert.notInclude(output, "npx");
  assert.notInclude(output, "npx t3@latest service update");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(
  serviceStatus: BootService.BootServiceStatus,
  restartOutcome: "restarted" | "queued" = "restarted",
) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const restarts: boolean[] = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    withStopped: (operation) => operation,
    restart: Effect.sync(() => {
      restarts.push(true);
      return serviceStatus.installed ? restartOutcome : "skipped";
    }),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          nodePath: "/test/node",
          launcherPath: "/test/service-launcher.mjs",
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions, restarts };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect("restart from inside the service says the restart is only queued", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service } = makeTestService({ ...status, installedVersion: "0.0.30" }, "queued");
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );
      const lines: Array<string> = [];
      const testConsole = {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => {
          lines.push(args.map(String).join(" "));
        },
      } satisfies Console.Console;

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "restart",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(Console.Console, testConsole),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      const output = lines.join("\n");
      expect(output).not.toContain("Restarted");
      expect(output).toContain("Queued a restart of the Scient service on t3@0.0.30");
      expect(output).toContain(`Logs: ${status.logPath}`);
    }),
  );

  it.effect("install reports a handed-off switch as pending", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service } = makeTestService({ ...status, current: false });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, {
          ...service,
          install: (options) =>
            service.install(options).pipe(Effect.map((plan) => ({ ...plan, handedOff: true }))),
        }),
      );
      const lines: string[] = [];
      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "install",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args) => {
            lines.push(args.map(String).join(" "));
          },
        }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      const output = lines.join("\n");
      expect(output).not.toMatch(/(?:Installed|Updated) Scient service/);
      expect(output).toContain("separate systemd unit");
      expect(output).toContain(status.logPath);
    }),
  );

  it.effect.each(["install", "update"] as const)(
    "%s refuses a downgrade before changing the service",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(newerServiceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        });
        expect(installOptions).toEqual([]);
      }),
  );

  // regression: #13239 a stale nvm-installed CLI reported "already using" its own version
  it.effect.each(["install", "update"] as const)(
    "%s names the CLI that found nothing to change",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(status);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );
        const node = "/home/me/.nvm/versions/node/v26.8.2/bin/node";
        const script = "/home/me/.nvm/versions/node/v26.8.2/lib/node_modules/t3/dist/bin.mjs";

        const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.andThen(TestConsole.logLines),
          Effect.map((lines) => lines.join("\n")),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, node),
          Effect.provideService(HostProcess.Arguments, [node, script, "service", command]),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        );
        expect(output).toContain(`t3@${packageJson.version}`);
        expect(output).toContain(script);
        expect(installOptions).toEqual([]);
      }),
  );
});

it.effect("leaves a newer service unchanged during onboarding without prompting", () =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(newerServiceStatus);
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("Onboarding must not prompt to replace a newer service."),
      readLine: Effect.die("Onboarding must not prompt to replace a newer service."),
      display: () => Effect.die("Onboarding must not prompt to replace a newer service."),
    });

    const ready = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(NodeServices.layer),
    );

    expect(ready).toBe("skipped");
    expect(installOptions).toEqual([]);
  }),
);

// regression: #9602 diagnose incomplete headless server setup
it.effect("keeps the manual-server fallback when background prerequisites fail", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" })),
    );
    expect(ready).toBe("skipped");
  }),
);
