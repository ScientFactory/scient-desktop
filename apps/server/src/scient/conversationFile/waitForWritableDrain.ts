// @effect-diagnostics nodeBuiltinImport:off -- Native stream backpressure is handled at the Node boundary.
import type * as NodeStream from "node:stream";

/** Resolve on backpressure release, or fail promptly if the writable dies. */
export function waitForWritableDrain(stream: NodeStream.Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("The output stream closed before it drained."));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}
