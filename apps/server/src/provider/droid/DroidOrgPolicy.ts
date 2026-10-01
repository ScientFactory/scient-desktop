// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Whether Droid's organization policy lets the process overlay's hooks run.
 * `managed-hooks-only`: the policy says only organization hooks run, so Scient's
 * tool-refusal hook is dropped. `unknown`: a policy source is present but
 * Scient cannot read it, or Droid would fetch it from a URL Scient does not.
 */
export type DroidOrgHookPolicy = "overlay-hooks-allowed" | "managed-hooks-only" | "unknown";

/** Droid's system-wide managed settings file (read only, never written by Scient). */
export function droidSystemManagedSettingsPath(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/Factory/settings.json";
    case "linux":
      return "/etc/factory/settings.json";
    case "win32":
      return "C:\\Program Files\\Factory\\settings.json";
    default:
      return undefined;
  }
}

const OrgSettings = fromLenientJson(
  Schema.Struct({ allowManagedHooksOnly: Schema.optionalKey(Schema.Unknown) }),
);
const OrgSettingsCache = fromLenientJson(
  Schema.Struct({
    managedSettings: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ allowManagedHooksOnly: Schema.optionalKey(Schema.Unknown) })),
    ),
  }),
);
const decodeOrgSettings = Schema.decodeUnknownOption(OrgSettings);
const decodeOrgSettingsCache = Schema.decodeUnknownOption(OrgSettingsCache);

const hookPolicy = (allowManagedHooksOnly: unknown): DroidOrgHookPolicy =>
  allowManagedHooksOnly === true
    ? "managed-hooks-only"
    : allowManagedHooksOnly === undefined || allowManagedHooksOnly === false
      ? "overlay-hooks-allowed"
      : "unknown";

const nonEmpty = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/**
 * The value Droid sees for `name`, or `ambiguous`. Windows looks environment
 * names up case-insensitively, so every spelling of `name` reaches Droid; when
 * spellings disagree, which one the process gets is not defined by the
 * environment object, so Scient cannot rule out the other. Elsewhere names are
 * case-sensitive. Empty values count as absent, as Droid treats them.
 */
const environmentValue = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  name: string,
): string | undefined | "ambiguous" => {
  if (platform !== "win32") return nonEmpty(environment[name]);
  const spellings = new Set(
    Object.entries(environment).flatMap(([key, value]) =>
      key.toUpperCase() === name && value !== undefined ? [value.trim()] : [],
    ),
  );
  if (spellings.size > 1) return "ambiguous";
  return nonEmpty([...spellings][0]);
};

/**
 * Reads the organization policy sources Droid itself reads, in its order
 * (from Droid 0.213.0 and 0.230.0): a system managed-settings file that
 * exists (even unreadable) is the only source; otherwise
 * `FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH`; otherwise
 * `FACTORY_ORG_MANAGED_SETTINGS_URL`; otherwise Factory's API, whose last
 * answer Droid caches in its settings folder (`org-managed-settings.cache.json`
 * on 0.230, `cache/org-managed-settings.json` on 0.213; each with a
 * `.backup`). Without a cache, or with a stale one, the API's current answer
 * is not visible here; the session-start check covers what Droid resolved.
 */
export const readDroidOrgHookPolicy = Effect.fn("readDroidOrgHookPolicy")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Droid's working directory, against which a relative local path resolves. */
  readonly cwd: string;
  readonly systemSettingsPath?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => fs.readFileString(file).pipe(Effect.option);
  // Droid treats a path it cannot even stat as present.
  const present = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => true));
  const fromSettingsFile = (file: string) =>
    read(file).pipe(
      Effect.map((text) => {
        if (text._tag === "None") return "unknown" as const;
        const settings = decodeOrgSettings(text.value);
        return settings._tag === "None"
          ? "unknown"
          : hookPolicy(settings.value.allowManagedHooksOnly);
      }),
    );

  const system = input.systemSettingsPath ?? droidSystemManagedSettingsPath(input.platform);
  if (system !== undefined && (yield* present(system))) return yield* fromSettingsFile(system);

  const variable = (name: string) => environmentValue(input.environment, input.platform, name);
  const localPath = variable("FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH");
  if (localPath === "ambiguous") return "unknown" as const;
  if (localPath !== undefined) return yield* fromSettingsFile(path.resolve(input.cwd, localPath));

  if (variable("FACTORY_ORG_MANAGED_SETTINGS_URL") !== undefined) return "unknown" as const;

  const homeOverride = variable("FACTORY_HOME_OVERRIDE");
  const userHome = variable(input.platform === "win32" ? "USERPROFILE" : "HOME");
  if (homeOverride === "ambiguous" || (homeOverride === undefined && userHome === "ambiguous"))
    return "unknown" as const;
  const home =
    homeOverride ?? (userHome === "ambiguous" ? undefined : userHome) ?? NodeOS.homedir();
  const factory = path.join(home, ".factory");
  const caches = [
    path.join(factory, "org-managed-settings.cache.json"),
    path.join(factory, "org-managed-settings.cache.json.backup"),
    path.join(factory, "cache", "org-managed-settings.json"),
    path.join(factory, "cache", "org-managed-settings.json.backup"),
  ];
  let policy: DroidOrgHookPolicy = "overlay-hooks-allowed";
  for (const cache of caches) {
    if (!(yield* present(cache))) continue;
    const text = yield* read(cache);
    const decoded = text._tag === "None" ? text : decodeOrgSettingsCache(text.value);
    const next =
      decoded._tag === "None"
        ? "unknown"
        : hookPolicy(decoded.value.managedSettings?.allowManagedHooksOnly);
    if (next === "managed-hooks-only") return next;
    if (next === "unknown") policy = next;
  }
  return policy;
});
