import {
  SourceControlCredentialError,
  type SourceControlCredential,
  type SourceControlCredentials,
} from "@t3tools/source-control-core/server/driver";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

type Held = GitHubRequestPolicy.GitHubHeldCredential;

const decodeViewer = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);
const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);
const MAX_LOGINS = 64;

const viaOf = (source: Held["source"]): SourceControlCredential["via"] =>
  source === "app" ? "app" : source === "gh" ? "cli" : "token";

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * Source Control's GitHub credential for Scient's connector. The login is the one GitHub reports
 * for the token, so a connector pinned to one account never receives another account's token.
 */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const process = (yield* SourceControlHost.SourceControlHost).process;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const logins = new Map<string, string>();

  /** `refused` when GitHub turned the token down; the request policy already told its source. */
  const loginOf = Effect.fn("ScientGitHubCredentials.loginOf")(function* (
    host: string,
    held: Held,
  ) {
    const known = logins.get(held.fingerprint);
    if (known !== undefined) return known;
    const response = yield* api
      .rest({ host, operation: "connectorViewer", path: "user", allowReserve: true })
      .pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host,
          token: held.token,
          credentialFingerprint: held.fingerprint,
          ...(held.source === undefined ? {} : { source: held.source }),
        }),
      );
    const { login } = yield* decodeViewer(response.body);
    if (logins.size >= MAX_LOGINS) logins.clear();
    logins.set(held.fingerprint, login);
    return login;
  });

  const check = (host: string, held: Option.Option<Held>) =>
    Option.isNone(held)
      ? Effect.succeed({ _tag: "none" } as const)
      : loginOf(host, held.value).pipe(
          Effect.map((login) => ({ _tag: "login", held: held.value, login }) as const),
          Effect.catchTags({
            GitHubApiAuthenticationError: () => Effect.succeed({ _tag: "refused" } as const),
          }),
        );

  const effective = (host: string) =>
    api.credential(host).pipe(
      Effect.asSome,
      Effect.catchTags({
        GitHubCliMissingError: () => Effect.succeedNone,
        GitHubNotSignedInError: () => Effect.succeedNone,
        GitHubHostDisabledError: () => Effect.succeedNone,
      }),
    );

  /** Exactly `account`'s gh login, unlike Source Control's lookup, which falls back to the active one. */
  const cliToken = yield* Cache.makeWith(
    Effect.fn("ScientGitHubCredentials.cliToken")(function* (key: string) {
      const [host = key, account = ""] = key.split("\u0000");
      const output = yield* process
        .run({
          operation: "ScientGitHubCredentials.cliToken",
          command: "gh",
          args: ["auth", "token", "--hostname", host, "--user", account],
          cwd: workingDirectory,
          // Never let gh print the token into a debug log.
          env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
          timeoutMs: 10_000,
          concurrency: GitHubCredentials.GH_PROCESS_CONCURRENCY,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          // A missing gh or no login for that account: nothing to lend.
          Effect.catchTags({
            VcsProcessSpawnError: () => Effect.succeed(""),
            VcsProcessExitError: () => Effect.succeed(""),
          }),
        );
      if (output === "") return Option.none<Held>();
      return Option.some<Held>({
        token: Redacted.make(output),
        fingerprint: yield* credentials.fingerprint(host, output),
        source: "gh",
      });
    }),
    {
      capacity: 16,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? TOKEN_TTL : MISSING_TTL,
    },
  );

  const get: SourceControlCredentials["get"] = Effect.fn("ScientGitHubCredentials.get")(
    function* (rawHost, options) {
      const host = normalizeHost(rawHost);
      const account = options?.account;
      const lend = (found: { readonly held: Held; readonly login: string }) =>
        Option.some<SourceControlCredential>({
          token: found.held.token,
          via: viaOf(found.held.source),
          login: found.login,
        });
      let current = yield* check(host, yield* effective(host));
      // The refused token's source forgot it, so a second look finds what replaces it.
      if (current._tag === "refused") current = yield* check(host, yield* effective(host));
      if (current._tag === "login" && (account === undefined || sameLogin(current.login, account)))
        return lend(current);
      if (account === undefined) return Option.none();
      // Another account the user chose: the app sign-in or that account's own gh login.
      if (current._tag !== "login" || current.held.source !== "app") {
        const app = yield* check(host, yield* api.appCredential(host));
        if (app._tag === "login" && sameLogin(app.login, account)) return lend(app);
      }
      const cli = yield* check(host, yield* Cache.get(cliToken, `${host}\u0000${account}`));
      return cli._tag === "login" && sameLogin(cli.login, account) ? lend(cli) : Option.none();
    },
    (effect, rawHost) =>
      effect.pipe(
        Effect.mapError(() => new SourceControlCredentialError({ host: normalizeHost(rawHost) })),
      ),
  );

  const invalidate: SourceControlCredentials["invalidate"] = Effect.fn(
    "ScientGitHubCredentials.invalidate",
  )(function* (rawHost, credential) {
    const host = normalizeHost(rawHost);
    switch (credential.via) {
      case "app":
        // Ignored unless this is still the session's token, so a late 401 spares a refreshed one.
        return yield* appSignIn.invalidate(host, Redacted.value(credential.token));
      case "cli": {
        // A late 401 for a token gh has since replaced must not evict the replacement.
        const rejected = yield* credentials.fingerprint(host, Redacted.value(credential.token));
        const current = yield* credentials.get(host).pipe(Effect.option);
        if (Option.exists(current, (held) => held.fingerprint === rejected)) {
          yield* credentials.invalidate(host);
        }
        const key = `${host}\u0000${credential.login}`;
        const cached = yield* Cache.getOption(cliToken, key).pipe(
          Effect.map(Option.flatten),
          Effect.orElseSucceed(() => Option.none<Held>()),
        );
        if (Option.exists(cached, (held) => held.fingerprint === rejected)) {
          yield* Cache.invalidate(cliToken, key);
        }
        return;
      }
      case "token":
        // A saved or environment token stays until the user replaces it.
        return;
    }
  });

  return { get, invalidate } satisfies SourceControlCredentials;
});
