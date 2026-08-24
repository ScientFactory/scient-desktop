/**
 * Explicit trusted registration seam for Scient-owned immutable releases.
 *
 * Phase one intentionally ships no product skill. Adding a release requires a
 * reviewed package directory and a separate product decision; provider-native
 * Codex and Claude skills are not copied into this registry.
 */
export const BUILT_IN_SKILL_RELEASE_ROOTS: ReadonlyArray<string> = [];
