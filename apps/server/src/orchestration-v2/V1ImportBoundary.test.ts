// @effect-diagnostics nodeBuiltinImport:off - Static architecture test scans source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import { assert, it } from "@effect/vitest";

const sourceRoot = NodePath.resolve(import.meta.dirname, "..");
const legacyTable =
  /\bprojection_(?:threads|thread_messages|thread_activities|thread_proposed_plans|thread_pull_requests|thread_sessions|turns|pending_approvals|state)\b/;
// Retained V1 libraries have historical/compatibility consumers. They must never
// become the execution engine of a native V2 admission, queue or provider turn.
const legacyReaders = [
  "orchestration/",
  "orchestration-v2/legacy/",
  "persistence/Migrations/",
] as const;
const legacyReaderFiles: Record<string, string> = {
  "persistence/reconcileV2PreviewMigration.ts":
    "transactional legacy preview-ledger schema reconciliation",
  "serverSettings.ts": "one-time provider history for settings migration",
  "orchestration-v2/scient-fork/ForkBoundaryReadModel.ts":
    "retained V1 boundary qualification; native forks use ConversationForkPlan",
  "orchestration-v2/scient-fork/ForkContextDelivery.ts":
    "retained V1 fork-context compatibility library",
  "orchestration-v2/scient-fork/forkRepository.ts":
    "legacy durable fork journal and inherited history",
  "orchestration-v2/scient-fork/historyRead.ts": "legacy inherited-history reader",
  "orchestration-v2/scient-fork/migrations/016_PreserveLegacyForkSessions.ts":
    "historical Scient schema migration",
  "persistence/Layers/ProjectionPendingApprovals.ts": "inert V1 approval history repository",
  "persistence/Layers/ProjectionState.ts": "retained V1 projection journal repository",
  "persistence/Layers/ProjectionThreadActivities.ts": "legacy activity history repository",
  "persistence/Layers/ProjectionThreadMessages.ts": "legacy transcript history repository",
  "persistence/Layers/ProjectionThreadProposedPlans.ts": "legacy proposed-plan history repository",
  "persistence/Layers/ProjectionThreadSessions.ts": "legacy provider history repository",
  "persistence/Layers/ProjectionThreads.ts": "legacy shell history repository",
  "persistence/Layers/ProjectionTurns.ts": "legacy completed-turn history repository",
  "persistence/ProjectionThreadPullRequests.ts": "legacy pull-request metadata repository",
  "persistence/RetiredThreadAttachmentCleanup.ts": "retired legacy attachment cleanup",
  "scient/answerAttention/completedAnswerSql.ts":
    "retained V1 completed-answer query; native shells produce their own metadata",
};

function productionTypeScriptFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/\.(?:test|testkit|test-harness)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

function inspectSource(path: string, source: string) {
  // TypeScript 7 exposes the lexer separately from its native compiler. Skip
  // trivia so comments cannot become imports or SQL ownership evidence.
  const scanner = createScanner(true, undefined, source);
  const tokens: Array<{ readonly kind: SyntaxKind; readonly text: string }> = [];
  const templateDepths: number[] = [];
  let braceDepth = 0;
  let previousTokenEnd = 0;
  while (true) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    if (
      kind === SyntaxKind.SlashToken &&
      [
        SyntaxKind.EqualsToken,
        SyntaxKind.OpenParenToken,
        SyntaxKind.OpenBracketToken,
        SyntaxKind.CommaToken,
        SyntaxKind.ColonToken,
        SyntaxKind.ReturnKeyword,
        SyntaxKind.EqualsGreaterThanToken,
        SyntaxKind.ExclamationToken,
      ].includes(tokens.at(-1)?.kind ?? SyntaxKind.Unknown)
    )
      kind = scanner.reScanSlashToken();
    if (kind === SyntaxKind.CloseBraceToken && templateDepths.at(-1) === braceDepth) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templateDepths.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) braceDepth += 1;
    else if (kind === SyntaxKind.CloseBraceToken) braceDepth -= 1;
    if (kind === SyntaxKind.TemplateHead) templateDepths.push(braceDepth);
    const tokenEnd = scanner.getTokenEnd();
    if (tokenEnd <= previousTokenEnd)
      throw new Error(`Source scanner failed to advance: ${path}:${tokenEnd}`);
    previousTokenEnd = tokenEnd;
    tokens.push({ kind, text: scanner.getTokenValue() || scanner.getTokenText() });
  }
  const imports: Array<{ readonly specifier: string; readonly typeOnly: boolean }> = [];
  const readsLegacyTable = tokens.some(
    ({ kind, text }) =>
      [
        SyntaxKind.StringLiteral,
        SyntaxKind.NoSubstitutionTemplateLiteral,
        SyntaxKind.TemplateHead,
        SyntaxKind.TemplateMiddle,
        SyntaxKind.TemplateTail,
      ].includes(kind) && legacyTable.test(text),
  );
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword)
      continue;
    const next = tokens[index + 1];
    if (next?.kind === SyntaxKind.OpenParenToken) {
      const specifier = tokens[index + 2];
      if (
        specifier?.kind === SyntaxKind.StringLiteral &&
        tokens[index + 3]?.kind === SyntaxKind.CloseParenToken
      )
        imports.push({
          specifier: specifier.text,
          typeOnly: tokens[index - 1]?.kind === SyntaxKind.TypeOfKeyword,
        });
      continue;
    }
    if (next?.kind === SyntaxKind.StringLiteral) {
      imports.push({ specifier: next.text, typeOnly: false });
      continue;
    }
    if (
      token.kind === SyntaxKind.ExportKeyword &&
      next?.kind !== SyntaxKind.TypeKeyword &&
      next?.kind !== SyntaxKind.OpenBraceToken &&
      next?.kind !== SyntaxKind.AsteriskToken
    )
      continue;
    let statementEnd = index + 1;
    while (statementEnd < tokens.length && tokens[statementEnd]?.kind !== SyntaxKind.SemicolonToken)
      statementEnd += 1;
    const clause = tokens.slice(index + 1, statementEnd);
    const from = clause.findIndex(({ kind }) => kind === SyntaxKind.FromKeyword);
    const specifier = clause[from + 1];
    if (from < 0 || specifier?.kind !== SyntaxKind.StringLiteral) continue;
    const bindings = clause.slice(0, from);
    const namedOnly =
      bindings[0]?.kind === SyntaxKind.OpenBraceToken &&
      bindings.at(-1)?.kind === SyntaxKind.CloseBraceToken;
    const members = namedOnly
      ? bindings
          .slice(1, -1)
          .reduce<Array<typeof bindings>>(
            (groups, binding) => {
              if (binding.kind === SyntaxKind.CommaToken) groups.push([]);
              else groups.at(-1)?.push(binding);
              return groups;
            },
            [[]],
          )
          .filter((group) => group.length > 0)
      : [];
    const typeOnly =
      next?.kind === SyntaxKind.TypeKeyword ||
      (members.length > 0 && members.every((member) => member[0]?.kind === SyntaxKind.TypeKeyword));
    imports.push({ specifier: specifier.text, typeOnly });
  }
  return { path, imports, readsLegacyTable };
}

const relativeSources = productionTypeScriptFiles(sourceRoot).map((path) =>
  inspectSource(
    NodePath.relative(sourceRoot, path).split(NodePath.sep).join("/"),
    NodeFS.readFileSync(path, "utf8"),
  ),
);
const byPath = new Map(relativeSources.map((file) => [file.path, file]));
const resolveLocalImport = (from: string, specifier: string) =>
  specifier.startsWith(".")
    ? NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(from), specifier))
    : undefined;

function nativeExecutionViolations(
  sources: ReadonlyMap<string, ReturnType<typeof inspectSource>>,
  roots: ReadonlyArray<string>,
) {
  const visited = new Set<string>();
  const violations: string[] = [];
  const inspect = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    const file = sources.get(path);
    if (file === undefined) return assert.fail(`Missing native execution source: ${path}`);
    for (const { specifier, typeOnly } of file.imports) {
      if (typeOnly) continue;
      const local = resolveLocalImport(path, specifier);
      if (local === undefined) continue;
      if (
        local.startsWith("orchestration/") ||
        /(?:ProviderService|ProviderSessionDirectory|ProviderSessionReaper|ProviderCommandReactor|ProviderRuntimeIngestion)\.ts$/.test(
          local,
        )
      ) {
        violations.push(`${path} -> ${local}`);
      }
      // Follow all local helpers, including Scient modules outside the V2
      // directory. Type-only historical contracts confer no execution authority.
      if (sources.has(local)) inspect(local);
    }
  };
  for (const root of roots) inspect(root);
  return violations;
}

it("keeps native V2 admission and execution independent of the retained V1 engine", () => {
  assert.isFalse(NodeFS.existsSync(NodePath.join(sourceRoot, "orchestration/runtimeLayer.ts")));
  const roots = [
    "server.ts",
    "ws.ts",
    "orchestration-v2/runtimeLayer.ts",
    "orchestration-v2/Orchestrator.ts",
    "orchestration-v2/ThreadManagementService.ts",
    "orchestration-v2/scient-fork/ConversationForkService.ts",
    "orchestration-v2/legacy/LegacyQueueCompatibility.ts",
    "scient/threadQueue/http.ts",
  ];
  assert.deepEqual(nativeExecutionViolations(byPath, roots), []);
});

it("confines V1 SQL reads to named historical and compatibility owners", () => {
  const readers = relativeSources.filter((file) => file.readsLegacyTable).map((file) => file.path);
  assert.deepEqual(
    readers.filter(
      (path) =>
        !legacyReaders.some((directory) => path.startsWith(directory)) &&
        legacyReaderFiles[path] === undefined,
    ),
    [],
  );
  for (const path of Object.keys(legacyReaderFiles))
    assert.isTrue(byPath.get(path)?.readsLegacyTable, path);
});

it("keeps legacy hydration and admission imports at explicit boundaries", () => {
  const importers = relativeSources
    .filter(
      (file) =>
        !file.path.startsWith("orchestration-v2/legacy/") &&
        file.imports.some(({ specifier }) =>
          resolveLocalImport(file.path, specifier)?.startsWith("orchestration-v2/legacy/"),
        ),
    )
    .map((file) => file.path)
    .toSorted();
  assert.deepEqual(importers, [
    "mcp/toolkits/threads/handlers.ts",
    "mcp/toolkits/threads/tools.ts",
    "orchestration-v2/EventSink.ts",
    "orchestration-v2/Orchestrator.ts",
    "orchestration-v2/ThreadManagementService.ts",
    "orchestration-v2/runtimeLayer.ts",
    // Pure historical-system decoding; no native execution authority.
    "orchestration-v2/scient-fork/ConversationForkPlan.ts",
    // Hydrates a historical source before selecting its immutable fork boundary.
    "orchestration-v2/scient-fork/ConversationForkService.ts",
    "orchestration-v2/scient-fork/ForkBoundaryReadModel.ts",
    "orchestration-v2/scient-fork/importRepository.ts",
    // Supplies the real historical importer to the composed replay fixture.
    "orchestration-v2/testkit/ProviderReplayHarness.ts",
    // Shared test support extracted from ProviderSessionManager.test.ts.
    "orchestration-v2/testkit/ProviderSessionManagerTestHarness.ts",
    "project/ProjectService.ts",
    "scient/conversationExport/ConversationSnapshotService.ts",
    "scient/conversationExport/conversationSnapshotProjection.ts",
    // Reexports the retained queue document reader/error API for compatibility HTTP.
    "scient/threadQueue/Ledger.ts",
    "scient/threadQueue/admission.ts",
    "scient/threadQueue/http.ts",
    "scient/threadQueue/migration.ts",
    "serverRuntimeStartup.ts",
  ]);
  const testSupportImporter = "orchestration-v2/testkit/ProviderSessionManagerTestHarness.ts";
  assert.deepEqual(
    relativeSources
      .filter((file) =>
        file.imports.some(
          ({ specifier }) => resolveLocalImport(file.path, specifier) === testSupportImporter,
        ),
      )
      .map((file) => file.path),
    [],
    "Provider-session-manager test support must not be imported by production modules.",
  );
});

it("distinguishes executable legacy access from comments and type contracts", () => {
  const comment = inspectSource(
    "helper.ts",
    "// SELECT * FROM projection_threads\n// import('./orchestration/engine.ts')\nconst regex = /projection_threads/;",
  );
  assert.isFalse(comment.readsLegacyTable);
  assert.deepEqual(comment.imports, []);
  const sql = inspectSource(
    "helper.ts",
    "const rows = sql`SELECT * FROM projection_thread_messages`;",
  );
  assert.isTrue(sql.readsLegacyTable);
  const dependencies = inspectSource(
    "helper.ts",
    `
    import type { Engine } from "./orchestration/engine.ts";
    import { type Snapshot } from "./orchestration/snapshot.ts";
    export * from "pdfjs-dist/legacy/build/pdf.worker.mjs";
    const load = () => import("./orchestration/engine.ts");
    import { Importer } from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
  `,
  );
  assert.deepEqual(dependencies.imports, [
    { specifier: "./orchestration/engine.ts", typeOnly: true },
    { specifier: "./orchestration/snapshot.ts", typeOnly: true },
    { specifier: "pdfjs-dist/legacy/build/pdf.worker.mjs", typeOnly: false },
    { specifier: "./orchestration/engine.ts", typeOnly: false },
    { specifier: "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts", typeOnly: false },
  ]);
  const external = dependencies.imports.find(
    ({ specifier }) => specifier === "pdfjs-dist/legacy/build/pdf.worker.mjs",
  );
  if (external === undefined) return assert.fail("Expected the external legacy dependency fixture");
  assert.isUndefined(resolveLocalImport("helper.ts", external.specifier));
  const sources = new Map([
    ["root.ts", inspectSource("root.ts", 'import { helper } from "./scient/helper.ts";')],
    [
      "scient/helper.ts",
      inspectSource("scient/helper.ts", 'const load = () => import("../orchestration/engine.ts");'),
    ],
    [
      "orchestration/engine.ts",
      inspectSource("orchestration/engine.ts", "export const engine = {};"),
    ],
  ]);
  assert.deepEqual(nativeExecutionViolations(sources, ["root.ts"]), [
    "scient/helper.ts -> orchestration/engine.ts",
  ]);
  const contractsOnly = inspectSource(
    "contracts.ts",
    `
    import type { Engine } from "./orchestration/engine.ts";
    export * from "pdfjs-dist/legacy/build/pdf.worker.mjs";
  `,
  );
  assert.deepEqual(
    nativeExecutionViolations(new Map([["contracts.ts", contractsOnly]]), ["contracts.ts"]),
    [],
  );
  assert.isFalse(legacyReaders.some((directory) => sql.path.startsWith(directory)));
  assert.isUndefined(legacyReaderFiles[sql.path]);
  const unlistedHydration = dependencies.imports.filter(
    ({ specifier, typeOnly }) =>
      !typeOnly &&
      resolveLocalImport(dependencies.path, specifier)?.startsWith("orchestration-v2/legacy/"),
  );
  assert.deepEqual(unlistedHydration, [
    {
      specifier: "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts",
      typeOnly: false,
    },
  ]);
});
