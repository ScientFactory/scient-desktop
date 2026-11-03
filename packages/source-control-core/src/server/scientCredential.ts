import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** A host credential lent to a Scient connector, with the account it was checked to belong to. */
export interface SourceControlCredential {
  readonly token: Redacted.Redacted<string>;
  /** A token saved in Settings or the server environment, the app sign-in, or the host's CLI. */
  readonly via: "token" | "app" | "cli";
  /** The login the host's API reports for this token, as the host spells it. */
  readonly login: string;
}

/** Carries no cause or text from the source, so nothing it says can hold a credential. */
export class SourceControlCredentialError extends Data.TaggedError("SourceControlCredentialError")<{
  readonly host: string;
}> {
  override get message(): string {
    return `Source Control could not hand over its credential for ${this.host} right now. Retry shortly.`;
  }
}

export interface SourceControlCredentials {
  /**
   * Source Control's own credential for `host`, in its own order. With `account`, only a
   * credential for that login, never another account's; none when Source Control has none.
   */
  readonly get: (
    host: string,
    options?: { readonly account?: string },
  ) => Effect.Effect<Option.Option<SourceControlCredential>, SourceControlCredentialError>;
  /** The host refused `credential`; its own source forgets it, and only while it is current. */
  readonly invalidate: (host: string, credential: SourceControlCredential) => Effect.Effect<void>;
}
