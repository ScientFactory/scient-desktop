import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  ProviderVersionCache,
  type ProviderMaintenanceResolutionContext,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  classifyOmpInstallation,
  OMP_HOMEBREW_FORMULA_URL,
  OMP_LATEST_RELEASE_URL,
  OMP_NPM_LATEST_URL,
  ompMaintenance,
  parseOmpFormulaVersion,
  parseOmpReleaseVersion,
  resolveOmpLatestVersion,
  shapeOmpVersionAdvisory,
  type OmpInstallation,
} from "./OmpMaintenance.ts";

const context = (
  realCommandPath: string,
  resolvedCommandPath = realCommandPath,
): ProviderMaintenanceResolutionContext => ({
  binaryPath: "omp",
  resolvedCommandPath,
  realCommandPath,
  env: { HOME: "/home/test", PATH: "" },
  platform: "linux",
});

const installation = (realCommandPath: string, resolvedCommandPath = realCommandPath) =>
  classifyOmpInstallation(context(realCommandPath, resolvedCommandPath));

/** Serves each URL from a table; a missing entry is a network failure. */
const httpClient = (responses: Readonly<Record<string, () => Response>>, requests: string[]) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const respond = responses[request.url];
    return respond
      ? Effect.succeed(HttpClientResponse.fromWeb(request, respond()))
      : Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        );
  });

const lookup = (
  target: OmpInstallation,
  responses: Readonly<Record<string, () => Response>>,
  requests: string[],
  cache: Map<string, { readonly expiresAt: number; readonly version: string | null }>,
) =>
  resolveOmpLatestVersion(target).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient(responses, requests)),
    Effect.provideService(ProviderVersionCache, cache),
  );

describe("Oh My Pi installation channels", () => {
  it("classifies each install channel from the executable's real path", () => {
    expect(installation("/usr/local/bin/omp").channel).toBe("package");
    expect(
      installation(
        "/home/test/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
        "/home/test/.bun/bin/omp",
      ).channel,
    ).toBe("package");
    expect(installation("/opt/homebrew/Cellar/omp/18.3.1/bin/omp").channel).toBe("homebrew");
    // A different formula's keg is not Oh My Pi's tap.
    expect(installation("/opt/homebrew/Cellar/other/18.3.1/bin/omp").channel).toBe("package");
    expect(installation("/nix/store/abc123-omp-18.3.1/bin/omp").channel).toBe("nix");
    expect(
      installation("/home/test/.local/share/mise/installs/github-can1357-oh-my-pi/18.3.1/omp")
        .channel,
    ).toBe("mise");
    expect(
      installation(
        "/opt/homebrew/Cellar/mise/2026.9.1/bin/mise",
        "/home/test/.local/share/mise/shims/omp",
      ).channel,
    ).toBe("mise");
    expect(
      installation("/home/test/.scient-next/provider-runtimes/omp/versions/18.2.8/darwin-arm64/omp")
        .channel,
    ).toBe("managed");
  });

  it.effect("never offers a native or package-manager update action", () =>
    Effect.gen(function* () {
      for (const path of [
        "/usr/local/bin/omp",
        "/home/test/.bun/bin/omp",
        "/opt/homebrew/Cellar/omp/18.3.1/bin/omp",
        "/home/test/.local/share/mise/installs/github-can1357-oh-my-pi/18.3.1/omp",
        "/home/test/.scient-next/provider-runtimes/omp/versions/18.2.8/darwin-arm64/omp",
      ]) {
        const capabilities = yield* ompMaintenance
          .resolve(context(path))
          .pipe(Effect.provide(NodeServices.layer));
        expect(capabilities.update).toBeNull();
        expect(capabilities.packageName).toBeNull();
      }
      expect(
        (yield* ompMaintenance.resolve(null).pipe(Effect.provide(NodeServices.layer))).update,
      ).toBeNull();
    }),
  );
});

describe("Oh My Pi latest release lookup", () => {
  it("parses release tags and the tap formula", () => {
    expect(parseOmpReleaseVersion("v18.2.8")).toBe("18.2.8");
    expect(parseOmpReleaseVersion('{"tag_name":"v18.3.0"}')).toBe("18.3.0");
    expect(parseOmpReleaseVersion('{"tag_name":"nightly"}')).toBeNull();
    expect(parseOmpReleaseVersion("18.3.0-beta.1")).toBeNull();
    expect(
      parseOmpFormulaVersion(
        'class Omp < Formula\n  desc "x"\n  version "18.3.2"\n  license "MIT"\n',
      ),
    ).toBe("18.3.2");
    expect(parseOmpFormulaVersion('class Omp < Formula\n  version "18.4.0-rc.1"\n')).toBeNull();
    expect(parseOmpFormulaVersion("not ruby")).toBeNull();
  });

  it.effect("reads npm latest for package-manager and standalone installs", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const version = yield* lookup(
        installation("/usr/local/bin/omp"),
        { [OMP_NPM_LATEST_URL]: () => Response.json({ version: "18.3.2" }) },
        requests,
        new Map(),
      );
      expect(version).toBe("18.3.2");
      expect(requests).toEqual([OMP_NPM_LATEST_URL]);
    }),
  );

  it.effect("reads the can1357/tap formula for Homebrew installs", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const version = yield* lookup(
        installation("/opt/homebrew/Cellar/omp/18.2.8/bin/omp"),
        { [OMP_HOMEBREW_FORMULA_URL]: () => new Response('  version "18.3.1"\n') },
        requests,
        new Map(),
      );
      expect(version).toBe("18.3.1");
      expect(requests).toEqual([OMP_HOMEBREW_FORMULA_URL]);
    }),
  );

  it.effect("falls back to the GitHub release, and never checks Nix or managed installs", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const github = { [OMP_LATEST_RELEASE_URL]: () => Response.json({ tag_name: "v18.3.1" }) };
      expect(yield* lookup(installation("/usr/local/bin/omp"), github, requests, new Map())).toBe(
        "18.3.1",
      );
      expect(requests).toEqual([OMP_NPM_LATEST_URL, OMP_LATEST_RELEASE_URL]);
      requests.length = 0;
      expect(
        yield* lookup(
          installation("/home/test/.local/share/mise/installs/github-can1357-oh-my-pi/18.2.8/omp"),
          github,
          requests,
          new Map(),
        ),
      ).toBe("18.3.1");
      expect(requests).toEqual([OMP_LATEST_RELEASE_URL]);
      requests.length = 0;
      expect(
        yield* lookup(installation("/nix/store/abc-omp/bin/omp"), github, requests, new Map()),
      ).toBeNull();
      expect(
        yield* lookup(
          installation("/home/test/.scient-next/provider-runtimes/omp/versions/18.2.8/x/omp"),
          github,
          requests,
          new Map(),
        ),
      ).toBeNull();
      expect(requests).toEqual([]);
    }),
  );

  it.effect("caches a successful answer but never a failed lookup", () =>
    Effect.gen(function* () {
      const cache = new Map<
        string,
        { readonly expiresAt: number; readonly version: string | null }
      >();
      const requests: string[] = [];
      const target = installation("/usr/local/bin/omp");
      expect(yield* lookup(target, {}, requests, cache)).toBeNull();
      expect(yield* lookup(target, {}, requests, cache)).toBeNull();
      // Both failed attempts reached the network: nothing was cached.
      expect(requests).toEqual([
        OMP_NPM_LATEST_URL,
        OMP_LATEST_RELEASE_URL,
        OMP_NPM_LATEST_URL,
        OMP_LATEST_RELEASE_URL,
      ]);
      requests.length = 0;
      const online = { [OMP_NPM_LATEST_URL]: () => Response.json({ version: "18.3.2" }) };
      expect(yield* lookup(target, online, requests, cache)).toBe("18.3.2");
      expect(yield* lookup(target, {}, requests, cache)).toBe("18.3.2");
      expect(requests).toEqual([OMP_NPM_LATEST_URL]);
    }),
  );

  it.effect("treats an error status or a malformed body as a failed lookup", () =>
    Effect.gen(function* () {
      const cache = new Map<
        string,
        { readonly expiresAt: number; readonly version: string | null }
      >();
      const requests: string[] = [];
      const version = yield* lookup(
        installation("/usr/local/bin/omp"),
        {
          [OMP_NPM_LATEST_URL]: () => new Response("rate limited", { status: 429 }),
          [OMP_LATEST_RELEASE_URL]: () => Response.json({ tag_name: "nightly" }),
        },
        requests,
        cache,
      );
      expect(version).toBeNull();
      expect(cache.size).toBe(0);
    }),
  );
});

describe("Oh My Pi version advisory", () => {
  const standalone = installation("/usr/local/bin/omp");

  it("proposes only a newer stable release inside the supported major", () => {
    const advisory = shapeOmpVersionAdvisory({
      currentVersion: "18.2.8",
      latestVersion: "18.3.0",
      installation: standalone,
      managedAvailable: false,
      checkedAt: null,
    });
    expect(advisory).toMatchObject({
      status: "behind_latest",
      latestVersion: "18.3.0",
      canUpdate: false,
      updateCommand: "/usr/local/bin/omp update",
    });
    expect(advisory.message).toContain("/usr/local/bin/omp update");
    expect(advisory.message).not.toContain("Scient-managed");
    for (const [currentVersion, latestVersion] of [
      ["18.2.8", "19.0.0"],
      ["18.2.8", "18.4.0-beta.1"],
      ["18.3.0-beta.1", "18.3.0"],
      ["17.9.0", "18.3.0"],
      ["18.3.0", "18.3.0"],
      ["18.2.8", null],
    ] as const) {
      const shaped = shapeOmpVersionAdvisory({
        currentVersion,
        latestVersion,
        installation: standalone,
        managedAvailable: true,
        checkedAt: null,
      });
      expect(shaped.status, `${currentVersion} -> ${latestVersion}`).not.toBe("behind_latest");
      expect(shaped.canUpdate).toBe(false);
    }
  });

  it("names Scient-managed Oh My Pi when a managed artifact exists for the target", () => {
    const advisory = shapeOmpVersionAdvisory({
      currentVersion: "18.2.8",
      latestVersion: "18.3.0",
      installation: standalone,
      managedAvailable: true,
      checkedAt: null,
    });
    expect(advisory.message).toContain("/usr/local/bin/omp update");
    expect(advisory.message).toContain("Scient-managed");
  });

  it("offers no command where omp update does not own the install", () => {
    const advisory = shapeOmpVersionAdvisory({
      currentVersion: "18.2.8",
      latestVersion: "18.3.0",
      installation: installation("/nix/store/abc-omp/bin/omp"),
      managedAvailable: false,
      checkedAt: null,
    });
    expect(advisory.updateCommand).toBeNull();
    expect(advisory.canUpdate).toBe(false);
  });
});
