import { RemoteEnvironmentAuthInvalidJsonError } from "@t3tools/client-runtime/rpc";

const INVALID_RESPONSE_PREFIX = "Remote environment endpoint returned an invalid response";
const ENDPOINT_PREFIX = "Remote environment endpoint";
const FETCH_PREFIX = "Failed to fetch remote environment endpoint";

export function scientSourcesErrorMessage(error: unknown, development: boolean): string {
  if (
    error instanceof RemoteEnvironmentAuthInvalidJsonError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "RemoteEnvironmentAuthInvalidJsonError")
  ) {
    return development
      ? "This Scient (Dev) app and its local server are out of sync. Restart this candidate, then try again."
      : "Scient received source data that this app version cannot read. Update or reconnect the selected environment, then try again.";
  }

  if (!(error instanceof Error)) return "An unexpected error occurred.";

  if (error.message.startsWith(INVALID_RESPONSE_PREFIX)) {
    return error.message.replace(
      INVALID_RESPONSE_PREFIX,
      "The selected environment returned an invalid response",
    );
  }
  if (error.message.startsWith(ENDPOINT_PREFIX)) {
    return error.message.replace(ENDPOINT_PREFIX, "The selected environment endpoint");
  }
  if (error.message.startsWith(FETCH_PREFIX)) {
    return error.message.replace(
      FETCH_PREFIX,
      "Scient could not reach the selected environment endpoint",
    );
  }
  return error.message;
}
