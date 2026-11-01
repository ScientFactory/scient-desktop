import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import ChatMarkdown from "~/components/ChatMarkdown";
import { computeEnvironment } from "~/state/compute";
import { render, stubGlobal } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";

const assets = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => assets.refresh,
}));

const dataUrl = "https://notebook-privacy.invalid/open.csv";
const chartSource = JSON.stringify({
  data: { url: dataUrl, format: { type: "csv" } },
  mark: "point",
  encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
});
// The final newline before the closing fence is part of the Markdown code body.
const fence = (language: string, source: string) => `\`\`\`${language}\n${source}\n\`\`\``;

function observeChartRequests() {
  const nativeFetch = globalThis.fetch;
  const requests = vi.fn();
  const replacement: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === dataUrl) {
      requests(url);
      return Promise.resolve(
        new Response("x,y\n1,2\n", { headers: { "content-type": "text/csv" } }),
      );
    }
    return nativeFetch(input, init);
  };
  return { requests, ...stubGlobal("fetch", replacement) };
}

function savedNotebook(markdown: string) {
  return new Blob(
    [
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { language_info: { name: "python" } },
        cells: [
          { cell_type: "markdown", metadata: {}, source: markdown },
          {
            cell_type: "code",
            metadata: {},
            source: 'raise RuntimeError("must never execute")',
            execution_count: 17,
            outputs: [
              { output_type: "stream", name: "stdout", text: "Saved output from an earlier run" },
            ],
          },
        ],
      }),
    ],
    { type: "application/x-ipynb+json" },
  );
}

describe("saved notebook Markdown privacy", () => {
  it.each(["local attachment", "workspace grant"] as const)(
    "keeps every rich-fence alias as exact inert source through the %s preview",
    async (route) => {
      const aliases = [
        "mermaid",
        "plotly",
        "plotly.js",
        "plotly-json",
        "plotlyjs",
        "vega-lite",
        "vegalite",
        "vl",
      ];
      const languages = aliases.flatMap((language) => [language, language.toUpperCase()]);
      const sources = languages.map((language) =>
        language.toLowerCase() === "mermaid"
          ? 'flowchart LR\nA["Saved diagram"] --> B'
          : language.toLowerCase().startsWith("plotly")
            ? '{"data":[{"x":[1,2],"y":[3,4],"type":"scatter"}]}'
            : chartSource,
      );
      const ordinarySource = 'const preserved = "ordinary code";';
      const file = savedNotebook(
        [
          ...languages.map((language, index) => fence(language, sources[index]!)),
          fence("javascript", ordinarySource),
        ].join("\n\n"),
      );
      const url = URL.createObjectURL(file);
      using resources = new DisposableStack();
      resources.defer(() => URL.revokeObjectURL(url));
      assets.refresh.mockReset().mockResolvedValue(url);
      using network = observeChartRequests();
      using start = vi.spyOn(computeEnvironment.startSession, "run").mockImplementation(() => {
        throw new Error("Saved notebook preview must not start Compute");
      });
      using execute = vi.spyOn(computeEnvironment.submitExecution, "run").mockImplementation(() => {
        throw new Error("Saved notebook preview must not execute code");
      });
      await using screen = await render(
        <div style={{ display: "flex", height: 600, width: 800 }}>
          <AttachmentFilePreview
            name="saved.ipynb"
            mimeType={file.type}
            sizeBytes={file.size}
            {...(route === "local attachment"
              ? { file }
              : {
                  asset: {
                    environmentId: EnvironmentId.make("notebook-test"),
                    resource: {
                      _tag: "workspace-file" as const,
                      cwd: "/synthetic",
                      relativePath: "saved.ipynb",
                    },
                  },
                })}
          />
        </div>,
      );
      await vi.waitFor(() => {
        const blocks = screen.container.querySelectorAll('[aria-label="Cell 1"] [data-language]');
        expect(Array.from(blocks, (block) => block.querySelector("pre code")?.textContent)).toEqual(
          [...sources, ordinarySource].map((source) => `${source}\n`),
        );
        expect(Array.from(blocks, (block) => block.getAttribute("data-language"))).toEqual([
          ...languages.map(() => "text"),
          "javascript",
        ]);
        expect(screen.container.textContent).toContain("Saved output from an earlier run");
      });
      expect(screen.container.querySelector("[data-scient-visual-card]")).toBeNull();
      expect(network.requests).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(screen.container.querySelector('[aria-label="Run in terminal"]')).toBeNull();
    },
  );

  it("keeps the same remote-data chart active in ordinary chat but inert in a saved notebook", async () => {
    assets.refresh.mockReset();
    using network = observeChartRequests();
    const markdown = fence("vega-lite", chartSource);
    const file = savedNotebook(markdown);
    await using notebook = await render(
      <div style={{ display: "flex", height: 400, width: 700 }}>
        <AttachmentFilePreview
          name="remote.ipynb"
          mimeType={file.type}
          sizeBytes={file.size}
          file={file}
        />
      </div>,
    );
    await vi.waitFor(() => {
      expect(network.requests).not.toHaveBeenCalled();
      expect(
        notebook.container.querySelector('[aria-label="Cell 1"] [data-language="text"] pre code')
          ?.textContent,
      ).toBe(`${chartSource}\n`);
    });
    expect(network.requests).not.toHaveBeenCalled();
    await using chat = await render(<ChatMarkdown cwd={undefined} text={markdown} />);
    await vi.waitFor(() => {
      expect(chat.container.querySelector(".vega-embed svg .mark-symbol path")).not.toBeNull();
      expect(network.requests).toHaveBeenCalledWith(dataUrl);
    });
    expect(notebook.container.querySelector("[data-scient-visual-card]")).toBeNull();
  });
});
