import * as Schema from "effect/Schema";

/**
 * Opaque, random reference to material held by the Secrets vault. Never derived
 * from a name or path. Distinct from the one-use request_secret `SecretRef`.
 */
export const VaultSecretRef = Schema.String.pipe(Schema.brand("VaultSecretRef"));
export type VaultSecretRef = typeof VaultSecretRef.Type;
