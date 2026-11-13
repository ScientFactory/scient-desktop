import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const PRODUCTION = {
  apiHost: "cloud.scientfactory.com",
  pageHost: "scientfactory.com",
  contentHost: "share.scientusercontent.com",
};

const optionalHost = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
  );

/**
 * Hosts for this stage. `prod` uses the Scient hosts; any other stage must name its own, so a
 * developer stage never takes over `scientfactory.com/s/*`.
 */
export const DeploymentConfig = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const apiHost = yield* optionalHost("SCIENT_CLOUD_API_HOST");
  const pageHost = yield* optionalHost("SCIENT_CLOUD_PAGE_HOST");
  const contentHost = yield* optionalHost("SCIENT_CLOUD_CONTENT_HOST");
  const hosts = {
    apiHost: apiHost || (stage === "prod" ? PRODUCTION.apiHost : ""),
    pageHost: pageHost || (stage === "prod" ? PRODUCTION.pageHost : ""),
    contentHost: contentHost || (stage === "prod" ? PRODUCTION.contentHost : ""),
  };
  if (!hosts.apiHost || !hosts.pageHost || !hosts.contentHost) {
    return yield* Effect.die(
      `Stage ${stage} needs SCIENT_CLOUD_API_HOST, SCIENT_CLOUD_PAGE_HOST and SCIENT_CLOUD_CONTENT_HOST.`,
    );
  }
  return { stage, ...hosts };
});
