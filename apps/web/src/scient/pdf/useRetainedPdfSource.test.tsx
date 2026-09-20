// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ArtifactAuthority,
  LogicalDocumentKey,
  type PdfSourceDescriptor,
  type PdfSourceResolution,
} from "@scientfactory/document-artifacts";
import { useRetainedPdfSource } from "./useRetainedPdfSource";

const source: PdfSourceDescriptor = {
  _tag: "workspace-pdf",
  authority: ArtifactAuthority.make("env"),
  logicalDocumentKey: LogicalDocumentKey.make("doc"),
  workspaceRoot: "/workspace",
  relativePath: "main.pdf",
  title: "Main",
  fileName: "main.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
};
const refresh = () => {};
const success = (url: string): PdfSourceResolution => ({
  _tag: "Success",
  url,
  expiresAt: 99999999,
  refresh,
});
afterEach(() => vi.unstubAllGlobals());

it("retains the reader through asset loading/failure, replaces it on success, and never leaks across documents", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mount = document.createElement("div");
  const root = createRoot(mount);
  let displayed: ReturnType<typeof useRetainedPdfSource> = null;
  function Probe({ identity, asset }: { identity: string; asset: PdfSourceResolution }) {
    displayed = useRetainedPdfSource(identity, source, asset);
    return displayed ? <textarea defaultValue="active input" /> : null;
  }
  const render = async (identity: string, asset: PdfSourceResolution) => {
    await act(() => root.render(<Probe identity={identity} asset={asset} />));
  };
  await render("env/doc", success("pdf-one"));
  const input = mount.querySelector("textarea");
  await render("env/doc", { _tag: "Loading", refresh });
  expect(mount.querySelector("textarea")).toBe(input);
  expect(displayed).toMatchObject({ asset: { url: "pdf-one" } });
  await render("env/doc", { _tag: "Failure", refresh });
  expect(mount.querySelector("textarea")).toBe(input);
  await render("env/doc", success("pdf-two"));
  expect(mount.querySelector("textarea")).toBe(input);
  expect(displayed).toMatchObject({ asset: { url: "pdf-two" } });
  await render("another-env/doc", { _tag: "Loading", refresh });
  expect(displayed).toBeNull();
  expect(mount.querySelector("textarea")).toBeNull();
  await act(() => root.unmount());
});
