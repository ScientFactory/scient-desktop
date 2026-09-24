import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  type ProviderMaintenanceResolutionContext,
} from "../providerMaintenance.ts";
import {
  OMP_LATEST_RELEASE_URL,
  OMP_NPM_PACKAGE,
  ompMaintenance,
  parseOmpReleaseVersion,
  withOmpReleaseVersion,
} from "./OmpMaintenance.ts";

const context = (path: string): ProviderMaintenanceResolutionContext => ({
  binaryPath: path,
  resolvedCommandPath: path,
  realCommandPath: path,
  env: { HOME: "/home/test", PATH: "" },
  platform: "linux",
});

it.effect("parses Oh My Pi release tags", () =>
  Effect.sync(() => {
    expect(parseOmpReleaseVersion("v18.2.8")).toBe("18.2.8");
    expect(parseOmpReleaseVersion('{"tag_name":"v18.3.0"}')).toBe("18.3.0");
    expect(parseOmpReleaseVersion('{"tag_name":"nightly"}')).toBeNull();
  }),
);

it.layer(NodeServices.layer)("Oh My Pi update discovery", (it) => {
  it.effect("offers a Bun global update for the official package", () =>
    Effect.gen(function* () {
      const result = yield* ompMaintenance.resolve(context("/home/test/.bun/bin/omp"));
      expect(result.packageName).toBe(OMP_NPM_PACKAGE);
      expect(result.update).toMatchObject({
        executable: "bun",
        args: ["i", "-g", `${OMP_NPM_PACKAGE}@latest`],
        lockKey: "bun-global",
      });
    }),
  );

  it.effect("offers an npm update only for the global package prefix", () =>
    Effect.gen(function* () {
      const result = yield* ompMaintenance.resolve(
        context("/opt/omp/lib/node_modules/@oh-my-pi/pi-coding-agent/bin/omp"),
      );
      expect(result.update?.executable).toBe("npm");
      expect(result.update?.args).toContain("/opt/omp");
      expect(result.update?.args).toContain(`${OMP_NPM_PACKAGE}@latest`);
    }),
  );

  it.effect("leaves a release binary and a missing install without an update command", () =>
    Effect.gen(function* () {
      const binary = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      const missing = yield* ompMaintenance.resolve(null);
      expect(binary.update).toBeNull();
      expect(binary.packageName).toBeNull();
      expect(missing.update).toBeNull();
      expect(missing.packageName).toBeNull();
    }),
  );

  it.effect("reads the GitHub release only for discovery-only installs", () =>
    Effect.gen(function* () {
      const binary = yield* ompMaintenance.resolve(context("/usr/local/bin/omp"));
      const bun = yield* ompMaintenance.resolve(context("/home/test/.bun/bin/omp"));
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests += 1;
        expect(request.url).toBe(OMP_LATEST_RELEASE_URL);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"tag_name":"v18.3.1"}\n')),
        );
      });
      yield* Effect.gen(function* () {
        expect((yield* withOmpReleaseVersion(binary, false)).latestVersion).toBeUndefined();
        expect(requests).toBe(0);
        const discovered = yield* withOmpReleaseVersion(binary, true);
        expect(discovered.latestVersion).toBe("18.3.1");
        expect(discovered.update).toBeNull();
        expect(
          createProviderVersionAdvisory({
            driver: discovered.provider,
            currentVersion: "18.2.8",
            latestVersion: discovered.latestVersion ?? null,
            maintenanceCapabilities: discovered,
          }).status,
        ).toBe("behind_latest");
        expect((yield* withOmpReleaseVersion(binary, true)).latestVersion).toBe("18.3.1");
        expect((yield* withOmpReleaseVersion(bun, true)).latestVersion).toBeUndefined();
        expect(requests).toBe(1);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );
    }),
  );
});
