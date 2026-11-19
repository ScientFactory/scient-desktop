import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The variable GitHub's app sign-in reads its client ID from; unset turns that sign-in off. */
const CLIENT_ID_VARIABLE = "T3CODE_GITHUB_APP_CLIENT_ID";

/** The public client ID of the Scient for GitHub app. Device flow needs no secret. */
export const SCIENT_GITHUB_APP_CLIENT_ID = "Iv23lieBEtqTwH75xtnk";

/**
 * `environment` with Scient's client ID when the operator set none. An explicitly empty value
 * still turns the app sign-in off. Reads stay live, so later PATH repairs and tokens still apply.
 */
export const withScientGitHubApp = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  new Proxy(environment, {
    get: (target, key) =>
      key === CLIENT_ID_VARIABLE && target[CLIENT_ID_VARIABLE] === undefined
        ? SCIENT_GITHUB_APP_CLIENT_ID
        : Reflect.get(target, key),
    has: (target, key) => key === CLIENT_ID_VARIABLE || Reflect.has(target, key),
  });

/** Provided to the source control drivers, the only readers of the client ID. */
export const scientGitHubAppEnvironment = Layer.effect(
  HostProcess.Environment,
  Effect.map(HostProcess.Environment, withScientGitHubApp),
);
