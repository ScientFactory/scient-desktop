import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

// SCIENT-FORK:START — default managed tunnel cap per account; manual overrides still replace it.
// Blank counts as unset because CI passes missing variables as empty strings.
const decodeTunnelLimit = Schema.decodeUnknownEffect(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
);
export const defaultManagedTunnelLimitConfig = Config.String("RELAY_DEFAULT_TUNNEL_LIMIT").pipe(
  Config.withDefault(""),
  Config.mapEffect((value) =>
    value.trim() === ""
      ? Effect.succeed(Option.none<number>())
      : decodeTunnelLimit(value.trim()).pipe(
          Effect.asSome,
          Effect.mapError((error) => new Config.ConfigError(error)),
        ),
  ),
);
// SCIENT-FORK:END

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

// SCIENT-FORK:START account-deletion — the Sign in with Apple key, to revoke a deleted account's tokens.
export interface AppleSignInCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  /** The app bundle IDs (Apple client IDs) whose authorization codes the relay may redeem. */
  readonly clientIds: ReadonlyArray<string>;
}
// SCIENT-FORK:END account-deletion

export interface T3ChatSettings {
  readonly baseUrl: string;
  // Shared with T3 Chat: signs link tokens and authenticates relay calls.
  readonly linkSecret: Redacted.Redacted<string>;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    // SCIENT-FORK:START clerk-legacy-instance — the Clerk instance older builds sign in with.
    readonly clerkLegacy?: {
      readonly secretKey: Redacted.Redacted<string>;
      readonly publishableKey: string;
    };
    // SCIENT-FORK:END clerk-legacy-instance
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyTunnelGraceMinutes?: number;
    readonly t3Chat?: T3ChatSettings;
    // SCIENT-FORK:START account-deletion
    readonly appleSignIn?: AppleSignInCredentials;
    // SCIENT-FORK:END account-deletion
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, RelayConfiguration.of(configuration));
