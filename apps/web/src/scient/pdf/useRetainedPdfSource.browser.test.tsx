import { render as _fixtureRender, act } from "../../../test/render";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";
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
const success = (url: string): Extract<PdfSourceResolution, { readonly _tag: "Success" }> => ({
  _tag: "Success",
  url,
  expiresAt: 99999999,
  refresh,
});
async function _cleanupFixture0(_fixture: _Fixture) {
  await vi.unstubAllGlobals();
}

it("retains the reader through asset loading/failure, replaces it on success, and never leaks across documents", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const mount = document.createElement("div");
  const root = _fixture.stack.use(await _fixtureRender(null, { container: mount, router: false }));
  let displayed: ReturnType<typeof useRetainedPdfSource> = null;
  function Probe({ identity, asset }: { identity: string; asset: PdfSourceResolution }) {
    const retained = useRetainedPdfSource(identity, source, asset);
    useLayoutEffect(() => {
      displayed = retained;
    });
    return retained ? <textarea defaultValue="active input" /> : null;
  }
  const render = async (identity: string, asset: PdfSourceResolution) => {
    await act(async () => await root.rerender(<Probe identity={identity} asset={asset} />));
  };
  await render("env/doc", success("pdf-one"));
  const input = mount.querySelector("textarea");
  await render("env/doc", { ...success("unsettled-pdf"), waiting: true });
  expect(mount.querySelector("textarea")).toBe(input);
  expect(displayed).toMatchObject({ asset: { url: "pdf-one" } });
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
  await render("another-env/doc", { ...success("unsettled-pdf"), waiting: true });
  expect(displayed).toBeNull();
  expect(mount.querySelector("textarea")).toBeNull();
  await act(async () => await root.unmount());
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
