// @effect-diagnostics nodeBuiltinImport:off -- One synchronous read macOS answers with its own prompt.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Privacy & Security → Full Disk Access, on every macOS that has it. */
export const FULL_DISK_ACCESS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/** The app bundle a person drags into Full Disk Access: the outermost `.app` the app runs from. */
export function appBundleOf(executablePath: string) {
  const at = executablePath.indexOf(".app/");
  return at === -1 ? undefined : executablePath.slice(0, at + ".app".length);
}

/**
 * One read of the Messages database. macOS refuses it without Full Disk Access, and lists the app
 * in that pane once it has asked, so the person finds it there to switch on.
 */
export function askForMessages(home = NodeOS.homedir()) {
  try {
    NodeFS.closeSync(NodeFS.openSync(NodePath.join(home, "Library/Messages/chat.db"), "r"));
  } catch {
    // Refused, as expected before the grant; the asking is what counts.
  }
}
