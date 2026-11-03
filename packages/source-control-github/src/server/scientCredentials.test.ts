import { describe, expect, it } from "@effect/vitest";
import { VcsProcessExitError } from "@t3tools/contracts";
import type {
  SourceControlCredential,
  SourceControlCredentials,
} from "@t3tools/source-control-core/server/driver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

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
    ["cli", ["cli"]],
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
