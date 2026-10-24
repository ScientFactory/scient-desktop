import { render } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { MarkdownSourceSurface } from "~/components/files/FilePreviewPanel";
import { createTestCheckpointStore } from "~/scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { MarkdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

const block = (mine: string, theirs: string) =>
  `<<<<<<< Scient\n${mine}\n=======\n${theirs}\n>>>>>>> Overleaf\n`;
const SOURCE = `\\section{Intro}\n${block("Mine one.", "Theirs one.")}Between.\n${block("Mine two.", "Theirs two.")}End.\n`;

/** A LaTeX file open in Source, on a document session that saves to `disk`. */
async function openSource(source: string) {
  const target = {
    environmentId: EnvironmentId.make("overleaf-conflicts"),
    cwd: "/work/project",
    relativePath: "paper/main.tex",
  };
  const disk = { source, revision: "r0" };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    createTransport: () => ({
      write: async (intent) => {
        disk.source = intent.source;
        disk.revision = `${disk.revision}!`;
        return { revision: disk.revision };
      },
      read: async () => disk,
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, {
    relativePath: target.relativePath,
    contents: source,
    revision: disk.revision,
    byteLength: source.length,
    truncated: false,
  })!;
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:900px;height:600px";
  const screen = await render(
    <MarkdownSourceSurface
      persistence={lease}
      {...target}
      composerDraftTarget={{ environmentId: target.environmentId, threadId: ThreadId.make("t1") }}
      resolvedTheme="light"
      revealRequestId={0}
      wordWrap={false}
      onPostRender={() => {}}
    />,
    { container: host, router: false },
  );
  return {
    lease,
    disk,
    host,
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      lease.release();
    },
  };
}

const actions = (line: number) =>
  page.getByRole("group", { name: `Overleaf conflict at line ${line}` });

describe("Overleaf conflict blocks in Source", () => {
  it("highlights each block, with its three choices above it", async () => {
    await using view = await openSource(SOURCE);
    await expect.element(actions(2)).toBeVisible();
    await expect.element(actions(8)).toBeVisible();
    for (const label of ["Use mine", "Use Overleaf's", "Keep both"]) {
      await expect.element(actions(2).getByRole("button", { name: label })).toBeVisible();
    }
    expect(
      view.host.querySelector("[data-overleaf-conflicts]")?.getAttribute("data-overleaf-conflicts"),
    ).toBe("2");
  });

  it("Use mine keeps this computer's lines, undoably, and saves like any edit", async () => {
    await using view = await openSource(SOURCE);
    await actions(2).getByRole("button", { name: "Use mine" }).click();
    const resolved = `\\section{Intro}\nMine one.\nBetween.\n${block("Mine two.", "Theirs two.")}End.\n`;
    await expect.poll(() => view.lease.getSnapshot().draftSource).toBe(resolved);
    // The other block keeps its choices, now on its new line.
    await expect.element(actions(4)).toBeVisible();
    await expect.element(actions(2)).not.toBeInTheDocument();

    expect(await view.lease.flushNow()).toBe(true);
    expect(view.disk.source).toBe(resolved);

    await userEvent.click(page.getByRole("textbox"));
    await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
    await expect.poll(() => view.lease.getSnapshot().draftSource).toBe(SOURCE);
    await expect.element(actions(2)).toBeVisible();
  });

  it("Use Overleaf's keeps Overleaf's lines", async () => {
    await using view = await openSource(SOURCE);
    await actions(8).getByRole("button", { name: "Use Overleaf's" }).click();
    await expect
      .poll(() => view.lease.getSnapshot().draftSource)
      .toBe(`\\section{Intro}\n${block("Mine one.", "Theirs one.")}Between.\nTheirs two.\nEnd.\n`);
  });

  it("Keep both keeps this computer's lines, then Overleaf's, even at the end of the file", async () => {
    const atEnd = `Start.\n${block("Mine.", "Theirs.").trimEnd()}`;
    await using view = await openSource(atEnd);
    await actions(2).getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => view.lease.getSnapshot().draftSource).toBe("Start.\nMine.\nTheirs.");
    await expect.element(actions(2)).not.toBeInTheDocument();
  });
});
