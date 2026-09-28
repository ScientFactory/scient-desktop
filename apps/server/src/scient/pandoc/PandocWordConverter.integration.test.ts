// @effect-diagnostics nodeBuiltinImport:off -- Local integration: builds attack fixtures on disk and copies review artifacts.
/**
 * LOCAL INTEGRATION TESTS against the real, managed Pandoc 3.11 binary.
 *
 * They run only when `SCIENT_PANDOC_BINARY` names the pinned binary (for
 * example the one the Pandoc qualification downloaded) and are skipped
 * otherwise; nothing here downloads Pandoc. Set `SCIENT_PANDOC_FIXTURE_OUT`
 * to a directory to keep the fixture `.docx` files for review in Word.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  PandocWordConverter,
  layer as converterLayer,
  type WordConversionInput,
} from "./PandocWordConverter.ts";
import {
  CITATIONS,
  CITATIONS_MARKDOWN,
  wordFixtures,
  type WordFixture,
} from "./pandocWordFixtures.ts";
import {
  PNG_BYTES,
  bytesAsset,
  count,
  makeBundle,
  managedToolLayer,
  pandocBinaryForTests,
  readDocx,
} from "./pandocTestSupport.ts";
import { prepareLatexProject } from "./latexProjectPreparation.ts";
import { planWordDiagrams } from "./wordDiagramCapture.ts";

const binary = pandocBinaryForTests();
const artifactDirectory = process.env.SCIENT_PANDOC_FIXTURE_OUT?.trim() || null;

const withConverter = <A, E>(
  body: (input: {
    readonly converter: PandocWordConverter["Service"];
    readonly directory: string;
    readonly scratchRoot: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-word-" });
    const scratchRoot = NodePath.join(directory, "scratch");
    const layer = converterLayer.pipe(
      Layer.provide(
        managedToolLayer({ command: { command: binary ?? "", leadingArgs: [] }, scratchRoot }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const converter = yield* PandocWordConverter;
      return yield* body({ converter, directory, scratchRoot });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const convertTo = (
  converter: PandocWordConverter["Service"],
  directory: string,
  name: string,
  input: Omit<WordConversionInput, "outputPath">,
) =>
  Effect.gen(function* () {
    const outputPath = NodePath.join(directory, `${name}.docx`);
    const result = yield* converter.convert({ ...input, outputPath });
    if (artifactDirectory !== null) {
      NodeFS.mkdirSync(artifactDirectory, { recursive: true });
      NodeFS.copyFileSync(outputPath, NodePath.join(artifactDirectory, `${name}.docx`));
    }
    const docx = yield* readDocx(outputPath);
    return { result, docx, outputPath };
  });

const FAKE_SECRET = /FAKE-SECRET-[A-Z]+/u;

/** Several thousand sections with math: seconds of Pandoc work and far more than a tiny heap. */
const largeBundle = () =>
  makeBundle({
    markdown: Array.from(
      { length: 6000 },
      (_, index) => `## Section ${index}\n\nParagraph ${index} with $x_${index}^2$ math.\n`,
    ).join("\n"),
    assets: [bytesAsset({ id: "photo", bytes: PNG_BYTES })],
  });

describe.skipIf(binary === null)("Word export with the real Pandoc (local integration)", () => {
  it.live("embeds the captured image of CRLF and tab-indented Mermaid fences", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const markdown = [
          "```mermaid",
          "flowchart LR",
          "\tA --> B",
          "```",
          "",
          "- item",
          "",
          "  ```mermaid",
          "  flowchart TD",
          "  \tC\t-->\tD",
          "  ```",
          "",
        ].join("\r\n");
        const assets = planWordDiagrams(markdown, `sha256:${"a".repeat(64)}`).diagrams.map(
          ({ id }) => bytesAsset({ id, bytes: PNG_BYTES, role: "rendered-diagram" }),
        );
        expect(assets).toHaveLength(2);
        const { result, docx } = yield* convertTo(converter, directory, "mermaid-crlf-tabs", {
          bundle: makeBundle({ markdown, assets }),
        });
        const xml = docx.text("word/document.xml");
        expect(xml).not.toContain("Mermaid diagram source (image unavailable)");
        expect(count(xml, /<pic:pic\b/gu)).toBe(2);
        expect(result.warnings.map((warning) => warning.message).join("\n")).not.toContain(
          "no rendered image",
        );
      }),
    ),
  );

  it.live("keeps text inside a complete raw HTML details block in the Word file", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const { docx } = yield* convertTo(converter, directory, "details-body", {
          bundle: makeBundle({
            markdown: "<details><summary>Result</summary><p>Important finding</p></details>",
          }),
        });
        const xml = docx.text("word/document.xml");
        expect(xml).toContain("Result");
        expect(xml).toContain("Important finding");
      }),
    ),
  );

  it.live("keeps both contiguous raw HTML details siblings in the Word file", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const { docx } = yield* convertTo(converter, directory, "details-siblings", {
          bundle: makeBundle({
            markdown:
              "<details><summary>First</summary><p>First body</p></details>\n<details><summary>Second</summary><p>Second body</p></details>",
          }),
        });
        const xml = docx.text("word/document.xml");
        expect(xml).toContain("First body");
        expect(xml).toContain("Second body");
        expect(xml).toContain("First");
        expect(xml).toContain("Second");
        expect(xml).not.toContain("&lt;details");
      }),
    ),
  );

  it.live("keeps a complete details sibling before an open one in the Word file", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const { docx } = yield* convertTo(converter, directory, "details-mixed-siblings", {
          bundle: makeBundle({
            markdown: [
              "<details><summary>First</summary><p>First body</p></details>",
              "<details><summary>Second</summary><p>Second body</p>",
              "",
              "Continuation",
              "",
              "</details>",
            ].join("\n"),
          }),
        });
        const xml = docx.text("word/document.xml");
        expect(xml).toContain("First body");
        expect(xml).toContain("Second body");
        expect(xml).toContain("Continuation");
        expect(xml).toContain("Second");
      }),
    ),
  );

  it.live("keeps both details when Pandoc puts a close and next open in one raw block", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const { docx } = yield* convertTo(converter, directory, "details-close-next-open", {
          bundle: makeBundle({
            markdown:
              "<details><summary>First</summary>\n\nFirst body\n\n</details>\n<details><summary>Second</summary><p>Second body</p></details>",
          }),
        });
        const xml = docx.text("word/document.xml");
        expect(xml).toContain("First body");
        expect(xml).toContain("Second body");
        expect(xml).toContain("Second");
      }),
    ),
  );

  it.live("converts a nested LaTeX project with an embedded figure and local bibliography", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const paper = NodePath.join(directory, "paper");
        NodeFS.mkdirSync(NodePath.join(paper, "chapters"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(paper, "figures"));
        NodeFS.writeFileSync(
          NodePath.join(paper, "main.tex"),
          [
            "\\documentclass{article}",
            "\\usepackage{graphicx}",
            "\\graphicspath{{figures/}}",
            "\\begin{document}",
            "\\input{chapters/intro}",
            "\\includegraphics[width=0.5\\textwidth]{plot}",
            "\\bibliography{refs}",
            "\\end{document}",
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(paper, "chapters", "intro.tex"),
          "\\section{Findings} Project-level content with $x^2$. \\cite{local2026}",
        );
        NodeFS.writeFileSync(
          NodePath.join(paper, "refs.bib"),
          "@article{local2026, author={Ada Example}, title={Local reference}, journal={Journal}, year={2026}}\n",
        );
        NodeFS.writeFileSync(NodePath.join(paper, "figures", "plot.png"), PNG_BYTES);
        const latex = yield* prepareLatexProject(NodePath.join(paper, "main.tex"), directory);
        const output = yield* convertTo(converter, directory, "latex-project", {
          bundle: makeBundle({ markdown: "" }),
          latex,
          files: { baseDirectory: paper, allowRoots: [paper] },
        });
        const xml = output.docx.text("word/document.xml");
        expect(xml).toContain("Project-level content");
        expect(xml).toContain("Local Reference");
        expect(xml).toContain("<m:oMath>");
        expect(
          [...output.docx.entries.keys()].filter((name) => name.startsWith("word/media/")),
        ).toHaveLength(1);
        expect(output.result.summary.embeddedImages).toBe(1);
        // The source's width survives: half the text width, not the 2-pixel PNG's own size.
        const extent = /<wp:extent cx="(\d+)"/u.exec(xml);
        expect(Number(extent?.[1])).toBeGreaterThan(2_000_000);
      }),
    ),
  );
  it.live(
    "does not disclose files named by LaTeX includes or bibliography outside the project",
    () =>
      withConverter(({ converter, directory }) =>
        Effect.gen(function* () {
          const project = NodePath.join(directory, "project");
          const paper = NodePath.join(project, "paper");
          NodeFS.mkdirSync(paper, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(directory, "secret.tex"), "FAKE-SECRET-TEX");
          NodeFS.writeFileSync(
            NodePath.join(directory, "secret.bib"),
            "@article{secret, title={FAKE-SECRET-BIB}, year={2026}}",
          );
          NodeFS.writeFileSync(
            NodePath.join(paper, "main.tex"),
            [
              "\\documentclass{article}\\begin{document}",
              "\\input{../../secret}",
              "\\bibliography{../../secret}",
              "\\nocite{*}",
              "Safe text.\\end{document}",
            ].join("\n"),
          );
          const latex = yield* prepareLatexProject(NodePath.join(paper, "main.tex"), project);
          const output = yield* convertTo(converter, directory, "latex-secure", {
            bundle: makeBundle({ markdown: "" }),
            latex,
            files: { baseDirectory: paper, allowRoots: [project] },
          });
          const xml = output.docx.text("word/document.xml");
          expect(xml).toContain("Safe text");
          expect(xml).toContain("Include outside the project folder");
          expect(xml).not.toContain("FAKE-SECRET-TEX");
          expect(xml).not.toContain("FAKE-SECRET-BIB");
        }),
      ),
  );
  it.live("converts the fixture set with editable equations, tables, notes, and styles", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const byName = new Map<string, WordFixture>(
          wordFixtures().map((fixture) => [fixture.name, fixture]),
        );
        const convert = (name: string) =>
          convertTo(converter, directory, name, { bundle: byName.get(name)!.bundle });

        const math = yield* convert("01-math");
        const mathXml = math.docx.text("word/document.xml");
        expect(count(mathXml, /<m:oMath>/gu)).toBeGreaterThanOrEqual(20);
        expect(count(mathXml, /<m:oMathPara>/gu)).toBe(4);
        // Every equation is native OMML; none survives as literal TeX.
        expect(mathXml).not.toMatch(/\\frac|\\begin\{/u);

        const tables = yield* convert("02-tables");
        const tablesXml = tables.docx.text("word/document.xml");
        expect(count(tablesXml, /<w:tbl>/gu)).toBe(3);
        expect(tablesXml).toContain('<w:tblStyle w:val="Table" />');
        // The wide table gets proportional, not equal, columns.
        const wideGrid = /<w:tblGrid>((?:<w:gridCol w:w="\d+" \/>){12})<\/w:tblGrid>/u.exec(
          tablesXml,
        );
        expect(wideGrid).not.toBeNull();
        expect(tablesXml).toContain('<w:tblHeader w:val="on" />');

        const hebrew = yield* convert("03-hebrew-mixed");
        const hebrewXml = hebrew.docx.text("word/document.xml");
        // Hebrew paragraph, heading, two Hebrew list items, and the Hebrew table cells.
        expect(count(hebrewXml, /<w:bidi \/>/gu)).toBeGreaterThanOrEqual(6);
        expect(hebrew.result.summary.rtlDocument).toBe(false);
        expect(hebrew.result.warnings.map((warning) => warning.message).join("\n")).toContain(
          "keep left-to-right column order",
        );

        const rtl = yield* convert("03b-hebrew-document");
        const rtlXml = rtl.docx.text("word/document.xml");
        expect(rtl.result.summary.rtlDocument).toBe(true);
        expect(count(rtlXml, /<w:bidi \/>/gu)).toBeGreaterThanOrEqual(4);
        expect(rtlXml).toMatch(/<w:lang w:val="he"|w:bidi w:val="he"/u);

        const code = yield* convert("04-code-alerts-tasks-mermaid");
        const codeXml = code.docx.text("word/document.xml");
        expect(codeXml).toContain('<w:pStyle w:val="SourceCode" />');
        expect(codeXml).toContain('<w:pStyle w:val="ScientAlert" />');
        expect(codeXml).toContain('<w:pStyle w:val="ScientTaskList" />');
        expect(codeXml).toContain("☐");
        expect(codeXml).toContain("☑");
        // One Mermaid diagram was rendered by the bundle; the other shows its source.
        expect(
          [...code.docx.entries.keys()].filter((name) => name.startsWith("word/media/")),
        ).toHaveLength(1);
        expect(codeXml).toContain("Mermaid diagram source (image unavailable)");
        expect(codeXml).toContain("graph LR; X--&gt;Y");

        const images = yield* convert("05-images");
        const imageEntries = [...images.docx.entries.keys()].filter((name) =>
          name.startsWith("word/media/"),
        );
        // The PNG, the SVG's PNG rendering, and the SVG without one.
        expect(imageEntries).toHaveLength(3);
        expect(images.result.summary.placeholders).toBe(2);
        const imagesXml = images.docx.text("word/document.xml");
        expect(
          count(imagesXml, /<w:rStyle w:val="ScientPlaceholder" \/>/gu),
        ).toBeGreaterThanOrEqual(2);

        const footnotes = yield* convert("06-footnotes");
        expect(count(footnotes.docx.text("word/footnotes.xml"), /<w:footnote w:id="\d+">/gu)).toBe(
          3,
        );

        const citations = yield* convert("07-citations");
        const citationsXml = citations.docx.text("word/document.xml");
        expect(citations.result.summary.citedReferences).toBe(3);
        expect(citationsXml).toContain('<w:pStyle w:val="Bibliography" />');
        expect(count(citationsXml, /<w:pStyle w:val="Bibliography" \/>/gu)).toBe(3);
        expect(citationsXml).toContain("[@nobody2000]");
        expect(citationsXml).toContain("mail@example.com");
        expect(citations.result.warnings.map((warning) => warning.message).join("\n")).toContain(
          "@nobody2000",
        );

        const conversation = yield* convert("08-conversation");
        const conversationXml = conversation.docx.text("word/document.xml");
        expect(conversationXml).toContain('<w:pStyle w:val="ScientWorkLog" />');
        expect(conversationXml).toContain('<w:pStyle w:val="ScientReasoning" />');
        expect(conversationXml).toContain("Work log · ");
        expect(conversationXml).toContain(">Reasoning<");
        expect(conversationXml).toContain('<w:rStyle w:val="ScientSpeakerUser" />');
        expect(conversationXml).toContain('<w:rStyle w:val="ScientSpeakerAssistant" />');
        expect(conversationXml).not.toContain("scient:message");
        expect(count(conversationXml, /<m:oMath>/gu)).toBeGreaterThanOrEqual(2);
        expect(conversationXml).toContain("<w:bidi />");
        // The bundle's notes appear once: the Markdown already lists them.
        expect(count(conversationXml, /This export includes the work log and reasoning/gu)).toBe(1);
        expect(conversation.result.summary.workLogBlocks).toBe(1);
        expect(conversation.result.summary.reasoningBlocks).toBe(1);

        // The reference document's styles are the ones in the file.
        const styles = conversation.docx.text("word/styles.xml");
        for (const name of [
          "Scient Work Log",
          "Scient Reasoning",
          "Scient Placeholder",
          "Scient Alert",
          "Scient Task List",
          "Scient Speaker User",
          "Scient Speaker Assistant",
        ]) {
          expect(styles).toContain(`<w:name w:val="${name}" />`);
        }
      }),
    ),
  );

  it.live("carries document notes the Markdown does not show into the Word file", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const bundle = {
          ...makeBundle({ markdown: "# Notes\n\nBody text.\n" }),
          warnings: [
            {
              code: "sensitive-content-included" as const,
              message: "This export includes the work log, which can contain secrets.",
            },
          ],
        };
        const { docx, result } = yield* convertTo(converter, directory, "11-document-notes", {
          bundle,
        });
        const xml = docx.text("word/document.xml");
        expect(xml).toContain("Conversion notes");
        expect(xml).toContain("This export includes the work log, which can contain secrets.");
        expect(result.warnings.map((warning) => warning.code)).toContain(
          "sensitive-content-included",
        );
      }),
    ),
  );

  it.live("blocks every qualification attack or turns it into a placeholder", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        // A fake home outside the document's folder, and a folder the export may read.
        const home = NodePath.join(directory, "fakehome");
        const allowed = NodePath.join(directory, "project");
        NodeFS.mkdirSync(NodePath.join(home, ".ssh"), { recursive: true });
        NodeFS.mkdirSync(allowed, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(home, "notes.txt"), "FAKE-SECRET-NOTES");
        NodeFS.writeFileSync(NodePath.join(home, ".ssh", "id_rsa"), "FAKE-SECRET-SSHKEY");
        NodeFS.writeFileSync(
          NodePath.join(home, "secret.bib"),
          "@misc{leak, title={FAKE-SECRET-BIB}}\n",
        );
        NodeFS.writeFileSync(NodePath.join(allowed, "renamed.png"), "FAKE-SECRET-RENAMED");
        NodeFS.writeFileSync(NodePath.join(allowed, "ok.png"), PNG_BYTES);
        NodeFS.symlinkSync(NodePath.join(home, "notes.txt"), NodePath.join(allowed, "link.png"));
        const dataUri = `data:text/plain;base64,${Buffer.from("FAKE-SECRET-DATAURI").toString("base64")}`;

        const markdown = [
          "---",
          `bibliography: ${NodePath.join(home, "secret.bib")}`,
          "csl: http://127.0.0.1:9/evil.csl",
          "nocite: '@*'",
          `reference-doc: ${NodePath.join(home, "notes.txt")}`,
          "---",
          "",
          "# Attacks",
          "",
          `![abs](${NodePath.join(home, "notes.txt")})`,
          "",
          "![traversal](../fakehome/.ssh/id_rsa)",
          "",
          `![file url](file://${NodePath.join(home, "notes.txt")})`,
          "",
          "![symlink](link.png)",
          "",
          "![renamed](renamed.png)",
          "",
          `![data](${dataUri})`,
          "",
          "![remote](http://127.0.0.1:9/pixel.png)",
          "",
          "![legitimate](ok.png)",
          "",
          `<img src="${NodePath.join(home, "notes.txt")}">`,
          "",
          "\\input{/etc/hosts}",
          "",
          "```{=openxml}",
          '<w:p><w:r><w:fldSimple w:instr="INCLUDEPICTURE &quot;http://127.0.0.1:9/x.png&quot;"/></w:r></w:p>',
          "```",
          "",
          "Inline `<w:r><w:t>raw</w:t></w:r>`{=openxml} stays text.",
          "",
        ].join("\n");

        const { result, docx } = yield* convertTo(converter, directory, "09-security", {
          bundle: makeBundle({ markdown }),
          files: { baseDirectory: allowed, allowRoots: [allowed] },
        });
        const everything = docx.allText();
        expect(everything).not.toMatch(FAKE_SECRET);
        const documentXml = docx.text("word/document.xml");
        // No injected OpenXML: no field codes and no fldSimple element.
        expect(documentXml).not.toMatch(/<w:fldSimple|<w:instrText/u);
        expect(result.summary.embeddedImages).toBe(1);
        expect(result.summary.placeholders).toBe(7);
        const messages = result.warnings.map((warning) => warning.message).join("\n");
        expect(messages).toContain("named a bibliography");
        expect(messages).toContain("named a csl");
        expect(messages).toContain("named a reference-doc");
        expect(messages).toContain("Raw HTML was left out");
        // Nothing names the fake home in what the user is shown.
        expect(messages).not.toContain(home);
      }),
    ),
  );

  it.live("never lets citeproc read metadata bibliographies or fetch a remote CSL", () =>
    withConverter(({ converter, directory }) =>
      Effect.gen(function* () {
        const secretBib = NodePath.join(directory, "secret.bib");
        NodeFS.writeFileSync(secretBib, "@misc{einstein1905, title={FAKE-SECRET-CITEPROC}}\n");
        const markdown = [
          "---",
          `bibliography: ${secretBib}`,
          "csl: http://127.0.0.1:9/evil.csl",
          "citation-abbreviations: http://127.0.0.1:9/abbrev.json",
          "---",
          "",
          CITATIONS_MARKDOWN,
        ].join("\n");
        const { docx, result } = yield* convertTo(converter, directory, "10-citeproc-metadata", {
          bundle: makeBundle({ markdown, citations: CITATIONS }),
        });
        expect(docx.allText()).not.toMatch(FAKE_SECRET);
        // The references come from the bundle's CSL-JSON, not the metadata file.
        expect(docx.text("word/document.xml").toLowerCase()).toContain("annalen der physik");
        expect(result.summary.citedReferences).toBe(3);
      }),
    ),
  );

  it.live(
    "stops on the heap limit, the output limit, and the timeout, leaving nothing behind",
    () =>
      withConverter(({ converter, directory, scratchRoot }) =>
        Effect.gen(function* () {
          const bundle = largeBundle();
          const outputPath = NodePath.join(directory, "limited.docx");
          const attempt = (limits: NonNullable<WordConversionInput["limits"]>) =>
            converter.convert({ bundle, outputPath, limits }).pipe(Effect.flip);

          const heap = yield* attempt({
            read: { timeout: "30 seconds", maxHeapMb: 16, maxStdoutBytes: 1024 * 1024 * 64 },
          });
          expect(heap.reason).toBe("too-large");
          expect(heap.message).toContain("memory");

          const output = yield* attempt({
            read: { timeout: "30 seconds", maxHeapMb: 1024, maxStdoutBytes: 64 },
          });
          expect(output.reason).toBe("too-large");

          const timeout = yield* attempt({
            read: { timeout: "1 millis", maxHeapMb: 1024, maxStdoutBytes: 1024 * 1024 * 64 },
          });
          expect(timeout.reason).toBe("timeout");

          expect(NodeFS.existsSync(outputPath)).toBe(false);
          expect(NodeFS.existsSync(`${outputPath}.partial`)).toBe(false);
          expect(NodeFS.readdirSync(scratchRoot)).toEqual([]);
        }),
      ),
  );

  it.live("cancels a running conversion without leaving a file or scratch directory", () =>
    withConverter(({ converter, directory, scratchRoot }) =>
      Effect.gen(function* () {
        const big = largeBundle();
        const outputPath = NodePath.join(directory, "cancelled.docx");
        const fiber = yield* Effect.forkChild(converter.convert({ bundle: big, outputPath }));
        yield* Effect.sleep("300 millis");
        const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(NodeFS.existsSync(outputPath)).toBe(false);
        expect(NodeFS.existsSync(`${outputPath}.partial`)).toBe(false);
        expect(NodeFS.readdirSync(scratchRoot)).toEqual([]);
      }),
    ),
  );
});
