// @vitest-environment happy-dom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { disk, refresh } = vi.hoisted(() => ({
  disk: { source: "", revision: "r1" },
  refresh: () => {},
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { fileChanges: () => ({}) },
}));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  return { useAtomValue: () => AsyncResult.initial() };
});
vi.mock("~/components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environment: unknown, _cwd: unknown, path: string) => ({
    authoritativeData: {
      relativePath: path,
      contents: disk.source,
      revision: disk.revision,
      byteLength: disk.source.length,
      truncated: false,
    },
    isPending: false,
    error: null,
    refresh,
  }),
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));

import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { createMarkdownPersistenceTransport } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";
import { createMarkdownPersistenceGuards } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceGuards";
import { LatexReferencesPanel, type BibliographyDocument } from "./LatexReferencesPanel";
import { readStoredRecovery } from "./visualRecovery";
import { readPersistedVisualDraft } from "./visualDrafts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("References bibliography session", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let tab: MarkdownPersistenceLease;
  let publication: ReturnType<typeof deferred<{ revision: string }>>;
  let draftKey: string;
  const onSaved = vi.fn();
  const onDraftChange = vi.fn();
  const write = vi.fn();
  let sequence = 0;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    onSaved.mockReset();
    onDraftChange.mockReset();
    write.mockReset();
    disk.source = "@article{known,\n  title = {Original},\n}\n";
    disk.revision = "r1";
    publication = deferred();
    const environmentId = EnvironmentId.make(`synthetic-references-${sequence++}`);
    const cwd = "/synthetic-workspace";
    draftKey = `${environmentId}\0${cwd}\0refsA.bib`;
    vi.mocked(createMarkdownPersistenceTransport).mockReset();
    vi.mocked(createMarkdownPersistenceTransport).mockReturnValue({
      read: async () => ({ source: disk.source, revision: disk.revision }),
      write: (intent) => {
        write(intent);
        return publication.promise.then((result) => {
          disk.source = intent.source;
          disk.revision = result.revision;
          return result;
        });
      },
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    });
    // The tab opens first; References must acquire a second lease on this owner.
    tab = markdownPersistenceRegistry.acquire(
      { environmentId, cwd, relativePath: "refsA.bib" },
      {
        relativePath: "refsA.bib",
        contents: disk.source,
        revision: disk.revision,
        byteLength: disk.source.length,
        truncated: false,
      },
    )!;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    await act(() => tab.release());
    host.remove();
    vi.unstubAllGlobals();
  });
  const mount = (
    setupSource = "\\addbibresource{refsA.bib}",
    documents: readonly BibliographyDocument[] = [],
  ) =>
    act(async () =>
      root.render(
        <LatexReferencesPanel
          open
          request={{ key: "known", sequence: 1 }}
          onClose={() => {}}
          documents={documents}
          setupSource={setupSource}
          rootRelativePath="paper.tex"
          environmentId={tab.target.environmentId}
          cwd={tab.target.cwd}
          disabled={false}
          onSetup={() => {}}
          onDraftChange={onDraftChange}
          onSaved={onSaved}
          loadDetails={false}
          onCatalogChange={() => {}}
          draftKey={`form:${draftKey}`}
          onOpenSource={() => {}}
          canOpenFiles
        />,
      ),
    );
  const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Reference title"]');
  const type = (value: string) =>
    act(() => {
      const input = field()!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const save = () =>
    act(() => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

  it("shares one saver with a tab and clears the form only after publication", async () => {
    await mount();
    expect(field()?.value).toBe("Original");
    expect(createMarkdownPersistenceTransport).toHaveBeenCalledOnce();
    await type("Updated");
    // A tab changes a different entry while the form keeps its original base.
    await act(() => {
      expect(tab.change(disk.source + "@misc{other, title = {Tab entry}}\n", 0)).toBe(true);
    });
    await save();
    expect(write).toHaveBeenCalledOnce();
    expect(tab.getSnapshot().draftSource).toContain("Updated");
    expect(tab.getSnapshot().draftSource).toContain("Tab entry");
    expect(field()?.value).toBe("Updated");
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Reference saved.");
    const guards = createMarkdownPersistenceGuards({
      files: markdownPersistenceRegistry.getSnapshot(),
      registry: markdownPersistenceRegistry,
      scope: { kind: "path", environmentId: tab.target.environmentId, cwd: tab.target.cwd },
      genericPendingIds: new Set(),
    });
    expect([...guards.pendingSurfaceIds]).toEqual(["refsA.bib"]);
    expect([...guards.quietSurfaceIds]).toEqual(["refsA.bib"]);
    await act(async () => {
      publication.resolve({ revision: "r2" });
      expect(await tab.flushNow()).toBe(true);
    });
    expect(field()).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Reference saved.");
    expect(tab.getSnapshot().pending).toBe(false);
  });

  it("keeps refsA's draft when the document switches its resource to refsB", async () => {
    await mount();
    await type("Draft for A");
    const original = tab.getSnapshot().baselineSource;
    disk.source += "@misc{other, title = {Only in B}}\n";
    await mount("\\addbibresource{refsB.bib}");
    await save();
    expect(write).not.toHaveBeenCalled();
    expect(tab.getSnapshot().draftSource).toBe(original);
    expect(disk.source).not.toContain("Draft for A");
    expect(field()?.value).toBe("Draft for A");
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).toContain("refsA.bib is no longer part of this document");
    expect(host.textContent).toContain("Your entry draft is retained");
    expect(host.textContent).not.toContain("Reference saved.");
    // Restoring the original destination makes the same retained draft saveable again.
    disk.source = original;
    await mount();
    await save();
    await act(async () => {
      publication.resolve({ revision: "r2" });
      expect(await tab.flushNow()).toBe(true);
    });
    expect(disk.source).toContain("Draft for A");
    expect(field()).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("confirms a unique entry while unrelated keys are duplicated", async () => {
    const unrelated = "@misc{other, title = {First}}\n@misc{other, title = {Second}}\n";
    await act(async () => {
      tab.change(disk.source + unrelated, 0);
      publication.resolve({ revision: "r2" });
      expect(await tab.flushNow()).toBe(true);
    });
    publication = deferred();
    write.mockClear();
    await mount();
    await type("Unique update");
    await save();
    expect(write).toHaveBeenCalledOnce();
    await act(async () => {
      publication.resolve({ revision: "r3" });
      expect(await tab.flushNow()).toBe(true);
    });
    expect(field()).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(disk.source).toContain(unrelated);
  });

  it("retains a manual draft when its document ID is reused for a different file path", async () => {
    const apply = vi.fn(() => true);
    const original: BibliographyDocument = {
      id: "root",
      path: "paperA.tex",
      source: "\\begin{thebibliography}{99}\n\\bibitem{known} Original\n\\end{thebibliography}",
      kind: "bibitem",
      readOnly: false,
      apply,
    };
    await mount("", [original]);
    const body = () =>
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reference entry text"]');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        body()!,
        "Draft for paper A",
      );
      body()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await mount("", [{ ...original, path: "paperB.tex" }]);
    await save();
    expect(apply).not.toHaveBeenCalled();
    expect(body()?.value).toBe("Draft for paper A");
    expect(host.textContent).toContain("paperA.tex is no longer part of this document");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each(["repair unrelated duplicate", "introduce unrelated malformed entry"])(
    "confirms the submitted entry when a pending save is followed by: %s",
    async (change) => {
      if (change === "repair unrelated duplicate") {
        await act(async () => {
          tab.change(
            disk.source + "@misc{other, title = {First}}\n@misc{other, title = {Second}}\n",
            0,
          );
          publication.resolve({ revision: "r2" });
          expect(await tab.flushNow()).toBe(true);
        });
        publication = deferred();
        write.mockClear();
      }
      await mount();
      await type("Entry A");
      await save();
      expect(write).toHaveBeenCalledOnce();
      let flushed!: Promise<boolean>;
      await act(() => {
        const snapshot = tab.getSnapshot();
        const next =
          change === "repair unrelated duplicate"
            ? snapshot.draftSource.replace("@misc{other, title = {First}}\n", "")
            : snapshot.draftSource + "@misc{unclosed,";
        expect(tab.change(next, snapshot.editVersion)).toBe(true);
        flushed = tab.flushNow();
      });
      const first = publication;
      publication = deferred();
      await act(async () => first.resolve({ revision: "r3" }));
      expect(write).toHaveBeenCalledTimes(2);
      await act(async () => {
        publication.resolve({ revision: "r4" });
        expect(await flushed).toBe(true);
      });
      expect(field()).toBeNull();
      expect(onSaved).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("Reference saved.");
      expect(disk.source).toContain("Entry A");
    },
  );

  it.each(["original", "concurrent"])(
    "refuses a duplicated submitted key before writing (%s)",
    async (when) => {
      const duplicate = "@misc{known, title = {Duplicate}}\n";
      if (when === "original") {
        await act(async () => {
          tab.change(disk.source + duplicate, 0);
          publication.resolve({ revision: "r2" });
          expect(await tab.flushNow()).toBe(true);
        });
        write.mockClear();
      }
      await mount();
      await type("Ambiguous update");
      if (when === "concurrent") await act(() => tab.change(disk.source + duplicate, 0));
      await save();
      expect(write).not.toHaveBeenCalled();
      expect(field()?.value).toBe("Ambiguous update");
      expect(host.textContent).toContain("Citation key known appears more than once");
      expect(onSaved).not.toHaveBeenCalled();
      if (when === "concurrent") {
        await act(async () => {
          publication.resolve({ revision: "r2" });
          expect(await tab.flushNow()).toBe(true);
        });
      }
    },
  );

  it("keeps a failed save's form draft, shows the session notice and writes no recovery record", async () => {
    await mount();
    await type("Keep this draft");
    await save();
    await act(async () => {
      publication.reject(new Error("Synthetic write failed"));
      expect(await tab.flushNow()).toBe(false);
    });
    expect(field()?.value).toBe("Keep this draft");
    expect(host.textContent).toContain("Your entry draft is retained");
    expect(host.textContent).toContain("Keep this document open and retry");
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Reference saved.");
    expect(readPersistedVisualDraft(draftKey)).toBeNull();
    expect(readStoredRecovery(draftKey)).toBeNull();
    // Unmount used to flush the unoffered bibliography checkpoint to storage.
    await act(() => root.unmount());
    expect(readPersistedVisualDraft(draftKey)).toBeNull();
    expect(readStoredRecovery(draftKey)).toBeNull();
    root = createRoot(host);
    await mount();
    expect(field()?.value).toBe("Keep this draft");
    const guards = createMarkdownPersistenceGuards({
      files: markdownPersistenceRegistry.getSnapshot(),
      registry: markdownPersistenceRegistry,
      scope: { kind: "path", environmentId: tab.target.environmentId, cwd: tab.target.cwd },
      genericPendingIds: new Set(),
    });
    expect([...guards.attentionSurfaceIds]).toEqual(["refsA.bib"]);
    // A confirmed retry can be acknowledged by Save reference without duplicating the edit.
    publication = deferred();
    await act(async () => {
      const retry = tab.retry();
      publication.resolve({ revision: "r2" });
      expect(await retry).toBe(true);
    });
    await save();
    expect(field()).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Reference saved.");
  });

  it("keeps entry A when an earlier write and superseding entry B leave a clean lane", async () => {
    await mount();
    await type("Entry A");
    let earlier!: Promise<boolean>;
    await act(() => {
      expect(tab.change(disk.source + "@misc{other, title = {Earlier edit}}\n", 0)).toBe(true);
      earlier = tab.flushNow();
    });
    expect(write).toHaveBeenCalledOnce();
    await save();
    expect(tab.getSnapshot().draftSource).toContain("Entry A");
    let flushed!: Promise<boolean>;
    await act(() => {
      const snapshot = tab.getSnapshot();
      expect(
        tab.change(snapshot.draftSource.replace("Entry A", "Entry B"), snapshot.editVersion),
      ).toBe(true);
      flushed = tab.flushNow();
    });
    const first = publication;
    publication = deferred();
    await act(async () => first.resolve({ revision: "r2" }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.every(([intent]) => !intent.source.includes("Entry A"))).toBe(true);
    await act(async () => {
      publication.resolve({ revision: "r3" });
      expect(await earlier).toBe(true);
      expect(await flushed).toBe(true);
    });
    expect(tab.getSnapshot().baselineSource).toContain("Entry B");
    expect(tab.getSnapshot().pending).toBe(false);
    expect(field()?.value).toBe("Entry A");
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Reference saved.");
    expect(host.textContent).toContain("The file changed before the reference was saved");
  });

  it("retains a refused entry edit without overwriting a tab's conflicting edit", async () => {
    await mount();
    await type("Form edit");
    await act(() => tab.change(disk.source.replace("Original", "Tab edit"), 0));
    await save();
    expect(field()?.value).toBe("Form edit");
    expect(tab.getSnapshot().draftSource).toContain("Tab edit");
    expect(write).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Your entry draft is retained");
    // Publish the tab's independent draft so the fixture leaves no pending writer.
    await act(async () => {
      publication.resolve({ revision: "r2" });
      expect(await tab.flushNow()).toBe(true);
    });
    expect(field()?.value).toBe("Form edit");
    expect(host.textContent).not.toContain("Reference saved.");
  });

  it.each(["LF", "CRLF"])(
    "can confirm a retained new entry after %s retry without adding it twice",
    async (endings) => {
      if (endings === "CRLF") {
        await act(async () => {
          expect(tab.change(disk.source.replace(/\n/gu, "\r\n"), 0)).toBe(true);
          publication.resolve({ revision: "crlf" });
          expect(await tab.flushNow()).toBe(true);
        });
        publication = deferred();
        write.mockClear();
      }
      await mount();
      await act(() =>
        [...host.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Add reference")!
          .click(),
      );
      await type("New entry");
      await save();
      await act(async () => {
        publication.reject(new Error("Synthetic write failed"));
        expect(await tab.flushNow()).toBe(false);
      });
      expect(field()?.value).toBe("New entry");
      expect(onSaved).not.toHaveBeenCalled();
      publication = deferred();
      await act(async () => {
        const retry = tab.retry();
        publication.resolve({ revision: "r2" });
        expect(await retry).toBe(true);
      });
      await save();
      expect(field()).toBeNull();
      expect(onSaved).toHaveBeenCalledOnce();
      expect(disk.source.match(/@misc\{reference1/gu)).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(2);
      if (endings === "CRLF") expect(disk.source).not.toMatch(/(?<!\r)\n/u);
    },
  );
});
