import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, VcsProcessExitError } from "@t3tools/contracts";
import type {
  SourceControlCredential,
  SourceControlCredentials,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as ScientCredentials from "./scientCredentials.ts";

const held = (token: string, source: GitHubCredentials.GitHubCredentialSource) => ({
  token: Redacted.make(token),
  fingerprint: `fp:${token}`,
  source,
});

interface World {
  /** What Source Control's own order picks, one answer per call; the last repeats. */
  effective: Array<
    GitHubRequestPolicy.GitHubHeldCredential | "signed-out" | "cli-missing" | "cli-failed"
  >;
  app: GitHubRequestPolicy.GitHubHeldCredential | null;
  /** `gh auth token --user <login>` answers. */
  cli: Record<string, string>;
  /** Login GitHub reports per token; absent means GitHub refuses the token. */
  logins: Record<string, string>;
  viewerReads: number;
  invalidated: Array<string>;
}

function harness(world: Partial<World>) {
  const state: World = {
    effective: [],
    app: null,
    cli: {},
    logins: {},
    viewerReads: 0,
    invalidated: [],
    ...world,
  };
  const api = Layer.mock(GitHubRest.GitHubRest)({
    credential: (host) =>
      Effect.suspend(
        (): Effect.Effect<
          GitHubRequestPolicy.GitHubHeldCredential,
          GitHubRequestPolicy.GitHubApiError
        > => {
          const next = state.effective.length > 1 ? state.effective.shift()! : state.effective[0];
          if (next === undefined || next === "signed-out")
            return Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
          if (next === "cli-missing")
            return Effect.fail(new GitHubCredentials.GitHubCliMissingError({ host }));
          if (next === "cli-failed")
            return Effect.fail(
              new GitHubCredentials.GitHubCliFailedError({
                host,
                cause: new Error("keyring said ghp_leakedTokenValue123"),
              }),
            );
          return Effect.succeed(next);
        },
      ),
    appCredential: () => Effect.succeed(Option.fromNullishOr(state.app)),
    rest: (input) =>
      Effect.gen(function* () {
        const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
        state.viewerReads++;
        const login = state.logins[Redacted.value(pinned!.token)];
        if (login === undefined) {
          return yield* new GitHubRequestPolicy.GitHubApiAuthenticationError({
            host: input.host,
            operation: input.operation,
          });
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ login }),
          truncated: false,
          invalidUtf8: false,
        };
      }),
  });
  const appSignIn = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
    enabled: true,
    invalidate: (_host, rejected) => Effect.sync(() => state.invalidated.push(`app:${rejected}`)),
  });
  const credentials = Layer.mock(GitHubCredentials.GitHubCredentials)({
    fingerprint: (_host, token) => Effect.succeed(`fp:${token}`),
    invalidate: () => Effect.sync(() => state.invalidated.push("cli")),
  });
  const host = TestSourceControlHost.layer({
    process: {
      run: (input) => {
        const token = state.cli[input.args[input.args.indexOf("--user") + 1] ?? ""];
        return token === undefined
          ? Effect.fail(
              new VcsProcessExitError({
                operation: input.operation,
                command: "gh",
                cwd: input.cwd,
                exitCode: 1,
                detail: "no oauth token",
              }),
            )
          : Effect.succeed(TestSourceControlHost.processOutput(`${token}\n`));
      },
    },
  });
  return {
    state,
    run: <A, E>(use: (bridge: SourceControlCredentials) => Effect.Effect<A, E>) =>
      ScientCredentials.make.pipe(
        Effect.flatMap(use),
        Effect.provide(Layer.mergeAll(api, appSignIn, credentials, host)),
      ),
  };
}

const loginAndVia = (credential: Option.Option<SourceControlCredential>) =>
  Option.map(credential, ({ login, via, token }) => ({ login, via, token: Redacted.value(token) }));

describe("Source Control's credential for the GitHub connector", () => {
  it.effect(
    "lends Source Control's choice with the login GitHub reports, asking once per token",
    () => {
      const { state, run } = harness({
        effective: [held("ghu_app_token", "app")],
        logins: { ghu_app_token: "Octo" },
      });
      return run((bridge) =>
        Effect.gen(function* () {
          const first = yield* bridge.get("GitHub.com");
          const pinned = yield* bridge.get("github.com", { account: "octo" });
          expect(loginAndVia(first)).toEqual(
            Option.some({ login: "Octo", via: "app", token: "ghu_app_token" }),
          );
          expect(loginAndVia(pinned)).toEqual(loginAndVia(first));
          expect(state.viewerReads).toBe(1);
        }),
      );
    },
  );

  it.effect("lends only the chosen account, never Source Control's other one", () => {
    const { run } = harness({
      effective: [held("gho_bob", "gh")],
      cli: { alice: "gho_alice" },
      logins: { gho_bob: "bob", gho_alice: "alice" },
    });
    return run((bridge) =>
      Effect.gen(function* () {
        expect(loginAndVia(yield* bridge.get("github.com", { account: "alice" }))).toEqual(
          Option.some({ login: "alice", via: "cli", token: "gho_alice" }),
        );
        expect(yield* bridge.get("github.com", { account: "carol" })).toEqual(Option.none());
      }),
    );
  });

  it.effect("looks once more after GitHub refuses a revoked token", () => {
    const { run } = harness({
      effective: [held("ghu_revoked", "app"), held("gho_cli", "gh")],
      logins: { gho_cli: "octo" },
    });
    return run((bridge) =>
      Effect.gen(function* () {
        expect(loginAndVia(yield* bridge.get("github.com", { account: "octo" }))).toEqual(
          Option.some({ login: "octo", via: "cli", token: "gho_cli" }),
        );
      }),
    );
  });

  it.effect(
    "has nothing to lend without gh or a sign-in, and fails without the source's words",
    () => {
      const signedOut = harness({ effective: ["cli-missing"] });
      const failing = harness({ effective: ["cli-failed"] });
      return Effect.gen(function* () {
        expect(yield* signedOut.run((bridge) => bridge.get("github.com"))).toEqual(Option.none());
        const error = yield* failing.run((bridge) => Effect.flip(bridge.get("github.com")));
        expect(error._tag).toBe("SourceControlCredentialError");
        expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(
          "ghp_leakedTokenValue123",
        );
      });
    },
  );

  it.effect.each([
    ["app", ["app:ghu_refused"]],
    ["token", []],
  ] as const)("a refused %s credential is forgotten only by its own source", ([via, expected]) => {
    const { state, run } = harness({});
    return run((bridge) =>
      bridge.invalidate("github.com", {
        token: Redacted.make("ghu_refused"),
        via,
        login: "octo",
      }),
    ).pipe(Effect.andThen(Effect.sync(() => expect(state.invalidated).toEqual(expected))));
  });
});

/**
 * The real request policy, credential cache and app sign-in over a fake GitHub and a fake `gh`;
 * GitHub answers `/user` with the login each token belongs to.
 */
function realStack(options: {
  readonly logins: Record<string, string>;
  readonly session?: Record<string, unknown>;
  readonly savedToken?: string;
  /** `gh auth token` answers, one per run; the last repeats. Empty: no gh login. */
  readonly gh?: Array<string>;
  /** Answers the refresh grant; GitHub rotates both tokens. */
  readonly refresh?: Record<string, unknown>;
  readonly installations?: ReadonlyArray<unknown>;
}) {
  const seen = { refreshes: 0, ghRuns: 0, tokens: [] as Array<string> };
  const gh = [...(options.gh ?? [])];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const token = request.headers["authorization"]?.replace(/^Bearer /, "") ?? "";
      const reply = (status: number, body: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      if (path === "/login/oauth/access_token") {
        seen.refreshes++;
        return reply(200, options.refresh ?? { error: "bad_refresh_token" });
      }
      seen.tokens.push(token);
      if (path === "/user/installations") {
        return reply(200, { installations: options.installations ?? [] });
      }
      const login = options.logins[token];
      return login === undefined ? reply(401, {}) : reply(200, { login });
    }),
  );
  const host = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: {
          signIns:
            options.session === undefined
              ? {}
              : {
                  "github.com": JSON.stringify({
                    accessToken: "ghu_current",
                    accessTokenExpiresAt: 8 * HOUR,
                    refreshToken: "ghr_current",
                    refreshTokenExpiresAt: 4_000 * HOUR,
                    ...options.session,
                  }),
                },
          tokens: options.savedToken === undefined ? {} : { "github.com": options.savedToken },
        },
      },
    }),
    process: {
      run: () =>
        Effect.sync(() => {
          seen.ghRuns++;
          const token = gh.length > 1 ? gh.shift()! : (gh[0] ?? "");
          return TestSourceControlHost.processOutput(`${token}\n`);
        }),
    },
  });
  const layer = GitHubAppAccess.layer.pipe(
    Layer.provideMerge(GitHubRest.layerWithDependencies),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(host),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return {
    seen,
    run: <A, E>(
      use: (
        bridge: SourceControlCredentials,
      ) => Effect.Effect<A, E, GitHubRest.GitHubRest | GitHubAppAccess.GitHubAppAccess>,
    ) => ScientCredentials.make.pipe(Effect.flatMap(use), Effect.provide(layer)),
  };
}

const HOUR = 3_600_000;
const lentAs = (credential: Option.Option<SourceControlCredential>) =>
  Option.map(credential, ({ via, token }) => `${via}:${Redacted.value(token)}`);

describe("Source Control's credential over the real request stack", () => {
  beforeEach(() => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(name, "");
    vi.stubEnv(GitHubAppSignIn.CLIENT_ID_VARIABLE, "Iv-test-client");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const logins = {
    "saved-pat-0000": "octo",
    ghu_current: "octo",
    ghu_refreshed: "octo",
    "env-token-0000": "octo",
    gho_cli_token_1: "octo",
    gho_cli_token_2: "octo",
  };

  it.effect.each([
    [
      "a saved token",
      { savedToken: "saved-pat-0000", session: {}, env: true },
      "token:saved-pat-0000",
    ],
    ["the app sign-in", { session: {}, env: true }, "app:ghu_current"],
    ["GH_TOKEN", { env: true }, "token:env-token-0000"],
    ["gh", {}, "cli:gho_cli_token_1"],
  ] as const)("lends %s first, as Source Control orders them", ([, setup, expected]) => {
    if ("env" in setup) vi.stubEnv("GH_TOKEN", "env-token-0000");
    const stack = realStack({
      logins,
      gh: ["gho_cli_token_1"],
      ...("session" in setup ? { session: setup.session } : {}),
      ...("savedToken" in setup ? { savedToken: setup.savedToken } : {}),
    });
    return stack
      .run((bridge) => bridge.get("github.com", { account: "octo" }))
      .pipe(Effect.map((lent) => expect(lentAs(lent)).toEqual(Option.some(expected))));
  });

  const refreshed = {
    access_token: "ghu_refreshed",
    expires_in: 28_800,
    refresh_token: "ghr_refreshed",
    refresh_token_expires_in: 15_897_600,
  };

  it.effect("shares one refresh between a REST call and the connector", () => {
    const stack = realStack({
      logins,
      session: { accessTokenExpiresAt: 3 * 60_000 },
      refresh: refreshed,
    });
    return stack.run((bridge) =>
      Effect.gen(function* () {
        const api = yield* GitHubRest.GitHubRest;
        const [, lent] = yield* Effect.all(
          [
            api.rest({ host: "github.com", operation: "test", path: "user" }),
            bridge.get("github.com"),
          ],
          { concurrency: "unbounded" },
        );
        expect(lentAs(lent)).toEqual(Option.some("app:ghu_refreshed"));
        expect(stack.seen.refreshes).toBe(1);
        expect(new Set(stack.seen.tokens)).toEqual(new Set(["ghu_refreshed"]));
      }),
    );
  });

  it.effect("ignores a late 401 for the token a refresh already replaced", () => {
    const stack = realStack({ logins, session: {}, refresh: refreshed });
    return stack.run((bridge) =>
      Effect.gen(function* () {
        const old = Option.getOrThrow(yield* bridge.get("github.com"));
        yield* bridge.invalidate("github.com", old);
        expect(lentAs(yield* bridge.get("github.com"))).toEqual(Option.some("app:ghu_refreshed"));
        // The second refusal of the old token arrives after the refresh.
        yield* bridge.invalidate("github.com", old);
        expect(lentAs(yield* bridge.get("github.com"))).toEqual(Option.some("app:ghu_refreshed"));
        expect(stack.seen.refreshes).toBe(1);
      }),
    );
  });

  it.effect("ignores a late 401 for a gh token gh has since replaced", () => {
    const stack = realStack({ logins, gh: ["gho_cli_token_1", "gho_cli_token_2"] });
    return stack.run((bridge) =>
      Effect.gen(function* () {
        const old = Option.getOrThrow(yield* bridge.get("github.com"));
        yield* bridge.invalidate("github.com", old);
        expect(lentAs(yield* bridge.get("github.com"))).toEqual(Option.some("cli:gho_cli_token_2"));
        const runs = stack.seen.ghRuns;
        yield* bridge.invalidate("github.com", old);
        expect(lentAs(yield* bridge.get("github.com"))).toEqual(Option.some("cli:gho_cli_token_2"));
        expect(stack.seen.ghRuns).toBe(runs);
      }),
    );
  });

  it.effect("has nothing for the account once GitHub revokes the app's refresh grant", () => {
    const stack = realStack({
      logins: { ...logins, gho_cli_token_1: "someone-else" },
      session: { accessTokenExpiresAt: 0 },
      gh: ["gho_cli_token_1"],
    });
    return stack.run((bridge) =>
      Effect.gen(function* () {
        expect(yield* bridge.get("github.com", { account: "octo" })).toEqual(Option.none());
        expect(stack.seen.refreshes).toBe(1);
      }),
    );
  });

  it.effect(
    "lends the app sign-in where no organization installed it, which reaches nothing there",
    () => {
      const stack = realStack({ logins, session: {} });
      return stack.run((bridge) =>
        Effect.gen(function* () {
          expect(lentAs(yield* bridge.get("github.com"))).toEqual(Option.some("app:ghu_current"));
          const access = yield* GitHubAppAccess.GitHubAppAccess;
          expect(yield* access.reach("github.com", "acme/private")).toBe("not-covered");
        }),
      );
    },
  );
});
