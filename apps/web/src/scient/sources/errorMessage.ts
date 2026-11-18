import { msg } from "gt-react";

import { m } from "~/i18n/messages";

const INVALID_RESPONSE_PREFIX = "Remote environment endpoint returned an invalid response";
const ENDPOINT_PREFIX = "Remote environment endpoint";
const FETCH_PREFIX = "Failed to fetch remote environment endpoint";

export const LIBRARY_MOVING_MESSAGE = msg(
  "The Library is still moving. Try again when it has finished.",
);

/** A Library change that waited for the move into the personal Library and gave up. */
export function isLibraryMovingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentInternalError" &&
    "reason" in error &&
    error.reason === "scient_sources_library_moving"
  );
}

/** No answer came back (a timeout or a failed connection), so the request's outcome is unknown. */
export function isLostAnswerError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "RemoteEnvironmentAuthTimeoutError" ||
      error._tag === "RemoteEnvironmentAuthFetchError")
  );
}

export function scientSourcesErrorMessage(error: unknown, development: boolean): string {
  if (isLibraryMovingError(error)) return m(LIBRARY_MOVING_MESSAGE);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "RemoteEnvironmentAuthInvalidJsonError"
  ) {
    return development
      ? m(
          msg(
            "This Scient (Dev) app and its local server are out of sync. Restart this candidate, then try again.",
          ),
        )
      : m(
          msg(
            "Scient received source data that this app version cannot read. Update or reconnect the selected environment, then try again.",
          ),
        );
  }

  if (!(error instanceof Error)) return m(msg("An unexpected error occurred."));

  // The rest of the message is the endpoint's own words, which stay as they came.
  if (error.message.startsWith(INVALID_RESPONSE_PREFIX)) {
    return m(
      msg("The selected environment returned an invalid response{rest}", {
        rest: error.message.slice(INVALID_RESPONSE_PREFIX.length),
      }),
    );
  }
  if (error.message.startsWith(ENDPOINT_PREFIX)) {
    return m(
      msg("The selected environment endpoint{rest}", {
        rest: error.message.slice(ENDPOINT_PREFIX.length),
      }),
    );
  }
  if (error.message.startsWith(FETCH_PREFIX)) {
    return m(
      msg("Scient could not reach the selected environment endpoint{rest}", {
        rest: error.message.slice(FETCH_PREFIX.length),
      }),
    );
  }
  return error.message;
}
