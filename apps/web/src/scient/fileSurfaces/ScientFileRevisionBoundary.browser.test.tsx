import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { use, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AssetUrlState } from "~/assets/assetUrls";
import { render } from "../../../test/render";
import { DocumentIdentityContext } from "../documentCache/documentIdentity";

const { assets } = vi.hoisted(() => ({
  assets: { state: null as unknown, mounts: vi.fn() },
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => assets.state as AssetUrlState,
}));

import { ScientFileRevisionBoundary } from "./ScientFileRevisionBoundary";

const loading = { _tag: "Loading" };
const failure = { _tag: "Failure", refresh: () => undefined };
const success = (fileRevision?: string) => ({
  _tag: "Success",
  url: "https://environment.test/report.docx",
  refresh: () => undefined,
  ...(fileRevision === undefined ? {} : { fileRevision }),
});

function Preview() {
  useEffect(() => assets.mounts(), []);
  return <p>Report</p>;
}

const boundary = (refreshToken: string) => (
  <ScientFileRevisionBoundary
    environmentId={EnvironmentId.make("environment")}
    resource={{ _tag: "media-file", threadId: ThreadId.make("thread"), path: "/p/report.docx" }}
    refreshToken={refreshToken}
  >
    <Preview />
  </ScientFileRevisionBoundary>
);

/** Starts a test with no mounts counted and the asset in `state`. */
function setup(state: unknown) {
  assets.mounts.mockReset();
  assets.state = state;
}

// regression: every agent command or edit anywhere in the project remounted an open Word file,
// which loaded it again and went back to its first page.
describe("ScientFileRevisionBoundary", () => {
  it("remounts a preview only when its file's revision changes", async () => {
    setup(loading);
    await using screen = await render(boundary("a"));
    assets.state = success("r1");
    await screen.rerender(boundary("a"));
    // The agent ran a command: the check is under way, then finds the file unchanged.
    assets.state = loading;
    await screen.rerender(boundary("b"));
    assets.state = success("r1");
    await screen.rerender(boundary("b"));
    expect(assets.mounts).toHaveBeenCalledTimes(1);
    // The agent rewrote the file.
    assets.state = success("r2");
    await screen.rerender(boundary("c"));
    expect(assets.mounts).toHaveBeenCalledTimes(2);
  });

  it("retries a preview that opened before its file could be read", async () => {
    setup(failure);
    await using screen = await render(boundary("a"));
    // The file appeared and the panel was refreshed.
    assets.state = success("r1");
    await screen.rerender(boundary("b"));
    expect(assets.mounts).toHaveBeenCalledTimes(2);
  });

  it("remounts on every possible change when the environment reports no revision", async () => {
    setup(success());
    await using screen = await render(boundary("a"));
    await screen.rerender(boundary("b"));
    expect(assets.mounts).toHaveBeenCalledTimes(2);
  });

  it("opens the preview once the file's revision is known, and names it", async () => {
    setup(loading);
    function Identity() {
      assets.mounts();
      return <p data-testid="identity">{use(DocumentIdentityContext) ?? "unknown"}</p>;
    }
    const view = (state: unknown, refreshToken: string) => {
      assets.state = state;
      return (
        <ScientFileRevisionBoundary
          environmentId={EnvironmentId.make("environment")}
          resource={{ _tag: "media-file", threadId: ThreadId.make("thread"), path: "/p/a.docx" }}
          refreshToken={refreshToken}
        >
          <Identity />
        </ScientFileRevisionBoundary>
      );
    };
    await using screen = await render(view(loading, "a"));
    expect(assets.mounts).not.toHaveBeenCalled();
    await screen.rerender(view(success("r1"), "a"));
    expect(screen.container.textContent).toContain('"r1"');
    // Without a revision, nothing names the file's content.
    await screen.rerender(view(success(), "b"));
    expect(screen.container.textContent).toBe("unknown");
  });
});
