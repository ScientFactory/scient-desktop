import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ toastAdd: vi.fn(), announce: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: { add: mocks.toastAdd },
}));
vi.mock("./announceResolvedLink", () => ({ announceResolvedLink: mocks.announce }));
vi.mock("~/browser/openFileInPreview", () => ({ openFileInPreview: vi.fn() }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/state/assets", () => ({ assetEnvironment: {} }));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => null }));
vi.mock("~/state/preview", () => ({ previewEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

import { openFileWhereItBelongs } from "./useScientFileOpening";

const linkResolution = { missingPath: "/repo/site/index.html" };
const repaired = { relativePath: "archive/index.html", linkResolution };

describe("openFileWhereItBelongs", () => {
  beforeEach(() => {
    mocks.toastAdd.mockReset();
    mocks.announce.mockReset();
  });

  it("notes a repaired link on the tab when the file opens in the panel", async () => {
    const openSource = vi.fn();
    await openFileWhereItBelongs({ ...repaired, openSource, openInBrowser: null });

    expect(openSource).toHaveBeenCalledExactlyOnceWith("archive/index.html", undefined, {
      linkResolution,
    });
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it("announces a repaired page that opens in the browser, which has no tab for the note", async () => {
    const openSource = vi.fn();
    await openFileWhereItBelongs({
      ...repaired,
      openSource,
      openInBrowser: async () => AsyncResult.success(undefined),
    });

    expect(openSource).not.toHaveBeenCalled();
    expect(mocks.announce).toHaveBeenCalledExactlyOnceWith({
      path: "archive/index.html",
      missingPath: "/repo/site/index.html",
    });
  });

  it.each([
    ["fails", async () => AsyncResult.failure(Cause.fail(new Error("no browser")))],
    [
      "throws",
      async () => {
        throw new Error("no browser");
      },
    ],
  ] as const)(
    "keeps the note on the source tab when the browser %s",
    async (_how, openInBrowser) => {
      const openSource = vi.fn();
      await openFileWhereItBelongs({ ...repaired, openSource, openInBrowser });

      // The page fell back to its source in the panel: the tab says it is not
      // the file the link named, and nothing claims a page opened.
      expect(openSource).toHaveBeenCalledExactlyOnceWith("archive/index.html", undefined, {
        linkResolution,
      });
      expect(mocks.announce).not.toHaveBeenCalled();
      expect(mocks.toastAdd).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: "Unable to preview HTML",
          description: "no browser Opened the source instead.",
        }),
      );
    },
  );

  it("opens an ordinary file with no note at all", async () => {
    const openSource = vi.fn();
    await openFileWhereItBelongs({
      relativePath: "notes.md",
      linkResolution: undefined,
      openSource,
      openInBrowser: null,
    });

    expect(openSource).toHaveBeenCalledExactlyOnceWith("notes.md", undefined, undefined);
  });
});
