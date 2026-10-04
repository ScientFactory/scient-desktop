import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  discoverProductionInputs,
  PRODUCTION_ENTRIES,
  formatReport,
  inspectLivecode,
  runLivecode,
  runtimeImports,
} from "./check-livecode.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-livecode-test-"));
  directories.push(root);
  function write(path, content) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  write("apps/server/src/main.ts", "export const main = true;");
  const options = { root, entries: ["apps/server/src/main.ts"] };
  const inspect = () => inspectLivecode(options);
  const test = (name) =>
    inspect().tests.find((entry) => entry.test === `apps/server/src/${name}.test.ts`);
  return { root, write, options, inspect, test };
}

describe("runtime import syntax", () => {
  it("follows runtime imports/re-exports/CommonJS, but excludes every type-only form", () => {
    const result = runtimeImports(
      "syntax.ts",
      `
      import './side-effect';
      import {} from './empty';
      import value, { type Shape, other } from './mixed';
      import type { Erased } from './erased';
      import { type AlsoErased } from './also-erased';
      export type { Erased } from './export-erased';
      export { type AlsoErased } from './named-erased';
      export { value } from './exported';
      export * from './star';
      export * as ns from './namespace';
      export {} from './empty-export';
      type DynamicType = import('./dynamic-type').Shape;
      import Alias = require('./equals');
      import type TypeAlias = require('./type-equals');
      declare module './ambient' { import Ambient from './ambient-import'; }
      const comment = "import './fake-string'"; // import './fake-comment'
      void import('./dynamic');
      void import(\`./template\`);
      const cjs = require('./cjs');
    `,
    );
    expect(result.imports.map((entry) => entry.specifier)).toEqual([
      "./side-effect",
      "./empty",
      "./mixed",
      "./exported",
      "./star",
      "./namespace",
      "./empty-export",
      "./equals",
      "./dynamic",
      "./template",
      "./cjs",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports computed imports and malformed source instead of silently losing edges", () => {
    expect(
      runtimeImports("dynamic.ts", "void import(variable); require(path);").diagnostics,
    ).toHaveLength(2);
    expect(
      runtimeImports("invalid.ts", "import {").diagnostics.some((entry) => entry.kind === "error"),
    ).toBe(true);
  });
});

describe("production subject reachability", () => {
  it("declares every current production HTML/build and file-routed marketing input", () => {
    const inputs = discoverProductionInputs(NodePath.resolve(import.meta.dirname, ".."));
    expect(inputs).toContain("apps/web/src/scient/documentPage/main.tsx");
    expect(inputs.filter((input) => !PRODUCTION_ENTRIES.includes(input))).toEqual([]);
  });

  it("rejects newly added HTML inputs and marketing pages until their roots are declared", () => {
    const f = fixture();
    f.write(
      "apps/web/vite.config.ts",
      "export default { build: { rolldownOptions: { input: { main: new URL('./index.html', import.meta.url), document: new URL('./document.html', import.meta.url) } } } };",
    );
    f.write("apps/web/index.html", '<script type="module" src="/src/bootstrap.ts"></script>');
    f.write("apps/web/document.html", '<script type="module" src="/src/document.ts"></script>');
    f.write("apps/web/src/bootstrap.ts", "export const bootstrap = true;");
    f.write("apps/web/src/document.ts", "import './readiness';");
    f.write("apps/web/src/readiness.ts", "export const ready = true;");
    f.write("apps/web/src/readiness.test.ts", "import './readiness';");
    f.write("apps/marketing/src/pages/new.astro", "<p>New page</p>");
    const entries = [...f.options.entries, ...discoverProductionInputs(f.root)];
    expect(inspectLivecode({ root: f.root, entries }).tests[0].status).toBe("live");
    expect(
      f.inspect().diagnostics.filter((entry) => entry.message.includes("entry list")),
    ).toHaveLength(3);
    expect(runLivecode(["--strict"], f.options).exitCode).toBe(1);
    f.write("apps/marketing/src/pages/another.astro", "<p>Another page</p>");
    expect(
      inspectLivecode({ root: f.root, entries }).diagnostics.some((entry) =>
        entry.file.endsWith("another.astro"),
      ),
    ).toBe(true);
  });

  it("finds a dead subject even when its dependencies and test support are live", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './support'; import type { Dead } from './Dead';");
    f.write("apps/server/src/support.ts", "export const support = true;");
    f.write("apps/server/src/Dead.ts", "import './support'; export interface Dead {}");
    f.write("apps/server/src/Dead.regression.test.ts", "import './Dead'; import './support';");
    expect(f.inspect().tests[0].status).toBe("mixed");
    const result = inspectLivecode({
      ...f.options,
      supportMetadata: {
        "apps/server/src/Dead.regression.test.ts": {
          reason: "Fixture construction only",
          modules: ["apps/server/src/support.ts"],
        },
      },
    }).tests[0];
    expect(result.status).toBe("dead");
    expect(result.subjects).toEqual(["apps/server/src/Dead.ts"]);
    expect(result.imports).toEqual(["apps/server/src/Dead.ts", "apps/server/src/support.ts"]);
    expect(f.inspect().reachableFiles).not.toContain("apps/server/src/Dead.ts");
  });

  it("traverses cyclic test helpers, fixtures and other tests to the subject frontier", () => {
    const f = fixture();
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    f.write("apps/server/src/dead.test.ts", "import './helper';");
    f.write(
      "apps/server/src/helper.ts",
      "import { expect } from 'vite-plus/test'; import './testkit/helper';",
    );
    f.write(
      "apps/server/src/testkit/helper.ts",
      "import './cycle'; import '../dead'; import '../other.test';",
    );
    f.write("apps/server/src/testkit/cycle.ts", "import './helper';");
    f.write(
      "apps/server/src/other.test.ts",
      "import './sample.testFixtures'; import './sample.test-fixtures'; import './LiveTestHelpers';",
    );
    f.write("apps/server/src/sample.testFixtures.ts", "import './dead';");
    f.write("apps/server/src/sample.test-fixtures.ts", "import './dead';");
    f.write("apps/server/src/LiveTestHelpers.ts", "import './dead';");
    expect(f.test("dead").subjects).toEqual(["apps/server/src/dead.ts"]);
    expect(f.test("dead").status).toBe("dead");
  });

  it("honors actual production imports of test support and exposes that unusual edge", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './dead.test';");
    f.write("apps/server/src/dead.test.ts", "import './dead';");
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    expect(f.test("dead").status).toBe("live");
    expect(f.inspect().diagnostics[0].message).toContain("Production imports test support");
  });

  it("follows dynamic imports, runtime barrels, directory imports and built extensions", () => {
    const f = fixture();
    f.write(
      "apps/server/src/main.ts",
      "void import('./barrel.js'); require('./common.cjs'); import './routeTree.gen';",
    );
    f.write("apps/server/src/routeTree.gen.ts", "export const routes = true;");
    f.write("apps/server/src/barrel.ts", "export * from './feature';");
    f.write("apps/server/src/feature/index.ts", "export * from './live';");
    f.write("apps/server/src/feature/live.ts", "export const live = true;");
    f.write("apps/server/src/common.cts", "export const common = true;");
    f.write("apps/server/src/live.test.ts", "import './feature/live'; import './common.cjs';");
    expect(f.test("live").status).toBe("live");
    expect(f.inspect().reachableFiles).toContain("apps/server/src/routeTree.gen.ts");
    expect(f.inspect().diagnostics).toEqual([]);
  });

  it("distinguishes all-dead, mixed, all-live and no-runtime-subject tests", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './used';");
    f.write("apps/server/src/used.ts", "export const used = true;");
    f.write("apps/server/src/unused.ts", "export interface Unused {}");
    f.write("apps/server/src/allDead.test.ts", "import './unused';");
    f.write("apps/server/src/mixed.test.ts", "import './unused'; import './used';");
    f.write("apps/server/src/allLive.test.ts", "import './used';");
    f.write(
      "apps/server/src/noSubject.test.ts",
      "import type { Unused } from './unused'; import { it } from 'vite-plus/test';",
    );
    expect(f.inspect().tests.map((test) => test.status)).toEqual([
      "dead",
      "live",
      "mixed",
      "no-subject",
    ]);
    expect(f.test("mixed").deadSubjects).toEqual(["apps/server/src/unused.ts"]);
  });

  it("still reports dead supporting imports when the conventionally named subject is live", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './used';");
    f.write("apps/server/src/used.ts", "export const used = true;");
    f.write("apps/server/src/old-engine.ts", "export const engine = true;");
    f.write("apps/server/src/used.test.ts", "import './used'; import './old-engine';");
    expect(f.test("used")).toMatchObject({
      status: "mixed",
      subjects: ["apps/server/src/old-engine.ts", "apps/server/src/used.ts"],
      deadSubjects: ["apps/server/src/old-engine.ts"],
      deadImports: ["apps/server/src/old-engine.ts"],
    });
    expect(runLivecode(["--strict"], f.options).exitCode).toBe(0);
    expect(formatReport(f.inspect())).toContain(
      "unreachable subject: apps/server/src/old-engine.ts",
    );
  });

  it("retains directly asserted live modules alongside a named offline corpus builder", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './contract'; import './wireContract';");
    f.write("apps/server/src/conformance.ts", "export const buildCorpus = () => []; ");
    f.write("apps/server/src/contract.ts", "export const normalize = () => true;");
    f.write("apps/server/src/wireContract.ts", "export const validate = () => true;");
    f.write(
      "apps/server/src/conformance.test.ts",
      "import { buildCorpus } from './conformance'; import { normalize } from './contract'; import { validate } from './wireContract'; import { expect } from 'vite-plus/test'; expect(normalize()).toBe(true); expect(validate()).toBe(true); expect(buildCorpus()).toEqual([]);",
    );
    expect(f.test("conformance")).toMatchObject({
      status: "mixed",
      liveSubjects: ["apps/server/src/contract.ts", "apps/server/src/wireContract.ts"],
      deadSubjects: ["apps/server/src/conformance.ts"],
    });
    expect(runLivecode(["--strict"], f.options).exitCode).toBe(0);
  });

  it("resolves inherited tsconfig path aliases and ignores data and external dependencies", () => {
    const f = fixture();
    f.write("tsconfig.base.json", {
      compilerOptions: { paths: { "~/*": ["./apps/server/src/*"] } },
    });
    f.write("apps/server/tsconfig.json", { extends: "../../tsconfig.base.json" });
    f.write(
      "apps/server/src/main.ts",
      "import '~/live'; import '~/icon.svg'; import 'node:fs'; import './node_modules/external.ts'; import './dead.ts?raw';",
    );
    f.write("apps/server/src/live.ts", "export const live = true;");
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    f.write("apps/server/src/live.test.ts", "import '~/live';");
    expect(f.test("live").status).toBe("live");
    expect(f.inspect().reachableFiles).not.toContain("apps/server/src/dead.ts");
    expect(f.inspect().diagnostics).toEqual([]);
  });

  it("resolves private package exports without treating unused or type-only exports as roots", () => {
    const f = fixture();
    f.write("packages/private/package.json", {
      name: "@fixture/private",
      private: true,
      exports: {
        "./live": { types: "./src/type-only.ts", import: "./src/live.ts" },
        "./unused": "./src/unused.ts",
      },
    });
    f.write("packages/private/src/type-only.ts", "export interface Shape {}");
    f.write("packages/private/src/live.ts", "export const live = true;");
    f.write("packages/private/src/unused.ts", "export const unused = true;");
    f.write("apps/server/src/main.ts", "import '@fixture/private/live';");
    f.write("apps/server/src/package.test.ts", "import '@fixture/private/unused';");
    expect(f.test("package").status).toBe("dead");
    expect(f.inspect().reachableFiles).toContain("packages/private/src/live.ts");
    expect(f.inspect().reachableFiles).not.toContain("packages/private/src/type-only.ts");
  });

  it("seeds published runtime exports, wildcard exports and both runtime conditions", () => {
    const f = fixture();
    f.write("packages/public/package.json", {
      name: "@fixture/public",
      exports: {
        ".": { types: "./src/types.ts", import: "./src/esm.ts", require: "./src/cjs.cts" },
        "./feature/*": "./src/feature/*.ts",
      },
    });
    for (const file of ["types.ts", "esm.ts", "cjs.cts", "feature/one.ts"])
      f.write(`packages/public/src/${file}`, "export const value = true;");
    f.write(
      "apps/server/src/published.test.ts",
      "import '@fixture/public'; import '@fixture/public/feature/one';",
    );
    expect(f.test("published").status).toBe("live");
    expect(f.inspect().productionEntries).toContain("packages/public/src/cjs.cts");
    expect(f.inspect().reachableFiles).not.toContain("packages/public/src/types.ts");
  });

  it("unions mobile native platforms rather than dropping platform-only subjects", () => {
    const f = fixture();
    f.write("apps/mobile/index.ts", "import './src/widget';");
    for (const platform of ["ios", "android", "native"])
      f.write(`apps/mobile/src/widget.${platform}.tsx`, "export const widget = true;");
    f.write("apps/mobile/src/widget.test.ts", "import './widget';");
    const result = inspectLivecode({ root: f.root, entries: ["apps/mobile/index.ts"] });
    expect(result.tests[0].status).toBe("live");
    expect(result.tests[0].subjects).toHaveLength(3);
  });

  it("follows Astro frontmatter/client imports and executable URLs without treating URL existence checks as imports", () => {
    const f = fixture();
    f.write(
      "apps/marketing/src/pages/index.astro",
      `---\nimport '../server';\n---\n<h1>Hi</h1>\n<script>import '../client';</script>`,
    );
    f.write("apps/marketing/src/server.ts", "export const server = true;");
    f.write("apps/marketing/src/client.ts", "export const client = true;");
    f.write(
      "apps/marketing/src/client.test.ts",
      "import './client'; new URL('./missing.ts', import.meta.url);",
    );
    f.write("apps/server/src/main.ts", "new Worker(new URL('./worker.ts', import.meta.url));");
    f.write("apps/server/src/worker.ts", "export const worker = true;");
    const result = inspectLivecode({
      root: f.root,
      entries: [...f.options.entries, "apps/marketing/src/pages/index.astro"],
    });
    expect(result.reachableFiles).toEqual(
      expect.arrayContaining([
        "apps/marketing/src/server.ts",
        "apps/marketing/src/client.ts",
        "apps/server/src/worker.ts",
      ]),
    );
    expect(result.tests[0].subjects).toEqual(["apps/marketing/src/client.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("surfaces missing entry points and local edges for strict qualification", () => {
    const f = fixture();
    f.write("apps/server/src/main.ts", "import './missing';");
    const result = runLivecode(["--strict"], {
      root: f.root,
      entries: [...f.options.entries, "apps/server/src/missing-entry.ts"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.report.diagnostics.map((entry) => entry.message)).toEqual([
      "Unresolved local runtime import: ./missing",
      "Missing production entry point",
    ]);
    expect(runLivecode([], f.options).exitCode).toBe(0);
  });

  it("keeps generated output, dependency copies and references out of the audit", () => {
    const f = fixture();
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    f.write("apps/server/src/dead.test.ts", "import './dead';");
    for (const directory of [
      "apps/server/dist",
      "apps/server/node_modules",
      "apps/marketing/.astro",
      "apps/desktop/.electron-runtime",
      "apps/server/.scient-next",
      ".repos/reference",
    ]) {
      f.write(`${directory}/irrelevant.test.ts`, "import './missing';");
    }
    expect(f.inspect().summary).toMatchObject({ tests: 1, sourceFiles: 3, dead: 1 });
    expect(f.inspect().diagnostics).toEqual([]);
  });

  it("supports reasoned exact-path allowlists without making the subject live", () => {
    const f = fixture();
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    f.write("apps/server/src/dead.test.ts", "import './dead';");
    f.write("allowlist.json", [
      {
        test: "apps/server/src/dead.test.ts",
        reason: "Retained migration utility, exercised by an offline operator.",
      },
    ]);
    const result = runLivecode(["--strict", "--allowlist", "allowlist.json"], f.options);
    expect(result.exitCode).toBe(0);
    expect(result.report.summary).toMatchObject({ dead: 0, allowed: 1 });
    expect(result.report.reachableFiles).not.toContain("apps/server/src/dead.ts");
    expect(result.output).toContain("allowlisted: Retained migration utility");
    f.write("allowlist.json", [{ test: "apps/server/src/dead.test.ts", reason: " " }]);
    expect(runLivecode(["--strict", "--allowlist", "allowlist.json"], f.options).exitCode).toBe(1);
    f.write("allowlist.json", [{ test: "deleted.test.ts", reason: "Old exemption" }]);
    expect(runLivecode(["--allowlist", "allowlist.json"], f.options).output).toContain(
      "missing test",
    );
  });

  it("renders readable and JSON reports, failing only when strict was requested", () => {
    const f = fixture();
    f.write("apps/server/src/dead.ts", "export const dead = true;");
    f.write("apps/server/src/dead.test.ts", "import './dead';");
    const ordinary = runLivecode([], f.options);
    expect(ordinary.exitCode).toBe(0);
    expect(ordinary.output).toContain("DEAD apps/server/src/dead.test.ts");
    const strict = runLivecode(["--strict", "--format", "json"], f.options);
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(strict.output)).toEqual(ordinary.report);
    expect(formatReport(strict.report)).toBe(ordinary.output);
    expect(runLivecode(["--format"], f.options).exitCode).toBe(0);
    expect(runLivecode(["--strict", "--unknown"], f.options).exitCode).toBe(1);
  });
});
