import { ProviderDriverKind } from "@t3tools/contracts";
import {
  DROID_LATEST_VERSION_URL,
  parseDroidReleaseVersion,
} from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { HttpClient } from "effect/unstable/http";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
  resolvePackageManagedProviderMaintenance,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "./providerMaintenance.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// The legacy package cannot reach Scient's minimum supported Pi version.
// Unknown/legacy ownership remains manual-only; never silently migrate it.
export const piMaintenance = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("pi"),
  npmPackageName: PI_PACKAGE,
  nativeUpdate: null,
});

export const droidMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("droidMaintenance.resolve")(function* (context) {
    const provider = ProviderDriverKind.make("droid");
    const packaged = yield* resolvePackageManagedProviderMaintenance(
      {
        provider,
        npmPackageName: "droid",
        nativeUpdate: null,
      },
      context,
    );
    if (packaged.update || !context) return packaged;
    // Factory's standalone installer owns this exact, non-symlinked path.
    // Never turn a symlink to a package-managed executable into a self-update.
    const home = context.env.HOME;
    const nativePath = home ? `${home.replace(/\/+$/, "")}/.local/bin/droid` : null;
    if (
      context.platform === "win32" ||
      !nativePath ||
      context.resolvedCommandPath !== nativePath ||
      context.realCommandPath !== nativePath
    )
      return packaged;
    if (context.env.FACTORY_DROID_AUTO_UPDATE_ENABLED === "false") {
      return makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null });
    }
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["update"],
      updateLockKey: `droid-native:${nativePath}`,
      platform: context.platform,
      env: context.env,
    });
  }),
};

/** Native releases use Factory's channel, not npm's independently published version. */
export const withDroidReleaseVersion = Effect.fn("withDroidReleaseVersion")(function* (
  capabilities: ProviderMaintenanceCapabilities,
  enabled: boolean,
) {
  if (!enabled || !capabilities.update?.lockKey.startsWith("droid-native:")) return capabilities;
  const cache = yield* ProviderVersionCache;
  const key = DROID_LATEST_VERSION_URL;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return { ...capabilities, latestVersion: cached.version };
  const client = yield* HttpClient.HttpClient;
  const version = yield* client.get(key).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? collectUint8StreamText({ stream: response.stream, maxBytes: 1024 * 1024 }).pipe(
            Effect.map((body) => (body.truncated ? null : parseDroidReleaseVersion(body.text))),
          )
        : Effect.succeed(null),
    ),
    Effect.timeout("4 seconds"),
    Effect.orElseSucceed(() => null),
  );
  cache.set(key, { version, expiresAt: now + 60 * 60 * 1000 });
  return { ...capabilities, latestVersion: version };
});
