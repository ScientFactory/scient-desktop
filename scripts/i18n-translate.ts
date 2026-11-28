#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-shot catalog tool; synchronous Node APIs keep it small.
// Fills a language's GT catalogs in batches that a translator (person or agent) works through.
//
//   vp run i18n:translate export <locale> <dir> [--batch-size 300] [--skip-kept-by <locale>]
//   vp run i18n:translate check <locale> <dir>/<app>-NNN.json
//   vp run i18n:translate apply <locale> <dir>
//
// `export` writes `<app>-NNN.json` batches of every key whose <locale> value is still the English
// text. `--skip-kept-by de` leaves out keys German also keeps in English (names, commands, code).
// Each batch is `{ app, locale, entries: { key: english } }`; the translator writes
// `<app>-NNN.out.json` as `{ key: translation }`, keeping every key and placeholder.
// `check` reports what `apply` would reject in one batch, so a translator can fix it first.
// `apply` checks each translation against its English and writes the good ones into the
// catalogs. Placeholders, select branches, tags and JSX structure must match the English, and
// plurals must cover every plural form the language has. Rejected entries go to `rejected.json`
// with the reason; they stay English, so the next `export` offers them again.
// Docs: docs/internals/14_i18n.md ("Filling a language").
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parse, TYPE, type MessageFormatElement } from "@generaltranslation/icu";

type Catalog = Record<string, unknown>;
interface Batch {
  readonly app: string;
  readonly locale: string;
  readonly entries: Record<string, unknown>;
}

const root = NodePath.resolve(import.meta.dirname, "..");
const APPS = ["apps/web", "apps/mobile", "apps/desktop"];

const catalogPath = (app: string, locale: string) =>
  NodePath.join(root, app, "src/i18n/translations", `${locale}.json`);
const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function usage(): never {
  console.error(
    "usage: i18n-translate export <locale> <dir> [--batch-size N] [--skip-kept-by <locale>]\n" +
      "       i18n-translate check <locale> <dir>/<app>-NNN.json\n" +
      "       i18n-translate apply <locale> <dir>",
  );
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) usage();
  args.splice(index, 2);
  return value;
}

/**
 * Placeholders, tags and select branches: a translation must keep the same set. A plural reads its
 * argument, so a translation may add or drop one where its grammar needs it.
 */
function signature(elements: readonly MessageFormatElement[], into = new Set<string>()) {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.plural:
        into.add(`argument:${element.value}`);
        if (element.type === TYPE.plural) {
          for (const branch of Object.values(element.options)) signature(branch.value, into);
        }
        break;
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        into.add(`${element.type}:${element.value}`);
        break;
      case TYPE.select:
        into.add(`select:${element.value}:${Object.keys(element.options).sort().join("|")}`);
        for (const branch of Object.values(element.options)) signature(branch.value, into);
        break;
      case TYPE.tag:
        into.add(`tag:${element.value}`);
        signature(element.children, into);
        break;
      default:
        break;
    }
  }
  return into;
}

function plurals(
  elements: readonly MessageFormatElement[],
  into: Array<{ name: string; type: string; options: string[] }> = [],
) {
  for (const element of elements) {
    if (element.type === TYPE.plural) {
      into.push({
        name: element.value,
        type: element.pluralType ?? "cardinal",
        options: Object.keys(element.options),
      });
    }
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const branch of Object.values(element.options)) plurals(branch.value, into);
    }
    if (element.type === TYPE.tag) plurals(element.children, into);
  }
  return into;
}

function parseMessage(message: string): MessageFormatElement[] | Error {
  try {
    return parse(message);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function checkMessage(english: string, translation: string, locale: string): string | null {
  const source = parseMessage(english);
  if (source instanceof Error) return null; // English GT accepts but this parser does not; trust it.
  const target = parseMessage(translation);
  if (target instanceof Error) return `does not parse: ${target.message}`;
  const want = [...signature(source)].sort();
  const got = [...signature(target)].sort();
  if (!same(want, got))
    return `placeholders differ: want ${want.join(", ")}; got ${got.join(", ")}`;
  const sourcePlurals = plurals(source);
  for (const plural of plurals(target)) {
    const english = sourcePlurals.find((entry) => entry.name === plural.name);
    // An English plural with only exact (=N) branches and `other` needs no forms; a plural the
    // translation added does.
    if (
      english &&
      !english.options.some((option) => !option.startsWith("=") && option !== "other")
    ) {
      continue;
    }
    const forms = new Intl.PluralRules(locale, {
      type: plural.type === "ordinal" ? "ordinal" : "cardinal",
    }).resolvedOptions().pluralCategories;
    const missing = forms.filter((form) => !plural.options.includes(form));
    if (missing.length > 0) return `plural {${plural.name}} lacks ${missing.join(", ")}`;
  }
  return null;
}

/** JSX entries keep their elements and variables; only their strings change, and may move. */
function skeleton(node: unknown): unknown {
  if (typeof node === "string") return null;
  if (Array.isArray(node)) {
    return node
      .filter((child) => typeof child !== "string")
      .map((child) => JSON.stringify(skeleton(child)))
      .sort();
  }
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          // Plural branches (`b`) may be added for the language's forms; each keeps an English shape.
          key === "b" && value !== null && typeof value === "object"
            ? [
                ...new Set(Object.values(value).map((branch) => JSON.stringify(skeleton(branch)))),
              ].sort()
            : skeleton(value),
        ]),
    );
  }
  return node;
}

/** Plural forms the language has that a JSX `<Plural>` translation leaves to its `other` branch. */
function jsxPluralGaps(node: unknown, locale: string): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const gap = jsxPluralGaps(child, locale);
      if (gap !== null) return gap;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  const data = record.d as { t?: unknown; b?: Record<string, unknown> } | undefined;
  if (data?.t === "p" && data.b !== undefined) {
    const branches = Object.keys(data.b);
    // GT names the `one` form `singular`.
    const missing = new Intl.PluralRules(locale)
      .resolvedOptions()
      .pluralCategories.filter(
        (form) => !branches.includes(form) && !(form === "one" && branches.includes("singular")),
      );
    if (missing.length > 0) return `<Plural> lacks ${missing.join(", ")}`;
  }
  for (const value of Object.values(record)) {
    const gap = jsxPluralGaps(value, locale);
    if (gap !== null) return gap;
  }
  return null;
}

function check(english: unknown, translation: unknown, locale: string): string | null {
  if (typeof english === "string") {
    if (typeof translation !== "string") return "expected a string";
    if (translation.trim().length === 0) return "empty";
    return checkMessage(english, translation, locale);
  }
  if (typeof translation === "string") return "expected the JSX structure, got a string";
  if (!same(skeleton(english), skeleton(translation))) return "JSX elements or variables differ";
  return jsxPluralGaps(translation, locale);
}

function exportBatches(locale: string, dir: string, batchSize: number, keptBy: string | undefined) {
  NodeFS.mkdirSync(dir, { recursive: true });
  let total = 0;
  for (const app of APPS) {
    const english: Catalog = readJson(catalogPath(app, "en"));
    const target: Catalog = readJson(catalogPath(app, locale));
    const reference: Catalog | undefined = keptBy ? readJson(catalogPath(app, keptBy)) : undefined;
    const pending = Object.keys(english).filter(
      (key) =>
        same(target[key], english[key]) &&
        !(reference !== undefined && same(reference[key], english[key])),
    );
    const name = NodePath.basename(app);
    for (let start = 0; start < pending.length; start += batchSize) {
      const keys = pending.slice(start, start + batchSize);
      const batch: Batch = {
        app,
        locale,
        entries: Object.fromEntries(keys.map((key) => [key, english[key]])),
      };
      const file = NodePath.join(
        dir,
        `${name}-${String(start / batchSize + 1).padStart(3, "0")}.json`,
      );
      NodeFS.writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
    }
    console.log(`${app}: ${pending.length} to translate`);
    total += pending.length;
  }
  console.log(`${total} strings in ${dir}`);
}

interface Rejection {
  readonly app: string;
  readonly english: unknown;
  readonly translation: unknown;
  readonly reason: string;
}

/** Splits one batch's output into translations to write and rejections; stale keys are skipped. */
function reviewBatch(batch: Batch, out: Record<string, unknown>, english: Catalog, locale: string) {
  const accepted: Array<[string, unknown]> = [];
  const rejected: Record<string, Rejection> = {};
  for (const key of Object.keys(batch.entries)) {
    const source = english[key];
    // The source moved on since the export: the key is gone or its English changed.
    if (source === undefined || !same(source, batch.entries[key])) continue;
    if (!Object.hasOwn(out, key)) {
      rejected[key] = { app: batch.app, english: source, translation: null, reason: "missing" };
      continue;
    }
    const translation = out[key];
    if (same(translation, source)) continue; // Kept in English on purpose.
    const reason = check(source, translation, locale);
    if (reason === null) accepted.push([key, translation]);
    else rejected[key] = { app: batch.app, english: source, translation, reason };
  }
  return { accepted, rejected };
}

function checkBatch(locale: string, batchFile: string) {
  const batch: Batch = readJson(batchFile);
  const out: Record<string, unknown> = readJson(batchFile.replace(/\.json$/, ".out.json"));
  const { accepted, rejected } = reviewBatch(
    batch,
    out,
    readJson(catalogPath(batch.app, "en")),
    locale,
  );
  for (const [key, rejection] of Object.entries(rejected)) {
    console.log(JSON.stringify({ key, reason: rejection.reason, english: rejection.english }));
  }
  console.log(`${accepted.length} good, ${Object.keys(rejected).length} to fix`);
  if (Object.keys(rejected).length > 0) process.exitCode = 1;
}

function applyBatches(locale: string, dir: string) {
  const catalogs = new Map<string, { english: Catalog; target: Catalog; changed: number }>();
  const rejected: Record<string, Rejection> = {};
  let missingOutputs = 0;
  for (const file of NodeFS.readdirSync(dir).sort()) {
    if (!file.endsWith(".json") || file.endsWith(".out.json") || file === "rejected.json") continue;
    const batch: Batch = readJson(NodePath.join(dir, file));
    if (batch.locale !== locale) continue;
    const outFile = NodePath.join(dir, file.replace(/\.json$/, ".out.json"));
    if (!NodeFS.existsSync(outFile)) {
      missingOutputs += 1;
      continue;
    }
    let catalog = catalogs.get(batch.app);
    if (catalog === undefined) {
      catalog = {
        english: readJson(catalogPath(batch.app, "en")),
        target: readJson(catalogPath(batch.app, locale)),
        changed: 0,
      };
      catalogs.set(batch.app, catalog);
    }
    const review = reviewBatch(batch, readJson(outFile), catalog.english, locale);
    for (const [key, translation] of review.accepted) catalog.target[key] = translation;
    catalog.changed += review.accepted.length;
    Object.assign(rejected, review.rejected);
  }
  for (const [app, { target, changed }] of catalogs) {
    NodeFS.writeFileSync(catalogPath(app, locale), `${JSON.stringify(target, null, 2)}\n`);
    console.log(`${app}: ${changed} translations applied`);
  }
  NodeFS.writeFileSync(
    NodePath.join(dir, "rejected.json"),
    `${JSON.stringify(rejected, null, 2)}\n`,
  );
  console.log(
    `${Object.keys(rejected).length} rejected (see ${NodePath.join(dir, "rejected.json")})`,
  );
  if (missingOutputs > 0) console.log(`${missingOutputs} batches have no .out.json yet`);
  console.log("Next: vp fmt apps/*/src/i18n/translations, then vp run i18n:check.");
}

const args = process.argv.slice(2);
const batchSize = Number(option(args, "--batch-size") ?? 300);
const keptBy = option(args, "--skip-kept-by");
const [command, locale, dir] = args;
if (locale === undefined || dir === undefined || locale === "en") usage();
if (!NodeFS.existsSync(catalogPath(APPS[0]!, locale))) {
  console.error(
    `No ${locale}.json catalog: add the locale to each gt.config.json and run i18n:generate.`,
  );
  process.exit(2);
}
if (command === "export") exportBatches(locale, NodePath.resolve(dir), batchSize, keptBy);
else if (command === "check") checkBatch(locale, NodePath.resolve(dir));
else if (command === "apply") applyBatches(locale, NodePath.resolve(dir));
else usage();
