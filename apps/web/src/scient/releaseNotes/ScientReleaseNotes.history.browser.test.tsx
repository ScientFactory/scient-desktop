import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";

import { SCIENT_RELEASE_NOTES } from "./catalog";
import { formatScientReleaseVersion } from "./model";
import { requestReleaseHistory } from "./releaseHistoryRequests";
import { ScientReleaseNotes } from "./ScientReleaseNotes";

// Uses the real controller, so the version list is built from the app's own version.
it("lists every release note when the history is requested", async () => {
  const stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  let root: Screen | undefined;
  try {
    root = stack.use(await _fixtureRender(null, { container: host, router: false }));
    await root.rerender(<ScientReleaseNotes />);

    requestReleaseHistory();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Release history", { exact: true })).toBeVisible();
    const oldest = SCIENT_RELEASE_NOTES[SCIENT_RELEASE_NOTES.length - 1]!.version;
    await expect
      .poll(() => document.querySelectorAll('[role="dialog"] [role="listitem"]').length)
      .toBe(SCIENT_RELEASE_NOTES.length);
    const oldestButton = dialog.getByRole("button", {
      name: `Read release notes for Scient ${formatScientReleaseVersion(oldest)}`,
    });
    await expect.element(oldestButton).toBeVisible();
    // The hand cursor tells the reader that a version row opens its note.
    expect(getComputedStyle(oldestButton.element()).cursor).toBe("pointer");
  } finally {
    await root?.unmount();
    host.remove();
  }
});
