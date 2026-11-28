// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A short-lived reader process.
/**
 * Reads Messages and Mail in a process of its own, started for one check or one look. macOS can
 * keep a long-running process's earlier Full Disk Access denial; a new process is asked afresh,
 * so a grant works at once with no restart. It prints only whether each source reads, or only the
 * codes that name the service, never a message's text.
 */
import { mailReadable, readMailCodes } from "./scient/accounts/signIn/mailCodes.ts";
import { messagesReadable, readMessageCodes } from "./scient/accounts/signIn/messageCodes.ts";
import { runSignInCodesWorker } from "./scient/accounts/signIn/codeSourcesHelper.ts";

process.stdout.write(
  JSON.stringify(
    runSignInCodesWorker(process.argv.slice(2), {
      messagesReadable,
      mailReadable,
      readMessageCodes,
      readMailCodes,
    }),
  ),
);
