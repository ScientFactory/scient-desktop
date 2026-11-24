// @effect-diagnostics nodeBuiltinImport:off -- Owner-only dev identity files beside an app's state.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off -- Owner-only dev identity files beside an app's state.
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off -- Owner-only dev identity files beside an app's state.
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LEASE_FILE = "dev-connector-lease.json";
const BINDING_FILE = "dev-connector-broker.json";
/** Written by `pnpm dev:identity setup` beside the home's state; nothing else writes it. */
const HOME_RECORD = "dev-identity-home.json";
/** Written into a dev app's state by each copy from the home. */
const COPY_MARKER = "dev-identity.json";

const LeaseEndpoint = Schema.Struct({
  version: Schema.Literal(1),
  host: Schema.String,
  port: Schema.Int,
  token: Schema.String,
});
export type LeaseEndpoint = typeof LeaseEndpoint.Type;
const Binding = Schema.Struct({
  version: Schema.Literal(1),
  homeStateDir: Schema.String,
  connectors: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
});
export type DevConnectorBinding = typeof Binding.Type;
const decodeEndpoint = Schema.decodeUnknownOption(Schema.fromJsonString(LeaseEndpoint));
const decodeBinding = Schema.decodeUnknownOption(Schema.fromJsonString(Binding));

const readText = (path: string): string | undefined => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const realpathOrSelf = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** Whether `stateDir` is the registered dev identity home at `homeStateDir`. */
export const isDevIdentityHome = (stateDir: string, homeStateDir: string) =>
  realpathOrSelf(stateDir) === realpathOrSelf(homeStateDir) &&
  NodeFS.existsSync(NodePath.join(NodePath.dirname(homeStateDir), HOME_RECORD));

/** A dev app's borrowed connectors, only when a copy from a registered home wrote them. */
export const readDevConnectorBinding = (stateDir: string): DevConnectorBinding | undefined => {
  if (!NodeFS.existsSync(NodePath.join(stateDir, COPY_MARKER))) return undefined;
  const binding = decodeBinding(readText(NodePath.join(stateDir, BINDING_FILE)) ?? "");
  if (Option.isNone(binding)) return undefined;
  const home = binding.value.homeStateDir;
  return NodeFS.existsSync(NodePath.join(NodePath.dirname(home), HOME_RECORD))
    ? binding.value
    : undefined;
};

export const readLeaseEndpoint = (homeStateDir: string): LeaseEndpoint | undefined =>
  Option.getOrUndefined(decodeEndpoint(readText(NodePath.join(homeStateDir, LEASE_FILE)) ?? ""));

/** Published whole and owner-only: written beside, then renamed over any earlier one. */
export const writeLeaseEndpoint = (stateDir: string, endpoint: Omit<LeaseEndpoint, "version">) => {
  const path = NodePath.join(stateDir, LEASE_FILE);
  const temporary = `${path}.${NodeCrypto.randomUUID()}`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ version: 1, ...endpoint }), {
    mode: 0o600,
    flag: "wx",
  });
  NodeFS.renameSync(temporary, path);
};

export const removeLeaseEndpoint = (stateDir: string) =>
  NodeFS.rmSync(NodePath.join(stateDir, LEASE_FILE), { force: true });
