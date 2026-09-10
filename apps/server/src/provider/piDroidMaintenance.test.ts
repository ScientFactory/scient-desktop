import { expect, it } from "@effect/vitest";
import {
  DROID_LATEST_VERSION_URL,
  parseDroidReleaseVersion,
} from "@scientfactory/provider-runtime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  type ProviderMaintenanceResolutionContext,
} from "./providerMaintenance.ts";
import { droidMaintenance, piMaintenance, withDroidReleaseVersion } from "./piDroidMaintenance.ts";

const context = (path: string): ProviderMaintenanceResolutionContext => ({
  binaryPath: path,
  resolvedCommandPath: path,
  realCommandPath: path,
  env: { HOME: "/home/test", PATH: "" },
  platform: "linux",
});

it.layer(NodeServices.layer)("Pi/Droid maintenance", (it) => {
  it.effect("uses the owning Pi npm prefix without updating extensions", () =>
    Effect.gen(function* () {
      const result = yield* piMaintenance.resolve(
        context("/opt/custom/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      );
      expect(result.update?.executable).toBe("npm");
      expect(result.update?.args).toContain("/opt/custom");
      expect(result.update?.args).toContain("@earendil-works/pi-coding-agent@latest");
    }),
  );
  it.effect("does not silently migrate a legacy Pi package", () =>
    Effect.gen(function* () {
      const result = yield* piMaintenance.resolve(
        context("/opt/custom/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"),
      );
      expect(result.packageName).toBe("@earendil-works/pi-coding-agent");
      expect(result.update).toBeNull();
    }),
  );
  it.effect("leaves unknown Pi installations manual-only", () =>
    Effect.gen(function* () {
      expect((yield* piMaintenance.resolve(context("/tools/pi"))).update).toBeNull();
      expect((yield* piMaintenance.resolve(null)).update).toBeNull();
    }),
  );
  it.effect("updates a standalone Droid at its exact installation path", () =>
    Effect.gen(function* () {
      const result = yield* droidMaintenance.resolve(context("/home/test/.local/bin/droid"));
      expect(result.update).toMatchObject({
        executable: "/home/test/.local/bin/droid",
        args: ["update"],
      });
      expect(result.update?.env?.FACTORY_DROID_AUTO_UPDATE_ENABLED).toBeUndefined();
      expect(result.packageName).toBeNull();
    }),
  );
  it.effect("respects an explicit native-update restriction", () =>
    Effect.gen(function* () {
      const input = context("/home/test/.local/bin/droid");
      expect(
        (yield* droidMaintenance.resolve({
          ...input,
          env: { ...input.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
        })).update,
      ).toBeNull();
    }),
  );
  it.effect("uses npm rather than the native updater behind a symlink", () =>
    Effect.gen(function* () {
      const result = yield* droidMaintenance.resolve({
        ...context("/home/test/.local/bin/droid"),
        realCommandPath: "/opt/node/lib/node_modules/droid/bin/droid",
      });
      expect(result.update?.executable).toBe("npm");
      expect(result.update?.args).toContain("droid@latest");
    }),
  );
  it.effect("does not self-update unknown paths or symlink targets", () =>
    Effect.gen(function* () {
      for (const input of [
        context("/another/.local/bin/droid"),
        { ...context("/home/test/.local/bin/droid"), realCommandPath: "/tools/droid" },
      ]) {
        expect((yield* droidMaintenance.resolve(input)).update).toBeNull();
      }
    }),
  );
  it.effect("fetches and caches the native release channel only when enabled", () =>
    Effect.gen(function* () {
      const capabilities = yield* droidMaintenance.resolve(context("/home/test/.local/bin/droid"));
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests++;
        expect(request.url).toBe(DROID_LATEST_VERSION_URL);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("0.214.0\n")));
      });
      yield* Effect.gen(function* () {
        yield* withDroidReleaseVersion(capabilities, false);
        expect(requests).toBe(0);
        expect((yield* withDroidReleaseVersion(capabilities, true)).latestVersion).toBe("0.214.0");
        const verified = yield* withDroidReleaseVersion(capabilities, true);
        expect(
          createProviderVersionAdvisory({
            driver: capabilities.provider,
            currentVersion: "0.213.0",
            maintenanceCapabilities: verified,
            latestVersion: verified.latestVersion ?? null,
          }).status,
        ).toBe("behind_latest");
        expect((yield* withDroidReleaseVersion(capabilities, true)).latestVersion).toBe("0.214.0");
        expect(requests).toBe(1);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );
    }),
  );
  it.effect("treats a failed release lookup as unknown without losing the update action", () =>
    Effect.gen(function* () {
      const capabilities = yield* droidMaintenance.resolve(context("/home/test/.local/bin/droid"));
      const result = yield* withDroidReleaseVersion(capabilities, true).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
            ),
          ),
        ),
        Effect.provideService(ProviderVersionCache, new Map()),
      );
      expect(result.latestVersion).toBeNull();
      expect(result.update).toEqual(capabilities.update);
    }),
  );
});

it("accepts only a single stable Droid release version", () => {
  expect(parseDroidReleaseVersion("0.214.0\n")).toBe("0.214.0");
  for (const invalid of [
    "",
    "latest",
    "0.214",
    "01.2.3",
    "0.214.0-beta.1",
    "0.214.0\n0.215.0",
    "<title>App v99.0.0</title>",
  ]) {
    expect(parseDroidReleaseVersion(invalid)).toBeNull();
  }
});
