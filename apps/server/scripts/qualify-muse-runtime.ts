// @effect-diagnostics nodeBuiltinImport:off -- This isolated native witness is invoked by managed-runtime qualification.
import * as NodePath from "node:path";
import { qualifyMuseManagedRuntime } from "../src/scient/providerLifecycle/MuseManagedRuntimeQualification.ts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const binary = argument("--binary");
if (!binary) throw new Error("--binary is required.");
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
const onMessage = (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "cancel"
  )
    cancel();
};
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
process.on("message", onMessage);
process.channel?.unref();
try {
  await qualifyMuseManagedRuntime({
    executablePath: NodePath.resolve(binary),
    environment: process.env,
    signal: cancellation.signal,
    onClosed: () => {
      process.send?.({ type: "muse-native-closed" });
    },
    ...(argument("--cwd") ? { home: NodePath.resolve(argument("--cwd")!) } : {}),
  });
  process.stdout.write(
    "Muse passed read-only MSP initialization, model/list and native close. This does not verify authentication.\n",
  );
} catch (cause) {
  // Name and message only: MSP failures carry no credentials, and stacks add no evidence.
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown failure";
  process.stderr.write(
    `Muse native protocol qualification failed (${reason.slice(0, 500)}). Authentication was not tested.\n`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  process.removeListener("message", onMessage);
}
