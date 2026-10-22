import { expect, it } from "vite-plus/test";
import { installMathReadingPreview } from "./mathReadingPreview";

function preview(_fixture: _Fixture) {
  const host = document.createElement("span");
  _fixture.hosts.push(host);
  document.body.append(host);
  const root = installMathReadingPreview(host);
  const content = root.querySelector<HTMLElement>("[data-math-preview-content]")!;
  content.innerHTML = '<span class="ML__mathlive">x</span>';
  return { host, root, content };
}

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.hosts.splice(0).forEach((host) => host.remove());
}

it("styles each formula from the same text without duplicating content or changing its state", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const first = preview(_fixture);
  const style = first.root.querySelector("style")!;
  expect(first.root.adoptedStyleSheets).toHaveLength(0);
  expect(style.textContent).not.toMatch(/@font-face/u);
  expect(style.textContent).toContain("::selection");
  first.content.dataset.mathPreviewReady = "";
  for (let index = 0; index < 100; index++) {
    const next = preview(_fixture);
    expect(next.root.querySelector("style")!.textContent).toBe(style.textContent);
    expect(next.content.textContent).toBe("x");
  }
  expect(installMathReadingPreview(first.host)).toBe(first.root);
  expect(first.root.querySelectorAll("style")).toHaveLength(1);
  expect(first.root.querySelectorAll("[data-math-preview-content]")).toHaveLength(1);
  expect(first.content.hasAttribute("data-math-preview-ready")).toBe(true);
  expect(first.content.textContent).toBe("x");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    hosts: [] as HTMLElement[],
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
