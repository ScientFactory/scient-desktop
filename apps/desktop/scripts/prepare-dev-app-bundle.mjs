// SCIENT-OWNED: builds and signs the macOS development app bundle in the
// calling (foreground) session, so the background service only launches it.
// `pnpm dev:app:start` runs this with the environment the launch will use.

import { resolveDevProtocolClient } from "./electron-launcher.mjs";

resolveDevProtocolClient();
