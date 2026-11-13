import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";

export function roomCommandSucceeded<A>(
  result: AtomCommandResult<A, unknown>,
): result is Extract<typeof result, { _tag: "Success" }> {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert("Room action failed", error instanceof Error ? error.message : "Try again.");
  }
  return false;
}
