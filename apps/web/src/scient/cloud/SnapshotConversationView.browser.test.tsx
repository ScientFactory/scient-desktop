import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import {
  FIXTURE_IMAGE_SHA256,
  FIXTURE_PNG,
  fixtureConversation,
} from "./cloudConversation.test-fixtures";
import { SnapshotConversationView } from "./SnapshotConversationView";

const loadBlob = async (sha256: string) => {
  if (sha256 === FIXTURE_IMAGE_SHA256) return new Blob([FIXTURE_PNG], { type: "image/png" });
  return new Blob(["<p>chart</p>"], { type: "text/html" });
};

describe("SnapshotConversationView", () => {
  it("renders a copied conversation without its computer", async () => {
    await using screen = await render(
      <SnapshotConversationView conversation={fixtureConversation} loadBlob={loadBlob} />,
    );

    // The finished turn's work folds behind chat's summary row.
    await expect.element(screen.getByText(/^Worked for/)).toBeInTheDocument();
    await expect.element(screen.getByText("Ran python fit.py")).not.toBeVisible();

    // Per-answer model from the sidecar, not the thread's.
    await expect.element(screen.getByText("claude-opus-5-5")).toBeVisible();

    // File mentions and project file links open on GitHub at the shared commit.
    await expect
      .element(screen.getByRole("link", { name: "src/model.py" }))
      .toHaveAttribute(
        "href",
        "https://github.com/example/decay/blob/0123456789abcdef/src/model.py",
      );
    await expect
      .element(screen.getByRole("link", { name: "the fit" }))
      .toHaveAttribute(
        "href",
        "https://github.com/example/decay/blob/0123456789abcdef/src/fit.py#L12",
      );

    // Math goes through chat's renderer; attachments resolve from the copy's blobs.
    await expect.poll(() => screen.container.querySelector(".katex")).not.toBeNull();
    await expect
      .element(screen.getByRole("img", { name: "decay.png" }))
      .toHaveAttribute("src", expect.stringMatching(/^blob:/));

    // Agent HTML never renders in the page itself; it goes to the content shim.
    await expect
      .element(screen.getByTitle("Decay chart"))
      .toHaveAttribute(
        "src",
        expect.stringMatching(/^https:\/\/share\.scientusercontent\.com\/frame#/),
      );
  });
});
