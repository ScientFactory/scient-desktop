// @effect-diagnostics nodeBuiltinImport:off -- Builds allowlisted and forbidden files, including a symlink, on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { attr, para, str, type PandocDocument, type PandocNode } from "./pandocAst.ts";
import {
  securePandocDocument,
  sniffMediaType,
  svgHasExternalReferences,
  type ImageResourceOptions,
} from "./pandocResources.ts";
import { PNG_BYTES, PNG_BYTES_ALT, SVG_BYTES, bytesAsset } from "./pandocTestSupport.ts";
import { captureWordImages } from "./wordImageSnapshot.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const image = (url: string, alt = "figure"): PandocNode => ({
  t: "Image",
  c: [attr(), [str(alt)], [url, ""]],
});

const doc = (blocks: Array<PandocNode>, meta: PandocDocument["meta"] = {}): PandocDocument => ({
  "pandoc-api-version": [1, 23, 1, 2],
  meta,
  blocks,
});

const secure = (document: PandocDocument, options: Partial<ImageResourceOptions> = {}) =>
  securePandocDocument(document, { assets: [], files: null, ...options }).pipe(
    Effect.provide(NodeServices.layer),
  );

const firstInline = (document: PandocDocument, index = 0) =>
  (document.blocks[index]!.c as Array<PandocNode>)[0]!;

const imageUrl = (node: PandocNode) => ((node.c as Array<unknown>)[2] as [string, string])[0];

const placeholderText = (node: PandocNode) =>
  ((node.c as [unknown, Array<PandocNode>])[1] ?? [])
    .map((inline) => (inline.t === "Str" ? String(inline.c) : " "))
    .join("");

describe("sniffMediaType", () => {
  it("reads magic bytes, not names", () => {
    expect(sniffMediaType(PNG_BYTES)).toBe("image/png");
    expect(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(sniffMediaType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMediaType(SVG_BYTES)).toBe("image/svg+xml");
    const prolog = `<?xml version="1.0"?>\n${"<!-- note -->\n".repeat(20)}<!DOCTYPE svg>\n<!-- end -->\n`;
    expect(sniffMediaType(new TextEncoder().encode(`${prolog}<svg></svg>`))).toBe("image/svg+xml");
    expect(sniffMediaType(new TextEncoder().encode(`${prolog}<not-svg/>`))).toBeNull();
    expect(
      sniffMediaType(new TextEncoder().encode(`${"<!-- x -->".repeat(50)}<not-svg/>`)),
    ).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("FAKE-SECRET-TEXT"))).toBeNull();
  });

  it("refuses SVGs that point outside themselves", () => {
    expect(svgHasExternalReferences(SVG_BYTES)).toBe(false);
    for (const svg of [
      `<svg><image href="file:///etc/hosts"/></svg>`,
      `<svg><image xlink:href="http://example.com/x.png"/></svg>`,
      `<svg><style>@import url(x.css)</style></svg>`,
      `<svg style="fill:url(http://example.com/p)"></svg>`,
      `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>`,
    ]) {
      expect(svgHasExternalReferences(new TextEncoder().encode(svg))).toBe(true);
    }
    expect(
      svgHasExternalReferences(new TextEncoder().encode(`<svg><use href="#shape"/></svg>`)),
    ).toBe(false);
  });
});

describe("securePandocDocument", () => {
  it.effect(
    "uses captured image bytes after a workspace edit and never reads an uncaptured path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "scient-word-snapshot-" });
        const imagePath = NodePath.join(project, "plot.png");
        NodeFS.writeFileSync(imagePath, PNG_BYTES);
        const imageSnapshot = yield* captureWordImages(["plot.png"], {
          baseDirectory: project,
          allowRoots: [project],
        });
        NodeFS.writeFileSync(imagePath, PNG_BYTES_ALT);
        NodeFS.writeFileSync(NodePath.join(project, "later.png"), PNG_BYTES_ALT);
        const document = doc([para([image("plot.png")]), para([image("later.png")])]);
        const report = yield* securePandocDocument(document, {
          assets: [],
          files: { baseDirectory: project, allowRoots: [project] },
          imageSnapshot,
        });
        expect(imageUrl(firstInline(document)).startsWith("data:image/png;base64,")).toBe(true);
        expect(imageUrl(firstInline(document))).toBe(
          `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
        );
        expect(firstInline(document, 1).t).toBe("Span");
        expect(report.embeddedImages).toBe(1);
        expect(report.placeholders).toBe(1);
        expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
          "not in the source snapshot; save and retry",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("bounds image capture and refuses paths outside the allowed root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-word-image-limits-" });
      const project = NodePath.join(directory, "project");
      NodeFS.mkdirSync(project);
      NodeFS.writeFileSync(NodePath.join(directory, "outside.png"), PNG_BYTES);
      NodeFS.writeFileSync(NodePath.join(project, "large.png"), Buffer.alloc(25 * 1024 * 1024 + 1));
      const captured = yield* captureWordImages(["../outside.png", "large.png"], {
        baseDirectory: project,
        allowRoots: [project],
      });
      expect(captured.get("../outside.png")).toEqual({
        ok: false,
        refusal: "outside-allowlist",
      });
      expect(captured.get("large.png")).toEqual({ ok: false, refusal: "too-large" });
      const excessive = yield* captureWordImages(
        Array.from({ length: 257 }, (_, index) => `figure-${index}.png`),
        { baseDirectory: project, allowRoots: [project] },
      ).pipe(Effect.flip);
      expect(excessive._tag).toBe("WordImageSnapshotError");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses an intermediate symlink swapped after path resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-word-path-race-" });
      const project = NodePath.join(directory, "project");
      const figures = NodePath.join(project, "figures");
      const outside = NodePath.join(directory, "outside");
      NodeFS.mkdirSync(figures, { recursive: true });
      NodeFS.mkdirSync(outside);
      NodeFS.writeFileSync(NodePath.join(figures, "plot.png"), PNG_BYTES);
      NodeFS.writeFileSync(NodePath.join(outside, "plot.png"), PNG_BYTES_ALT);
      const candidate = NodePath.join(figures, "plot.png");
      const swapping = {
        ...fs,
        realPath: (file: string) =>
          fs.realPath(file).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (file !== candidate) return;
                NodeFS.renameSync(figures, NodePath.join(project, "original"));
                NodeFS.symlinkSync(outside, figures);
              }),
            ),
          ),
      };
      const captured = yield* captureWordImages(["figures/plot.png"], {
        baseDirectory: project,
        allowRoots: [project],
      }).pipe(Effect.provideService(FileSystem.FileSystem, swapping));
      expect(captured.get("figures/plot.png")).toEqual({
        ok: false,
        refusal: "changed-during-capture",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps presentational metadata and deletes every file-reading key", () =>
    Effect.gen(function* () {
      const meta: PandocDocument["meta"] = {
        title: { t: "MetaInlines", c: [str("Kept")] },
        bibliography: { t: "MetaString", c: "/home/someone/secret.bib" },
        csl: { t: "MetaString", c: "http://127.0.0.1:9/evil.csl" },
        "citation-abbreviations": { t: "MetaString", c: "abbrev.json" },
        "reference-doc": { t: "MetaString", c: "/etc/hosts" },
        "resource-path": { t: "MetaString", c: "/" },
        nocite: { t: "MetaInlines", c: [str("@*")] },
        scient: { t: "MetaString", c: "conversation" },
      };
      const document = doc([], meta);
      const report = yield* secure(document);
      expect(Object.keys(document.meta)).toEqual(["title"]);
      const messages = report.warnings.map((warning) => warning.message);
      for (const key of [
        "bibliography",
        "csl",
        "citation-abbreviations",
        "reference-doc",
        "resource-path",
      ]) {
        expect(messages.some((message) => message.includes(`named a ${key};`))).toBe(true);
      }
      expect(messages.join("\n")).not.toContain("/home/someone");
    }),
  );

  it.effect("drops raw OpenXML, TeX, and HTML anywhere, keeping line breaks", () =>
    Effect.gen(function* () {
      const document = doc(
        [
          { t: "RawBlock", c: ["openxml", '<w:p><w:fldSimple w:instr="INCLUDEPICTURE x"/></w:p>'] },
          para([
            str("before"),
            { t: "RawInline", c: ["openxml", "<w:r><w:t>injected</w:t></w:r>"] },
            { t: "RawInline", c: ["html", "<br />"] },
            { t: "RawInline", c: ["html", "<span>"] },
            str("after"),
          ]),
          { t: "RawBlock", c: ["latex", "\\input{/etc/hosts}"] },
          { t: "RawBlock", c: ["html", "<!-- a comment -->"] },
          {
            t: "BulletList",
            c: [[{ t: "RawBlock", c: ["html", "<div>"] }, para([str("item")])]],
          },
        ],
        { abstract: { t: "MetaBlocks", c: [{ t: "RawBlock", c: ["openxml", "<w:p/>"] }] } },
      );
      const report = yield* secure(document);
      const serialized = serialize(document);
      expect(serialized).not.toContain("Raw");
      expect(serialized).not.toContain("INCLUDEPICTURE");
      expect(document.blocks[0]!.c).toEqual([str("before"), { t: "LineBreak" }, str("after")]);
      const messages = report.warnings.map((warning) => warning.message);
      expect(messages).toContain("Raw HTML was left out of the Word file (2 places).");
      expect(messages).toContain("Raw openxml content was left out of the Word file (3 places).");
      expect(messages).toContain("Raw latex content was left out of the Word file (1 place).");
    }),
  );

  it.effect("keeps web, mail, and in-document links and unwraps the rest", () =>
    Effect.gen(function* () {
      const link = (url: string): PandocNode => ({ t: "Link", c: [attr(), [str(url)], [url, ""]] });
      const document = doc([
        para([
          link("https://example.com"),
          link("mailto:a@example.com"),
          link("#section"),
          link("file:///etc/hosts"),
          link("scient-asset:m1-a1"),
          link("../notes.md"),
        ]),
      ]);
      yield* secure(document);
      expect((document.blocks[0]!.c as Array<PandocNode>).map((node) => node.t)).toEqual([
        "Link",
        "Link",
        "Link",
        "Span",
        "Span",
        "Span",
      ]);
    }),
  );

  it.effect("embeds bundle assets and data URIs only when the bytes are images", () =>
    Effect.gen(function* () {
      const text = `data:text/plain;base64,${Buffer.from("FAKE-SECRET-DATAURI").toString("base64")}`;
      const png = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
      const document = doc([
        para([image("scient-asset:photo")]),
        para([image("scient-asset:renamed")]),
        para([image("scient-asset:gone")]),
        para([image("scient-asset:unknown")]),
        para([image(text)]),
        para([image(png)]),
        para([image("http://127.0.0.1:9/pixel.png")]),
      ]);
      const report = yield* secure(document, {
        assets: [
          bytesAsset({ id: "photo", bytes: PNG_BYTES }),
          bytesAsset({ id: "renamed", bytes: new TextEncoder().encode("FAKE-SECRET-RENAMED") }),
          {
            ...bytesAsset({ id: "gone", bytes: PNG_BYTES }),
            content: { _tag: "unavailable", reason: "missing" },
          },
        ],
      });
      expect(imageUrl(firstInline(document, 0)).startsWith("data:image/png;base64,")).toBe(true);
      expect(imageUrl(firstInline(document, 5)).startsWith("data:image/png;base64,")).toBe(true);
      for (const index of [1, 2, 3, 4, 6]) {
        const node = firstInline(document, index);
        expect(node.t).toBe("Span");
        expect(placeholderText(node)).toContain("[Image unavailable: figure");
      }
      expect(report.embeddedImages).toBe(2);
      expect(report.placeholders).toBe(5);
      expect(serialize(document)).not.toContain("FAKE-SECRET");
      expect(placeholderText(firstInline(document, 6))).toContain("remote and non-file images");
    }),
  );

  it.effect("keeps an embedded image's width and height and drops its other attributes", () =>
    Effect.gen(function* () {
      const sized = (pairs: ReadonlyArray<readonly [string, string]>): PandocNode => ({
        t: "Image",
        c: [["figure-1", ["wide"], pairs], [str("figure")], ["scient-asset:photo", "Title"]],
      });
      const document = doc([
        para([
          sized([
            ["width", "50%"],
            ["height", "3.5cm"],
            ["style", "border: 1px"],
          ]),
        ]),
        para([
          sized([
            ["width", "calc(100% - 1px)"],
            ["height", "120"],
          ]),
        ]),
      ]);
      yield* secure(document, { assets: [bytesAsset({ id: "photo", bytes: PNG_BYTES })] });
      const attributes = (index: number) => (firstInline(document, index).c as Array<unknown>)[0];
      // Word ignores percentages, so a share of the 453.5 pt text width becomes points.
      expect(attributes(0)).toEqual([
        "",
        [],
        [
          ["width", "226.8pt"],
          ["height", "3.5cm"],
        ],
      ]);
      expect(attributes(1)).toEqual(["", [], [["height", "120"]]]);
      expect(((firstInline(document, 0).c as Array<unknown>)[2] as Array<string>)[1]).toBe("Title");
    }),
  );

  it.effect("swaps an SVG asset for its PNG rendering and reports one without", () =>
    Effect.gen(function* () {
      const document = doc([para([image("scient-asset:svg")]), para([image("scient-asset:lone")])]);
      const report = yield* secure(document, {
        assets: [
          bytesAsset({ id: "svg", bytes: SVG_BYTES, packagePath: "images/d.svg" }),
          bytesAsset({ id: "svg-png", bytes: PNG_BYTES_ALT, packagePath: "images/d.png" }),
          bytesAsset({ id: "lone", bytes: SVG_BYTES, packagePath: "images/lone.svg" }),
        ],
      });
      expect(imageUrl(firstInline(document, 0))).toBe(
        `data:image/png;base64,${Buffer.from(PNG_BYTES_ALT).toString("base64")}`,
      );
      expect(imageUrl(firstInline(document, 1)).startsWith("data:image/svg+xml;base64,")).toBe(
        true,
      );
      expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
        "SVG without a PNG rendering",
      );
    }),
  );

  it.effect("reads relative files only inside the allowlist, after resolving links", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pandoc-files-" });
      const project = NodePath.join(root, "project");
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(NodePath.join(project, "figures"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(project, "folder.png"), { recursive: true });
      NodeFS.mkdirSync(home, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, "notes.txt"), "FAKE-SECRET-NOTES");
      NodeFS.writeFileSync(NodePath.join(home, "real.png"), PNG_BYTES);
      NodeFS.writeFileSync(NodePath.join(project, "figures", "ok.png"), PNG_BYTES);
      NodeFS.writeFileSync(NodePath.join(project, "figures", "big.png"), Buffer.alloc(4096, 1));
      NodeFS.writeFileSync(NodePath.join(project, "figures", "text.png"), "FAKE-SECRET-TEXT");
      NodeFS.writeFileSync(NodePath.join(project, "figures", "paper.pdf"), "%PDF-1.7 figure");
      NodeFS.writeFileSync(NodePath.join(project, "figures", "vector.svg"), SVG_BYTES);
      NodeFS.writeFileSync(NodePath.join(project, "figures", "vector.png"), PNG_BYTES_ALT);
      NodeFS.symlinkSync(NodePath.join(home, "real.png"), NodePath.join(project, "link.png"));

      const cases: ReadonlyArray<readonly [string, string | null]> = [
        ["figures/ok.png", "data:image/png"],
        ["figures%2Fok.png", "data:image/png"],
        [
          "figures/vector.svg",
          `data:image/png;base64,${Buffer.from(PNG_BYTES_ALT).toString("base64")}`,
        ],
        ["../home/notes.txt", "outside the document"],
        [NodePath.join(home, "notes.txt"), "absolute paths"],
        ["C:\\Users\\someone\\notes.txt", "absolute paths"],
        ["\\\\server\\share\\x.png", "absolute paths"],
        [`file://${NodePath.join(home, "notes.txt")}`, "remote and non-file"],
        ["link.png", "links outside"],
        ["figures/text.png", "not an image"],
        ["figures/paper.pdf", "PDF figures"],
        ["folder.png", "not a regular file"],
        ["figures/big.png", "larger than"],
        ["figures/missing.png", "file not found"],
      ];
      const document = doc(cases.map(([url]) => para([image(url)])));
      yield* secure(document, {
        files: { baseDirectory: project, allowRoots: [project] },
        maxImageBytes: 1024,
      });
      for (const [index, [url, expected]] of cases.entries()) {
        const node = firstInline(document, index);
        if (expected?.startsWith("data:")) {
          expect(node.t, url).toBe("Image");
          expect(imageUrl(node).startsWith(expected), url).toBe(true);
        } else {
          expect(node.t, url).toBe("Span");
          expect(placeholderText(node), url).toContain(expected);
        }
      }
      expect(serialize(document)).not.toContain("FAKE-SECRET");
      expect(serialize(document)).not.toContain(Buffer.from("FAKE-SECRET").toString("base64"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stops embedding once the export's image budget is spent", () =>
    Effect.gen(function* () {
      const document = doc([para([image("scient-asset:a")]), para([image("scient-asset:b")])]);
      const report = yield* secure(document, {
        assets: [
          bytesAsset({ id: "a", bytes: PNG_BYTES }),
          bytesAsset({ id: "b", bytes: PNG_BYTES_ALT }),
        ],
        maxTotalImageBytes: PNG_BYTES.byteLength + 1,
      });
      expect(report.embeddedImages).toBe(1);
      expect(placeholderText(firstInline(document, 1))).toContain("image size limit");
    }),
  );
});
