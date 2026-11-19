import { describe, expect, it } from "@effect/vitest";

import { selectLatexBuildEngine } from "./latexEngineGate.ts";

const PLAIN_PDFLATEX_DOCUMENT = [
  "\\documentclass[11pt]{article}",
  "\\usepackage[utf8]{inputenc}",
  "\\usepackage{amsmath,amssymb, mathtools}",
  "\\RequirePackage{etoolbox}",
  "\\begin{document}",
  "Hello, world.",
  "\\end{document}",
].join("\n");

// regression: 78c4bb1678 fix(latex): let engine-conditional documents past the engine gate
// A document that tests which engine runs it stays on the default compiler; one that loads a
// Unicode-only package unguarded gets XeLaTeX.
describe("engine-conditional documents", () => {
  const pdfLatex = { engine: "pdflatex", error: null };
  const inferredXeLatex = { engine: "xelatex", error: null };
  const select = (rootText: string, includedTexts?: ReadonlyArray<string>) =>
    selectLatexBuildEngine({ rootText, ...(includedTexts ? { includedTexts } : {}) }, "latexmk");

  // Pandoc's default LaTeX template, near enough: it loads iftex and then
  // loads fontspec and unicode-math only on the branch pdfLaTeX never takes.
  const PANDOC_SHAPED_PREAMBLE = [
    "\\documentclass[11pt]{article}",
    "\\usepackage{iftex}",
    "\\ifPDFTeX",
    "  \\usepackage[T1]{fontenc}",
    "  \\usepackage[utf8]{inputenc}",
    "\\else % if luatex or xetex",
    "  \\usepackage{unicode-math}",
    "  \\usepackage{fontspec}",
    "\\fi",
    "\\begin{document}",
    "Hello, world.",
    "\\end{document}",
  ].join("\n");

  it("keeps the pandoc-shaped preamble that guards fontspec behind \\ifPDFTeX", () => {
    expect(select(PANDOC_SHAPED_PREAMBLE)).toEqual(pdfLatex);
  });

  it("keeps the older ifxetex idiom templates still carry", () => {
    const source = [
      "\\documentclass{article}",
      "\\usepackage{ifxetex}",
      "\\ifxetex",
      "  \\usepackage{fontspec}",
      "\\else",
      "  \\usepackage[T1]{fontenc}",
      "\\fi",
    ].join("\n");
    expect(select(source)).toEqual(pdfLatex);
  });

  it.each([
    "\\ifPDFTeX",
    "\\ifpdftex",
    "\\ifxetex",
    "\\ifXeTeX",
    "\\ifluatex",
    "\\ifLuaTeX",
    "\\iftutex",
  ])("keeps a document that tests its engine with %s alone", (conditional) => {
    expect(select([conditional, "\\usepackage{fontspec}", "\\fi"].join("\n"))).toEqual(pdfLatex);
  });

  it.each(["iftex", "ifxetex", "ifluatex"])(
    "keeps a document that loads \\usepackage{%s} alone",
    (guardPackage) => {
      expect(select(`\\usepackage{${guardPackage}}\n\\usepackage{fontspec}`)).toEqual(pdfLatex);
    },
  );

  it("accepts a guard package named alongside others in one load", () => {
    expect(select("\\usepackage{amsmath, iftex, geometry}\n\\usepackage{fontspec}")).toEqual(
      pdfLatex,
    );
  });

  it("still moves an unguarded \\usepackage{fontspec} to XeLaTeX", () => {
    const source = ["\\documentclass{article}", "\\usepackage{fontspec}", "\\begin{document}"];
    expect(select(source.join("\n"))).toEqual(inferredXeLatex);
  });

  it("follows the magic comment even when iftex is present too", () => {
    // The comment is a declaration, not an inference: this author said which engine it is for.
    const source = [
      "% !TEX program = lualatex",
      "\\usepackage{iftex}",
      "\\ifPDFTeX\\else\\usepackage{fontspec}\\fi",
    ].join("\n");
    expect(select(source)).toEqual({ engine: "lualatex", error: null });
  });

  it("does not let a commented-out conditional keep the default compiler", () => {
    const source = ["% \\ifPDFTeX -- we dropped this branch", "\\usepackage{fontspec}"].join("\n");
    expect(select(source)).toEqual(inferredXeLatex);
  });

  it("does not treat \\ifpdf as an engine test", () => {
    // ifpdf asks about PDF output mode, not about the engine; a document
    // branching on it has said nothing about wanting the default compiler.
    expect(select("\\usepackage{ifpdf}\n\\ifpdf\\else\\fi\n\\usepackage{fontspec}")).toEqual(
      inferredXeLatex,
    );
  });

  it("accepts a guard found in an included text while the root does the loading", () => {
    expect(select("\\usepackage{fontspec}", ["\\usepackage{iftex}"])).toEqual(pdfLatex);
  });
});

describe("compiler resolution", () => {
  it("uses XeLaTeX automatically when a preamble requires Unicode fonts", () => {
    expect(
      selectLatexBuildEngine(
        { rootText: "\\usepackage{polyglossia}", includedTexts: ["\\usepackage{fontspec}"] },
        "latexmk",
      ),
    ).toEqual({ engine: "xelatex", error: null });
  });

  it("does not override an explicit compiler or infer from Hebrew characters", () => {
    expect(
      selectLatexBuildEngine(
        { rootText: "% !TEX program = lualatex\n\\usepackage{fontspec}" },
        "latexmk",
      ),
    ).toEqual({ engine: "lualatex", error: null });
    expect(selectLatexBuildEngine({ rootText: "שלום" }, "latexmk")).toEqual({
      engine: "pdflatex",
      error: null,
    });
    const explicitPdf = selectLatexBuildEngine(
      { rootText: "% !TEX program = pdflatex\n\\usepackage{fontspec}" },
      "latexmk",
    );
    expect(explicitPdf.engine).toBe("pdflatex");
    expect(explicitPdf.error).not.toBeNull();
  });

  it.each([
    ["%!TEX program=xelatex", "xelatex"],
    ["%   !TEX    program   =   lualatex", "lualatex"],
    ["%% !TEX program = xelatex", "xelatex"],
    ["% TEX program = xelatex", "pdflatex"],
  ] as const)(
    "reads the directive %j however editors space it, and only with its !",
    (rootText, engine) => {
      expect(selectLatexBuildEngine({ rootText }, "latexmk")).toEqual({ engine, error: null });
    },
  );

  it.each([
    ["named only in a comment", "% \\usepackage{fontspec}", "pdflatex"],
    [
      "loaded before a trailing comment",
      "\\usepackage{fontspec} % for the display font",
      "xelatex",
    ],
    ["whose name only contains fontspec", "\\usepackage{fontspecish}", "pdflatex"],
  ] as const)("reads a package %s", (_, rootText, engine) => {
    expect(selectLatexBuildEngine({ rootText }, "latexmk")).toEqual({ engine, error: null });
  });

  it("keeps conditional Unicode packages on the default compiler", () => {
    expect(
      selectLatexBuildEngine(
        { rootText: "\\usepackage{iftex}\n\\ifPDFTeX\\else\\usepackage{fontspec}\\fi" },
        "latexmk",
      ),
    ).toEqual({ engine: "pdflatex", error: null });
  });

  it.each([
    { declaration: "pdflatex", engine: "pdflatex" },
    { declaration: "pdftex", engine: "pdflatex" },
    { declaration: "XeTeX", engine: "xelatex" },
    { declaration: "LuaTeX", engine: "lualatex" },
  ] as const)("resolves the supported $declaration declaration", ({ declaration, engine }) => {
    expect(
      selectLatexBuildEngine(
        { rootText: `  % !tex TS-program = ${declaration}\r\n${PLAIN_PDFLATEX_DOCUMENT}` },
        "latexmk",
      ),
    ).toEqual({ engine, error: null });
  });

  it.each(["pdflatex", "xelatex", "lualatex"] as const)(
    "honors root %s over a conflicting included declaration",
    (engine) => {
      expect(
        selectLatexBuildEngine(
          {
            rootText: `% !TEX program = ${engine}\n\\input{preamble}`,
            includedTexts: [
              "% !TEX program = lualatex",
              "% !TEX program = xelatex",
              "% !TEX program = pdflatex",
            ],
          },
          "latexmk",
        ),
      ).toEqual({ engine, error: null });
    },
  );

  it("honors a root pdfLaTeX declaration but rejects an incompatible included preamble", () => {
    const selected = selectLatexBuildEngine(
      {
        rootText: "% !TEX program = pdflatex\n\\input{preamble}",
        includedTexts: ["% !TEX program = xelatex\n\\usepackage{unicode-math}"],
      },
      "latexmk",
    );
    expect(selected.engine).toBe("pdflatex");
    expect(selected.error).not.toBeNull();
  });

  it("uses the first supported included declaration when the root has none", () => {
    expect(
      selectLatexBuildEngine(
        {
          rootText: "% !TEX program = context\n\\input{preamble}",
          includedTexts: [
            "% !TEX program = latex",
            "% !TEX program = lualatex\n\\usepackage{fontspec}",
            "% !TEX program = xelatex",
          ],
        },
        "latexmk",
      ),
    ).toEqual({ engine: "lualatex", error: null });
  });

  it("uses the first supported declaration within a text", () => {
    expect(
      selectLatexBuildEngine(
        {
          rootText: "% !TEX program = context\n% !TEX program = pdftex\n% !TEX program = xelatex",
        },
        "latexmk",
      ),
    ).toEqual({ engine: "pdflatex", error: null });
  });

  // regression: c8699e134b feat(documents): add visual LaTeX authoring and reusable templates
  it.each(["context", "latex", "xelatex-custom", "xelatex2", "lualatex-dev", "pdftexish"])(
    "does not interpret the unsupported full declaration %s as a supported compiler",
    (declaration) => {
      expect(
        selectLatexBuildEngine({ rootText: `% !TEX program = ${declaration}` }, "latexmk"),
      ).toEqual({ engine: "pdflatex", error: null });
    },
  );

  it("lets a supported included declaration win over an unsupported root compiler name", () => {
    expect(
      selectLatexBuildEngine(
        {
          rootText: "% !TEX program = xelatex-custom",
          includedTexts: ["% !TEX program = lualatex"],
        },
        "latexmk",
      ),
    ).toEqual({ engine: "lualatex", error: null });
  });

  it("defaults to the embedded XeTeX lane with Tectonic", () => {
    expect(selectLatexBuildEngine({ rootText: PLAIN_PDFLATEX_DOCUMENT }, "tectonic")).toEqual({
      engine: "xelatex",
      error: null,
    });
  });

  it("recognizes an explicit Tectonic driver instead of using the default latexmk engine", () => {
    const input = { rootText: `% !TEX program = tectonic\n${PLAIN_PDFLATEX_DOCUMENT}` };
    expect(selectLatexBuildEngine(input, "latexmk")).toMatchObject({
      driver: "tectonic",
      engine: "xelatex",
      error: expect.stringContaining("requests Tectonic"),
    });
    expect(selectLatexBuildEngine(input, "tectonic")).toEqual({
      driver: "tectonic",
      engine: "xelatex",
      error: null,
    });
  });

  it("preserves root selection ahead of included Tectonic declarations", () => {
    expect(
      selectLatexBuildEngine(
        {
          rootText: `% !TEX program = pdflatex\n${PLAIN_PDFLATEX_DOCUMENT}`,
          includedTexts: ["% !TEX program = tectonic"],
        },
        "latexmk",
      ),
    ).toEqual({ engine: "pdflatex", error: null });
  });

  it.each(["xelatex", "xetex"])(
    "accepts the compatible explicit %s compiler with Tectonic",
    (declaration) => {
      expect(
        selectLatexBuildEngine(
          {
            rootText: `% !TEX program = ${declaration}\n\\usepackage{fontspec}\nשלום עולם`,
          },
          "tectonic",
        ),
      ).toEqual({ engine: "xelatex", error: null });
    },
  );

  // regression: c8699e134b feat(documents): add visual LaTeX authoring and reusable templates
  it.each([
    { declaration: "pdflatex", engine: "pdflatex" },
    { declaration: "pdftex", engine: "pdflatex" },
    { declaration: "lualatex", engine: "lualatex" },
    { declaration: "luatex", engine: "lualatex" },
  ] as const)(
    "rejects rather than silently replaces Tectonic's incompatible $declaration request",
    ({ declaration, engine }) => {
      const selected = selectLatexBuildEngine(
        {
          rootText: "\\input{preamble}",
          includedTexts: [`% !TEX program = ${declaration}`],
        },
        "tectonic",
      );
      expect(selected.engine).toBe(engine);
      expect(selected.error).not.toBeNull();
    },
  );

  it.each(["xelatex", "lualatex"] as const)(
    "keeps explicitly requested %s for a Hebrew document with a Unicode preamble",
    (engine) => {
      expect(
        selectLatexBuildEngine(
          {
            rootText: `% !TEX program = ${engine}\n\\input{preamble}\nשלום עולם`,
            includedTexts: ["\\usepackage{fontspec,polyglossia}\n\\setdefaultlanguage{hebrew}"],
          },
          "latexmk",
        ),
      ).toEqual({ engine, error: null });
    },
  );

  it("does not infer a Unicode compiler from multilingual prose in included text", () => {
    expect(
      selectLatexBuildEngine(
        {
          rootText: PLAIN_PDFLATEX_DOCUMENT,
          includedTexts: ["שלום עולם\nمرحبا بالعالم\n你好世界\nПривет мир"],
        },
        "latexmk",
      ),
    ).toEqual({ engine: "pdflatex", error: null });
  });

  it.each([
    {
      rootText: "\\usepackage{iftex}\n\\input{preamble}",
      includedTexts: ["\\ifPDFTeX\\else\\usepackage{fontspec}\\fi"],
    },
    {
      rootText: "% !TEX program = pdflatex\n\\input{preamble}",
      includedTexts: ["\\RequirePackage{ifluatex}\n\\ifluatex\\RequirePackage{unicode-math}\\fi"],
    },
  ])("allows engine-conditional package loads split across preambles", (input) => {
    expect(selectLatexBuildEngine(input, "latexmk")).toEqual({
      engine: "pdflatex",
      error: null,
    });
  });

  it.each([
    "% \\usepackage{iftex}",
    "\\usepackage{geometry} % \\ifPDFTeX",
    "\\ifPDFTeXcustom\\else\\fi",
  ])("does not mistake %s for an active engine guard", (guard) => {
    const input = {
      rootText: "% !TEX program = pdflatex",
      includedTexts: [`${guard}\n\\usepackage{fontspec}`],
    };
    const selected = selectLatexBuildEngine(input, "latexmk");
    expect(selected.engine).toBe("pdflatex");
    expect(selected.error).not.toBeNull();
  });

  it.each([
    "\\usepackage{\n  fontspec\n}",
    "\\RequirePackage[\n  no-math\n]{fontspec}",
    "\\usepackage{amsmath,\n  unicode-math,\n  geometry}",
  ])("detects an unconditional multiline Unicode package load: %s", (packageLoad) => {
    expect(
      selectLatexBuildEngine(
        { rootText: "\\input{preamble}", includedTexts: [packageLoad] },
        "latexmk",
      ),
    ).toEqual({ engine: "xelatex", error: null });
    const explicitPdf = selectLatexBuildEngine(
      {
        rootText: "% !TEX program = pdflatex\n\\input{preamble}",
        includedTexts: [packageLoad],
      },
      "latexmk",
    );
    expect(explicitPdf.engine).toBe("pdflatex");
    expect(explicitPdf.error).not.toBeNull();
  });

  it.each(["\\usepackage{\n  iftex\n}", "\\RequirePackage[\n]{ifluatex}"])(
    "recognizes a multiline engine guard before deciding the Unicode package lane: %s",
    (guard) => {
      const input = {
        rootText: "% !TEX program = pdflatex\n\\input{preamble}",
        includedTexts: [guard, "\\usepackage{fontspec}"],
      };
      expect(selectLatexBuildEngine(input, "latexmk")).toEqual({
        engine: "pdflatex",
        error: null,
      });
    },
  );
});
