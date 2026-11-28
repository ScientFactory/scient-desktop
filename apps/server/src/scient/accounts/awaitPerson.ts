import { AccountsError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The store stays closed: opening it would show a keychain dialog nobody is there to answer. */
export const ACCOUNTS_AWAIT_PERSON =
  "Scient Accounts opens only with the person at this computer. Try again once they're back.";

const isAccountsError = Schema.is(AccountsError);

/** Whether `cause` is the store waiting for the person (`ACCOUNTS_AWAIT_PERSON`). */
export const awaitsPerson = (cause: unknown) =>
  isAccountsError(cause) && cause.message === ACCOUNTS_AWAIT_PERSON;
