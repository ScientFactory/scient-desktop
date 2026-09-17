// @effect-diagnostics nodeBuiltinImport:off -- isolated publisher with no network or repository writes.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { bundledRecipes } from "./ComputeRecipeSource.ts";
import { recipeIdentity } from "./ComputeRecipe.ts";

const source = "a".repeat(40);
const recipe = { ...bundledRecipes.recipes[0]!, sourceCommit: source };
const candidate = { ...bundledRecipes, recipes: [recipe] };
const script = NodePath.resolve(import.meta.dirname, "../../../scripts/publish-compute-recipe.ts");

/** Exercise the real CLI, replacing external effects before its module loads. */
function publish(mode: "bootstrap" | "repeat" | "withdraw" | "unknown" | "moved") {
  const harness = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const candidate = ${JSON.stringify(candidate)};
    const mode = ${JSON.stringify(mode)};
    let stored = mode === 'bootstrap' ? null : {...candidate, sequence: 2};
    let writes = 0;
    let refs = 0;
    cp.execFileSync = (command, args) => {
      if (command === 'git') {
        if (args[0] === 'diff' && mode === 'moved') throw new Error('policy changed');
        return args[0] === 'rev-parse' ? '${source}\\n' : '';
      }
      assert.equal(command, process.execPath);
      assert.equal(args[0], 'apps/server/scripts/compute-recipes.ts');
      return JSON.stringify(candidate);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.github.com');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
      const path = new URL(url).pathname;
      if (options.method === 'POST') {
        assert.ok(path.endsWith('/git/refs'));
        assert.deepEqual(JSON.parse(options.body), {ref:'refs/heads/automation/compute-recipes-v1', sha:'${source}'});
        refs++;
        return Response.json({});
      }
      if (options.method === 'PUT') {
        assert.ok(path.endsWith('/contents/catalog.json'));
        const body = JSON.parse(options.body);
        assert.equal(body.branch, 'automation/compute-recipes-v1');
        assert.equal(body.sha, stored ? 'previous-content-sha' : undefined);
        stored = JSON.parse(Buffer.from(body.content, 'base64').toString());
        writes++;
        return Response.json({});
      }
      assert.equal(options.method, 'GET');
      if (path.includes('/git/ref/') || !stored) return new Response(null, {status:404});
      return Response.json({sha:'previous-content-sha', encoding:'base64', content:Buffer.from(JSON.stringify(stored, null, 2)+'\\n').toString('base64')});
    };
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'python',
      mode === 'withdraw' ? '${recipeIdentity(recipe)}' : mode === 'unknown' ? 'f'.repeat(64) : ''];
    let failure;
    try { await import(${JSON.stringify(script)}); } catch (error) { failure = error.message; }
    if (mode === 'moved') assert.equal(failure, 'policy changed');
    else if (mode === 'unknown') assert.match(failure, /existing recipe/);
    else assert.equal(failure, undefined);
    assert.equal(writes, mode === 'bootstrap' || mode === 'withdraw' ? 1 : 0);
    assert.equal(refs, mode === 'bootstrap' ? 1 : 0);
    if (mode === 'withdraw') assert.deepEqual(stored.withdrawn, ['${recipeIdentity(recipe)}']);
    if (mode === 'bootstrap') assert.equal(stored.recipes.length, 1);
  `;
  return NodeChildProcess.execFileSync(
    NodeProcess.execPath,
    ["--input-type=module", "-e", harness],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: source,
        GH_TOKEN: "synthetic-test-token",
      },
    },
  );
}

describe("qualified recipe publication", () => {
  it.each(["bootstrap", "repeat", "withdraw", "unknown", "moved"] as const)(
    "enforces publication guards: %s",
    (mode) => expect(() => publish(mode)).not.toThrow(),
  );
});
