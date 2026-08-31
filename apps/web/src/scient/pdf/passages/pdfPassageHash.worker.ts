import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// One bounded material hash. The caller transfers its PDF.js getData() copy,
// then terminates this worker after success or failure; there is no worker pool.
self.addEventListener(
  "message",
  (event: MessageEvent<Uint8Array>) => {
    // Dedicated worker messages have no targetOrigin (this is not Window.postMessage).
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    self.postMessage(bytesToHex(sha256(event.data)));
  },
  { once: true },
);
