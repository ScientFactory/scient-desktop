import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";

import { OfficeFilePreview } from "~/components/files/OfficeFilePreview";
import { render, stubGlobal } from "../../../test/render";
import { documentCache } from "../documentCache/documentCache";
import { DocumentIdentityContext } from "../documentCache/documentIdentity";
import type { OfficeSessionSlot } from "./officeSession";

const { sessions, failing } = vi.hoisted(() => ({
  sessions: [] as unknown[],
  failing: {
    engine: null as OfficeSessionSlot["current"],
  },
}));
// The Word engine compiles about 30 MB of WebAssembly per worker; what matters here is which
// prepared document and session reach the viewer, so the stand-in records them and shows the text.
vi.mock(import("~/components/files/office/WordDocument"), async () => {
  const { use } = await import("react");
  const { default: Zip } = await import("jszip");
  const texts = new WeakMap<ArrayBuffer, Promise<string>>();
  return {
    default: ({
      bytes,
      session,
      onError,
    }: {
      bytes: ArrayBuffer;
      session?: OfficeSessionSlot | undefined;
      onError: (cause: unknown) => void;
    }) => {
      sessions.push(session);
      if (failing.engine && session) {
        session.current = failing.engine;
        queueMicrotask(() => onError(new Error("The engine stopped.")));
      }
      let text = texts.get(bytes);
      if (!text)
        texts.set(
          bytes,
          (text = Zip.loadAsync(bytes)
            .then((zip) => zip.file("word/document.xml")!.async("string"))
            .then((xml) => xml.replace(/<[^>]+>/g, " "))),
        );
      return <pre>{use(text)}</pre>;
    },
  };
});

async function docx(text: string) {
  return new JSZip()
    .file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    )
    .generateAsync({ type: "arraybuffer" });
}

/** A fresh cache and a file server whose reads are counted. */
function setup() {
  documentCache.clear();
  sessions.length = 0;
  failing.engine = null;
  const fetch = vi.fn(async () => new Response(await docx("Outlook")));
  return { fetch, stub: stubGlobal("fetch", fetch) };
}

const preview = (identity: string | null, src: string) => (
  <DocumentIdentityContext value={identity}>
    <OfficeFilePreview src={src} name="outlook.docx" kind="docx" />
  </DocumentIdentityContext>
);

// regression: leaving a Word file and coming back fetched, prepared and laid it out again.
describe("kept Office documents", () => {
  it("shows a Word file left recently without reading or opening it again", async () => {
    const { fetch, stub } = setup();
    using _fetch = stub;
    await using screen = await render(preview("outlook@r1", "https://files.test/a"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Outlook"));
    // Another file opens in the panel, then this one again under a renewed URL.
    await screen.rerender(null);
    await screen.rerender(preview("outlook@r1", "https://files.test/a-renewed"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Outlook"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(sessions.at(-1)).toBe(sessions[0]);
    // A new revision of the file is read afresh.
    await screen.rerender(null);
    await screen.rerender(preview("outlook@r2", "https://files.test/a-changed"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("reads a file of unknown revision afresh each time", async () => {
    const { fetch, stub } = setup();
    using _fetch = stub;
    await using screen = await render(preview(null, "https://files.test/a"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Outlook"));
    await screen.rerender(null);
    await screen.rerender(preview(null, "https://files.test/a"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(documentCache.idleKeys()).toEqual([]);
  });

  it("closes a failed engine at once, while its error shows, and does not keep it", async () => {
    const { stub } = setup();
    using _fetch = stub;
    const close = vi.fn();
    failing.engine = { close, memory: () => 1, failed: () => true };
    await using screen = await render(preview("outlook@r1", "https://files.test/a"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("The engine stopped."));
    expect(close).toHaveBeenCalledOnce();
    await screen.rerender(null);
    expect(documentCache.idleKeys()).toEqual([]);
  });
});
