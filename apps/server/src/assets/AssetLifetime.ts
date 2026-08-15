/**
 * Lifetime shared by an exact-file asset capability and any durable storage
 * lease needed to keep its immutable bytes available for that capability.
 */
export const ASSET_TOKEN_TTL_MS = 60 * 60 * 1_000;
