import { EnvironmentAuthorizationError, ExtensionsError } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

const isExtensionsError = Schema.is(ExtensionsError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/**
 * What a failed extensions command tells the user, or null for success and
 * interruption. Only the server's typed, user-facing messages are shown;
 * transport and unexpected failures get a generic sentence.
 */
export function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (isExtensionsError(error)) return error.message;
  if (isAuthorizationError(error)) return "This connection is not allowed to change extensions.";
  return "Scient could not complete this request. Try again.";
}

export function ActionError({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-xs text-destructive-foreground">
      {message}
    </p>
  );
}

/** Shown when the sign-in page could not be opened for the user. */
export function SignInBlockedNotice({ url }: { readonly url: string | null }) {
  if (url === null) return null;
  return (
    <p role="alert" className="text-xs text-muted-foreground">
      The sign-in window was blocked.{" "}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground underline underline-offset-2"
      >
        Open sign-in page
      </a>
    </p>
  );
}
