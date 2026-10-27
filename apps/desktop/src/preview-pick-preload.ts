import { ipcRenderer } from "electron";

import { PASSKEY_BRIDGE_ARGUMENT } from "./preview/GuestProtocol.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import "./preview/PickPreload.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
}

// SCIENT-FORK:START — Scient Accounts: capture submitted sign-ins from preview guests.
import { installSignInCapture } from "./scient/accounts/capture.ts";
import { installLoginFormDetection } from "./scient/accounts/autofill.ts";
import { CAPTURE, CAPTURE_ALLOWED, LOGIN_FORM_REPORT } from "./scient/accounts/protocol.ts";
installSignInCapture(
  () => ipcRenderer.sendSync(CAPTURE_ALLOWED) === true,
  (capture) => ipcRenderer.send(CAPTURE, capture),
);
installLoginFormDetection(
  () => ipcRenderer.sendSync(CAPTURE_ALLOWED) === true,
  (form) => ipcRenderer.send(LOGIN_FORM_REPORT, form),
);
// SCIENT-FORK:END
