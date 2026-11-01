import * as Schema from "effect/Schema";

export class DesktopAccountsError extends Schema.TaggedError<DesktopAccountsError>()(
  "DesktopAccountsError",
  {},
) {
  override get message() {
    return "Scient Accounts desktop operation failed.";
  }
}
