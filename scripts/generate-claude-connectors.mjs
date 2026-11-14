#!/usr/bin/env node
/**
 * Lists the claude.ai connectors Scient may link to: each "Add to Claude" address on Anthropic's
 * public directory pages. Pages without one (Claude Desktop extensions) are left out.
 * Run `node scripts/generate-claude-connectors.mjs`, then review the diff.
 */
import * as NodeFSP from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = new URL("apps/web/src/scient/extensions/claudeConnectors.json", root);
const SITEMAP = "https://claude.com/sitemap.xml";
const PAGE = /^https:\/\/claude\.com\/marketplace\/connectors\/[a-z0-9-]+$/;
const HERO =
  /"data-cta-position":"connectorHero","data-cta-url":"https:\/\/claude\.ai\/directory\/([0-9a-f-]{36})"/;
const TITLE = /\["\$","title","0",\{"children":"([^"]+?) connector \| Claude by Anthropic"/;
const HEADERS = { "user-agent": "Mozilla/5.0 (Scient connector list)", rsc: "1" };

const get = async (url, headers = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(40_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.text();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
};

const pages = [
  ...new Set(
    [...(await get(SITEMAP)).matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1])
      .filter((url) => PAGE.test(url)),
  ),
];
if (pages.length < 100) throw new Error(`Only ${pages.length} connector pages; not replacing.`);

const connectors = [];
const queue = [...pages];
await Promise.all(
  Array.from({ length: 12 }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const page = await get(url, HEADERS);
      const id = page?.match(HERO)?.[1];
      const name = page?.match(TITLE)?.[1];
      if (id && name) connectors.push([name.replaceAll("\\u0026", "&").trim(), id]);
    }
  }),
);
connectors.sort(([a], [b]) => a.localeCompare(b, "en"));
await NodeFSP.writeFile(
  output,
  `${JSON.stringify(connectors, null, 0).replaceAll("],[", "],\n[")}\n`,
);
console.log(`${connectors.length} of ${pages.length} connector pages can be added on claude.ai.`);
