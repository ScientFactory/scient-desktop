// SCIENT-FORK:START — verify the configured sequencers against Vitest's real file discovery.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createVitest } from "vite-plus/test/node";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const summary = {};
try {
  for (const [suite, count, fallback] of [
    ["server", 8, 0.6],
    ["web", 3, 1],
  ]) {
    const cwd = NodePath.join(root, "apps", suite);
    process.chdir(cwd);
    const ctx = await createVitest({
      root: cwd,
      config: NodePath.join(cwd, "vite.config.ts"),
      watch: false,
    });
    try {
      const files = await ctx.globTestSpecifications();
      const Sequencer = ctx.config.sequence.sequencer;
      const sequencer = new Sequencer(ctx);
      const weights = JSON.parse(
        NodeFS.readFileSync(NodePath.join(cwd, "src/testUtils/shardWeights.json"), "utf8"),
      );
      const key = (file) => NodePath.relative(cwd, file.moduleId).replaceAll("\\", "/");
      const seen = new Map();
      const shards = [];
      for (let index = 1; index <= count; index++) {
        ctx.config.shard = { index, count };
        const picked = await sequencer.shard([...files]);
        const reversed = await sequencer.shard(files.toReversed());
        NodeAssert.deepEqual(
          picked.map(key).sort(),
          reversed.map(key).sort(),
          `${suite}: discovery order changed the partition`,
        );
        for (const file of picked) seen.set(file, (seen.get(file) ?? 0) + 1);
        shards.push({
          index,
          files: picked.length,
          seconds: Number(
            picked.reduce((sum, file) => sum + (weights[key(file)] ?? fallback), 0).toFixed(3),
          ),
        });
      }
      NodeAssert.equal(seen.size, files.length, `${suite}: omitted or invented specifications`);
      for (const file of files)
        NodeAssert.equal(seen.get(file), 1, `${suite}: ${key(file)} must run exactly once`);
      summary[suite] = { files: files.length, shards };
    } finally {
      await ctx.close();
    }
  }
} finally {
  process.chdir(root);
}
console.log(JSON.stringify(summary, null, 2));
// SCIENT-FORK:END
