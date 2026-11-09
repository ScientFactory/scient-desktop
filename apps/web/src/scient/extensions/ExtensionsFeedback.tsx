import { EnvironmentAuthorizationError, ExtensionsError } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { InfoIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";

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

/** An error short enough to read in place, with no unbroken run that would push the layout wide. */
const fitsInline = (message: string) => message.length <= 110 && !/\S{36,}/.test(message);

/**
 * An error in a form or dialog. A short one is shown whole; a long one (a path, a program's own
 * output) takes one line, and the full text opens from the info button beside it.
 */
export function ErrorNote({
  message,
  summary,
}: {
  readonly message: string | null;
  /** The one line shown for a long error; the message itself, cut short, if not given. */
  readonly summary?: string | undefined;
}) {
  if (message === null) return null;
  if (fitsInline(message)) {
    return (
      <p role="alert" className="text-sm text-destructive-foreground [overflow-wrap:anywhere]">
        {message}
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="flex min-w-0 items-center gap-1 text-sm text-destructive-foreground"
    >
      <span className="min-w-0 truncate">{summary ?? message}</span>
      <span className="sr-only">{message}</span>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          render={<Button size="icon-xs" variant="ghost-muted" aria-label="Show the full error" />}
        >
          <InfoIcon aria-hidden />
        </PopoverTrigger>
        <PopoverPopup align="start" width="lg" padding="comfortable">
          <p className="text-xs whitespace-pre-wrap select-text [overflow-wrap:anywhere]">
            {message}
          </p>
        </PopoverPopup>
      </Popover>
    </div>
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
