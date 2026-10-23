/**
 * `scient.plugin.json`: the manifest of a declarative Scient plugin bundle.
 * A bundle contributes only data (Agent Skills directories and remote
 * connector definitions). Capabilities, settings pages and any executable
 * entry point are reserved for built-in plugins and are rejected here.
 * See docs/internals/scient-extensions.md.
 */
import { isStrictSemver } from "@scientfactory/scient-skills";
import { ExtensionsError, ScientPluginId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const SCIENT_PLUGIN_MANIFEST_FILE = "scient.plugin.json";
const SCIENT_PLUGIN_API_VERSION = "scient.plugins/v1alpha1";
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_CONTRIBUTED_SKILLS = 50;
const MAX_CONTRIBUTED_CONNECTORS = 20;

const BUILT_IN_ONLY = "is reserved for built-in plugins";
const NO_CODE = "would run code, and plugins cannot run code";

/**
 * Keys a bundle might use to claim authority or ship code, at the top level or
 * inside `contributes`. Named in the rejection instead of silently ignored.
 */
const RESERVED_KEY_REASONS: Readonly<Record<string, string>> = {
  capabilities: BUILT_IN_ONLY,
  settingsPage: BUILT_IN_ONLY,
  settings: BUILT_IN_ONLY,
  main: NO_CODE,
  bin: NO_CODE,
  scripts: NO_CODE,
  commands: NO_CODE,
  hooks: NO_CODE,
  mcpServers: NO_CODE,
  panels: NO_CODE,
  ui: NO_CODE,
};

const boundedText = (maximum: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(maximum));

const StrictSemver = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter(isStrictSemver, { expected: "an exact SemVer 2.0.0 version" }),
);

/** A portable path inside the bundle: relative, `/`-separated, no `.`/`..` or empty segments. */
const BundleRelativeDirectory = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (path: string) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { expected: "a relative directory inside the bundle" },
  ),
);

const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (value: string) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    },
    { expected: "an https URL without credentials" },
  ),
);

export const ScientPluginConnectorDefinition = Schema.Struct({
  url: HttpsUrl,
  displayName: boundedText(80),
  description: Schema.optional(boundedText(500)),
});
export type ScientPluginConnectorDefinition = typeof ScientPluginConnectorDefinition.Type;

export const ScientPluginManifest = Schema.Struct({
  apiVersion: Schema.Literal(SCIENT_PLUGIN_API_VERSION),
  id: ScientPluginId.check(Schema.isMaxLength(128)),
  version: StrictSemver,
  displayName: boundedText(80),
  description: boundedText(500),
  publisher: boundedText(120),
  contributes: Schema.Struct({
    skills: Schema.optional(
      Schema.Array(BundleRelativeDirectory).check(Schema.isMaxLength(MAX_CONTRIBUTED_SKILLS)),
    ),
    connectors: Schema.optional(
      Schema.Array(ScientPluginConnectorDefinition).check(
        Schema.isMaxLength(MAX_CONTRIBUTED_CONNECTORS),
      ),
    ),
  }),
});
export type ScientPluginManifest = typeof ScientPluginManifest.Type;

const decodeManifest = Schema.decodeUnknownExit(ScientPluginManifest);

const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });

const reservedKeyMessage = (value: unknown, where: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const key = Object.keys(value).find((candidate) =>
    Object.hasOwn(RESERVED_KEY_REASONS, candidate),
  );
  return key === undefined
    ? undefined
    : `Scient plugin bundles cannot declare '${key}' ${where}: it ${RESERVED_KEY_REASONS[key]}.`;
};

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

/** Decode `scient.plugin.json`, rejecting reserved and unknown keys rather than ignoring them. */
export const parseScientPluginManifest = Effect.fn("ScientPluginManifest.parse")(function* (
  bytes: Uint8Array,
) {
  if (bytes.byteLength > MAX_PLUGIN_MANIFEST_BYTES) {
    return yield* invalid(`${SCIENT_PLUGIN_MANIFEST_FILE} exceeds 64 KiB.`);
  }
  const notJson = invalid(`${SCIENT_PLUGIN_MANIFEST_FILE} is not valid UTF-8 JSON.`);
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => notJson,
  });
  const json = decodeJson(text);
  if (Exit.isFailure(json)) return yield* notJson;
  const value = json.value;
  const reserved =
    reservedKeyMessage(value, "in their manifest") ??
    reservedKeyMessage(
      typeof value === "object" && value !== null && "contributes" in value
        ? value.contributes
        : undefined,
      "in 'contributes'",
    );
  if (reserved !== undefined) return yield* invalid(reserved);
  if (
    typeof value === "object" &&
    value !== null &&
    "apiVersion" in value &&
    value.apiVersion !== SCIENT_PLUGIN_API_VERSION
  ) {
    return yield* invalid(
      `Unsupported plugin apiVersion; expected '${SCIENT_PLUGIN_API_VERSION}'.`,
    );
  }
  const decoded = decodeManifest(value, { onExcessProperty: "error" });
  if (Exit.isFailure(decoded)) {
    const failure = Cause.squash(decoded.cause);
    const detail = failure instanceof Error ? failure.message.replace(/\s*\n\s*/gu, " ") : "";
    return yield* invalid(
      `${SCIENT_PLUGIN_MANIFEST_FILE} is invalid${detail === "" ? "." : `: ${detail}`}`,
    );
  }
  const manifest = decoded.value;
  const skills = manifest.contributes.skills ?? [];
  if (new Set(skills).size !== skills.length) {
    return yield* invalid("A skill directory is contributed more than once.");
  }
  const overlapping = skills.find((outer) =>
    skills.some((inner) => inner !== outer && inner.startsWith(`${outer}/`)),
  );
  if (overlapping !== undefined) {
    return yield* invalid(`Skill directory '${overlapping}' contains another contributed skill.`);
  }
  const connectorUrls = (manifest.contributes.connectors ?? []).map(
    (connector) => new URL(connector.url).href,
  );
  if (new Set(connectorUrls).size !== connectorUrls.length) {
    return yield* invalid("A connector URL is contributed more than once.");
  }
  return manifest;
});
