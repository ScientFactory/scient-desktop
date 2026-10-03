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
  useProjectFileQuery: () => ({
    authoritativeData: {
      relativePath: "refs.bib",
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
import { LatexReferencesPanel } from "./LatexReferencesPanel";
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
    draftKey = `${environmentId}\0${cwd}\0refs.bib`;
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
      { environmentId, cwd, relativePath: "refs.bib" },
      {
        relativePath: "refs.bib",
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
  const mount = () =>
    act(async () =>
      root.render(
        <LatexReferencesPanel
          open
          request={{ key: "known", sequence: 1 }}
          onClose={() => {}}
          documents={[]}
          setupSource="\\addbibresource{refs.bib}"
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
    expect([...guards.pendingSurfaceIds]).toEqual(["refs.bib"]);
    expect([...guards.quietSurfaceIds]).toEqual(["refs.bib"]);
    await act(async () => {
      publication.resolve({ revision: "r2" });
      expect(await tab.flushNow()).toBe(true);
    });
    expect(field()).toBeNull();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Reference saved.");
    expect(tab.getSnapshot().pending).toBe(false);
  });

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
    expect([...guards.attentionSurfaceIds]).toEqual(["refs.bib"]);
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

  it("can confirm a retained new entry after retry without adding it twice", async () => {
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
  });
});
