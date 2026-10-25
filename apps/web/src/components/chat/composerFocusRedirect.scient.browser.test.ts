import { expect, it } from "vite-plus/test";
import { shouldTypeToFocusComposer } from "./composerFocusRedirect";

// composedPath() is only populated while the event is dispatching, so decide
// inside a capture listener the way the chat shortcut handler does.
function typeOn(target: Element, key: string): boolean {
  let redirected = false;
  const listener = (event: KeyboardEvent) => {
    redirected = shouldTypeToFocusComposer(event);
  };
  window.addEventListener("keydown", listener, { capture: true });
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
  window.removeEventListener("keydown", listener, { capture: true });
  return redirected;
}

// Letters typed elsewhere in the chat reaching the composer are covered by
// useChatShortcuts.browser.test.tsx "still types other letters into the composer…".
// regression: 0c609ab87d fix(web): the device screen keeps focus when typing or returning to the window (#14534)
it("keeps letters typed on the device screen on the device", () => {
  using stack = new DisposableStack();
  const deviceScreen = document.createElement("div");
  deviceScreen.setAttribute("role", "application");
  deviceScreen.tabIndex = 0;
  document.body.append(deviceScreen);
  stack.defer(() => deviceScreen.remove());
  expect(typeOn(deviceScreen, "a")).toBe(false);
});

// The side panel's New tab page uses typed letters to open its cards.
it("keeps letters typed on the side panel's New tab page there", () => {
  using stack = new DisposableStack();
  const launcher = document.createElement("div");
  launcher.setAttribute("data-scient-launcher", "");
  launcher.tabIndex = -1;
  const heading = document.createElement("h2");
  launcher.append(heading);
  document.body.append(launcher);
  stack.defer(() => launcher.remove());
  expect(typeOn(launcher, "f")).toBe(false);
  expect(typeOn(heading, "f")).toBe(false);
});
