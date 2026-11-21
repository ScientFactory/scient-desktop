import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";

import { SCIENT_RELEASE_NOTES } from "./catalog";
import { formatScientReleaseVersion } from "./model";
import { requestReleaseHistory } from "./releaseHistoryRequests";
import {
  ScientReleaseCard,
  ScientReleaseNotesDialogHost,
  ScientReleaseNotesProvider,
} from "./ScientReleaseNotes";

// Mounts the pieces the way the app does: the card in the sidebar, the dialog at app level.
function ScientReleaseNotes() {
  return (
    <ScientReleaseNotesProvider>
      <ScientReleaseCard />
      <ScientReleaseNotesDialogHost />
    </ScientReleaseNotesProvider>
  );
}

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

// The window used to live inside the sidebar, so closing the sidebar also closed the way to it.
it("opens the release history when no sidebar card is mounted", async () => {
  const stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  let root: Screen | undefined;
  try {
    root = stack.use(await _fixtureRender(null, { container: host, router: false }));
    await root.rerender(
      <ScientReleaseNotesProvider>
        <ScientReleaseNotesDialogHost />
        <button type="button" onClick={requestReleaseHistory}>
          About
        </button>
      </ScientReleaseNotesProvider>,
    );

    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  } finally {
    await root?.unmount();
    host.remove();
  }
});

it("gives focus back to the About button when the history closes", async () => {
  const stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  let root: Screen | undefined;
  try {
    root = stack.use(await _fixtureRender(null, { container: host, router: false }));
    await root.rerender(
      <ScientReleaseNotesProvider>
        <ScientReleaseNotesDialogHost />
        <button type="button" onClick={requestReleaseHistory}>
          About
        </button>
      </ScientReleaseNotesProvider>,
    );

    await page.getByRole("button", { name: "About", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement?.textContent).toBe("About");
  } finally {
    await root?.unmount();
    host.remove();
  }
});

// Going back to the list must start at its top, not at the scroll position of the release view.
it("shows the top of the version list again after a release was opened", async () => {
  const stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  document.body.append(host);
  let root: Screen | undefined;
  try {
    root = stack.use(await _fixtureRender(null, { container: host, router: false }));
    await root.rerender(
      <ScientReleaseNotesProvider>
        <ScientReleaseNotesDialogHost />
        <button type="button" onClick={requestReleaseHistory}>
          About
        </button>
      </ScientReleaseNotesProvider>,
    );

    await page.getByRole("button", { name: "About", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    const viewportOf = () =>
      document.querySelector<HTMLElement>('[role="dialog"] [data-slot="scroll-area-viewport"]')!;
    viewportOf().scrollTop = viewportOf().scrollHeight;
    await expect.poll(() => viewportOf().scrollTop).toBeGreaterThan(0);

    await dialog
      .getByRole("button", {
        name: `Read release notes for Scient ${formatScientReleaseVersion(SCIENT_RELEASE_NOTES[1].version)}`,
        exact: true,
      })
      .click();
    // The footer button returns to the list, as in the recording.
    await dialog.getByRole("button", { name: "Release history", exact: true }).click();

    await expect.poll(() => viewportOf().scrollTop).toBe(0);
    // The list is the same view whichever way it was reached: no way back, its rows open the versions.
    await expect.element(dialog.getByRole("button", { name: /back/i })).not.toBeInTheDocument();
  } finally {
    await root?.unmount();
    host.remove();
  }
});
