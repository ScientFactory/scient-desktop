import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";

export function roomCommandSucceeded<A>(
  result: AtomCommandResult<A, unknown>,
): result is Extract<typeof result, { _tag: "Success" }> {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      m(msg("Room action failed")),
      error instanceof Error ? error.message : m(msg("Try again.")),
    );
  }
  return false;
}
