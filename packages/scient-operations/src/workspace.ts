import * as Schema from "effect/Schema";

/** Host-local exact-checkout identity, never a portable project UUID or a grant. */
export const WorkspaceBindingId = Schema.NonEmptyString.pipe(
  Schema.brand("ScientWorkspaceBindingId"),
);
export type WorkspaceBindingId = typeof WorkspaceBindingId.Type;

export const WorkspaceAuthorityGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ScientWorkspaceAuthorityGeneration"),
);
export type WorkspaceAuthorityGeneration = typeof WorkspaceAuthorityGeneration.Type;

/** Monotonic revision of authority-relevant host project/thread events. */
export const WorkspaceAuthorityScopeRevision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("ScientWorkspaceAuthorityScopeRevision"));
export type WorkspaceAuthorityScopeRevision = typeof WorkspaceAuthorityScopeRevision.Type;

/** Durable execution ownership; independent from a runtime's restart generation. */
export const WorkspaceBindingRef = Schema.Struct({
  bindingId: WorkspaceBindingId,
  authorityGeneration: WorkspaceAuthorityGeneration,
});
export type WorkspaceBindingRef = typeof WorkspaceBindingRef.Type;

/**
 * An internal admission receipt. Only the host resolves this; decoding one
 * supplied by a model/client does not establish authority. The dispatcher or
 * domain coordinator must revalidate it before acting.
 */
export const WorkspaceScope = Schema.Struct({
  ...WorkspaceBindingRef.fields,
  workspaceRoot: Schema.NonEmptyString,
  scopeRevision: WorkspaceAuthorityScopeRevision,
});
export type WorkspaceScope = typeof WorkspaceScope.Type;
