#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const pack = new URL("apps/server/src/scient/extensions/brandIcons/", root);
const listPath = new URL("scient-extension-brands.json", import.meta.url);
const brands = JSON.parse(await NodeFSP.readFile(listPath, "utf8"));
const curated = JSON.parse(
  await NodeFSP.readFile(new URL("../discover/curatedIcons.json", pack), "utf8"),
);
const normalize = (name) => name.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
const cache = new URL(".logs/icon-sources/", root);
await NodeFSP.mkdir(cache, { recursive: true });
const fetchResource = async (url) => {
  const path = new URL(NodeCrypto.createHash("sha256").update(url).digest("hex"), cache);
  try {
    return await NodeFSP.readFile(path);
  } catch {
    /* Fetch uncached source. */
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5_000_000) throw new Error(`Image too large: ${url}`);
  await NodeFSP.writeFile(path, bytes);
  return bytes;
};
// Sharp does not decode ICO containers; decode their embedded PNG or uncompressed DIB.
const decodeIcon = async (bytes) => {
  if (bytes.readUInt32LE(0) !== 0x00010000) return bytes;
  const entries = Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const offset = 6 + i * 16;
    return {
      size: (bytes[offset] || 256) * (bytes[offset + 1] || 256),
      data: bytes.subarray(
        bytes.readUInt32LE(offset + 12),
        bytes.readUInt32LE(offset + 12) + bytes.readUInt32LE(offset + 8),
      ),
    };
  }).sort((a, b) => b.size - a.size);
  for (const { data } of entries) {
    if (data.subarray(1, 4).toString() === "PNG") return data;
    if (
      data.length < 40 ||
      ![1, 4, 8, 24, 32].includes(data.readUInt16LE(14)) ||
      data.readUInt32LE(16) !== 0
    )
      continue;
    const width = data.readInt32LE(4);
    const height = data.readInt32LE(8) / 2;
    if (width <= 0 || height <= 0 || width > 256 || height > 256) continue;
    const bits = data.readUInt16LE(14);
    const header = data.readUInt32LE(0);
    const paletteSize = bits <= 8 ? (data.readUInt32LE(32) || 2 ** bits) * 4 : 0;
    const start = header + paletteSize;
    const stride = Math.ceil((width * bits) / 32) * 4;
    const maskStride = Math.ceil(width / 32) * 4;
    if (data.length < start + stride * height) continue;
    const rgba = Buffer.alloc(width * height * 4);
    let alpha = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const row = start + (height - y - 1) * stride;
        let from = row + x * (bits / 8);
        if (bits <= 8) {
          const value = data[row + Math.floor((x * bits) / 8)];
          const index = (value >> (8 - bits - ((x * bits) % 8))) & ((1 << bits) - 1);
          from = header + index * 4;
        }
        const to = (y * width + x) * 4;
        rgba[to] = data[from + 2];
        rgba[to + 1] = data[from + 1];
        rgba[to + 2] = data[from];
        rgba[to + 3] = bits === 32 ? data[from + 3] : 255;
        alpha ||= bits === 32 && data[from + 3] !== 0;
      }
    }
    if (!alpha) {
      const maskStart = start + stride * height;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const mask = data[maskStart + (height - y - 1) * maskStride + Math.floor(x / 8)] ?? 0;
          rgba[(y * width + x) * 4 + 3] = mask & (0x80 >> (x % 8)) ? 0 : 255;
        }
      }
    }
    return sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  }
  throw new Error("No supported image in ICO container");
};
const siteIcons = async (website) => {
  const html = (await fetchResource(website)).toString("utf8");
  const candidates = [];
  const attribute = (tag, name) =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag[0], "rel") ?? "";
    const href = attribute(tag[0], "href");
    if (!href) continue;
    const url = new URL(href.replaceAll("&amp;", "&"), website).href;
    if (/\bicon\b/.test(rel)) {
      const size = Number(attribute(tag[0], "sizes")?.split("x")[0]) || 0;
      candidates.push({
        url,
        rank: (/\.svg(?:\?|$)/.test(url) ? 4000 : /apple-touch-icon/.test(rel) ? 1000 : 0) + size,
      });
    }
    if (rel === "manifest") {
      try {
        const manifest = JSON.parse((await fetchResource(url)).toString("utf8"));
        for (const item of manifest.icons ?? []) {
          candidates.push({
            url: new URL(item.src, url).href,
            rank: Number(item.sizes?.split("x")[0]) || 0,
          });
        }
      } catch {
        // A broken web manifest must not hide valid declared icons.
      }
    }
  }
  return [
    ...candidates.sort((a, b) => b.rank - a.rank).map((item) => item.url),
    new URL("/apple-touch-icon.png", website).href,
    new URL("/favicon.ico", website).href,
  ];
};
const simpleVersion = "16.36.0";
const simple = JSON.parse(
  (
    await fetchResource(
      `https://cdn.jsdelivr.net/npm/simple-icons@${simpleVersion}/data/simple-icons.json`,
    )
  ).toString(),
);
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const simpleNames = {
  "cloudflare-docs": "cloudflare",
  "hugging-face": "huggingface",
  "microsoft-learn": "microsoft",
  "42crunch-api-security-testing": "42crunch",
  "chrome-devtools": "googlechrome",
  aws: "amazonwebservices",
  "new-relic": "newrelic",
  "outlook-email": "microsoftoutlook",
  "outlook-calendar": "microsoftoutlook",
  teams: "microsoftteams",
  "google-cloud": "googlecloud",
  "stack-overflow": "stackoverflow",
  terraform: "terraform",
  "scholar-gateway": "wiley",
  "pydantic-ai": "pydantic",
  "laravel-boost": "laravel",
  "teamcity-cli": "teamcity",
};
const corners = (pixels, width, height) =>
  [0, width - 1, (height - 1) * width, height * width - 1].map((i) => [
    ...pixels.subarray(i * 4, i * 4 + 4),
  ]);
const opaquePixels = (pixels) => {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
  return true;
};
const opaqueSquare = (pixels, width, height) => {
  const points = corners(pixels, width, height);
  return (
    Math.abs(width / height - 1) < 0.12 &&
    opaquePixels(pixels) &&
    points.every(
      (p) => p[3] === 255 && p.slice(0, 3).every((c, i) => Math.abs(c - points[0][i]) < 20),
    )
  );
};
const roundedTile = (pixels, width, height) => {
  if (Math.abs(width / height - 1) > 0.12) return false;
  const edge = (x, y) => {
    const offset = (y * width + x) * 4;
    return pixels[offset + 3] > 250 && [0, 1, 2].some((c) => pixels[offset + c] < 235);
  };
  const insetX = Math.round(width * 0.04);
  const insetY = Math.round(height * 0.04);
  return [0, 1, 2, 3].every((side) => {
    let covered = 0;
    for (let i = 1; i < 20; i++) {
      const x = Math.round(((width - 1) * i) / 20);
      const y = Math.round(((height - 1) * i) / 20);
      if (
        edge(
          side < 2 ? x : side === 2 ? insetX : width - 1 - insetX,
          side < 2 ? (side === 0 ? insetY : height - 1 - insetY) : y,
        )
      )
        covered++;
    }
    return covered >= 12;
  });
};
const render = async (bytes, source, brand) => {
  bytes = await decodeIcon(bytes);
  const meta = await sharp(bytes).metadata();
  if (meta.format !== "svg" && Math.min(meta.width, meta.height) < 128)
    throw new Error(`Low resolution ${meta.width}×${meta.height}`);
  if (meta.format === "svg" && source.color)
    bytes = Buffer.from(bytes.toString().replace("<svg", `<svg fill="${source.color}"`));
  const decoded = await sharp(bytes, { density: meta.format === "svg" ? 1200 : 72 })
    .resize(1024, 1024, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let {
    data,
    info: { width, height },
  } = decoded;
  if (source.extendBackground) {
    const rgb = Buffer.from(source.background.slice(1), "hex");
    const seen = new Uint8Array(width * height);
    const queue = [];
    const visit = (pixel) => {
      if (seen[pixel]) return;
      seen[pixel] = 1;
      const offset = pixel * 4;
      if (data[offset + 3] < 250 || [0, 1, 2].every((c) => data[offset + c] > 240))
        queue.push(pixel);
    };
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const pixel = queue[cursor];
      data.set([...rgb, 255], pixel * 4);
      if (pixel % width > 0) visit(pixel - 1);
      if (pixel % width < width - 1) visit(pixel + 1);
      if (pixel >= width) visit(pixel - width);
      if (pixel < (height - 1) * width) visit(pixel + width);
    }
    data = await sharp(data, { raw: { width, height, channels: 4 } })
      .flatten({ background: "#ffffff" })
      .ensureAlpha()
      .raw()
      .toBuffer();
  }
  // Remove only a uniform outside border; alpha survives on actual marks.
  const trimmed = await sharp(data, { raw: { width, height, channels: 4 } })
    .trim({ threshold: 12 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const t = trimmed.info;
  const isTile =
    source.mode === "tile" ||
    (source.mode !== "mark" &&
      Math.abs(width / height - 1) < 0.12 &&
      opaquePixels(data) &&
      corners(data, width, height).every(
        (point) => point[3] === 255 && point.slice(0, 3).some((c) => c < 235),
      ));
  let mode = isTile ? "tile" : "mark";
  // A white margin enclosing a coloured square belongs to the source, not the tile.
  if (
    source.mode !== "mark" &&
    !isTile &&
    opaqueSquare(trimmed.data, t.width, t.height) &&
    corners(trimmed.data, t.width, t.height)[0]
      .slice(0, 3)
      .some((c) => c < 230)
  ) {
    data = trimmed.data;
    width = t.width;
    height = t.height;
    mode = "tile";
  }
  if (source.mode !== "mark" && mode === "mark" && roundedTile(trimmed.data, t.width, t.height)) {
    data = trimmed.data;
    width = t.width;
    height = t.height;
    mode = "tile";
  }
  if (source.trimFrame) {
    data = trimmed.data;
    width = t.width;
    height = t.height;
  }
  const edgeOffset = Math.floor(width / 2) * 4;
  const inferredBackground =
    mode === "tile" ? `#${data.subarray(edgeOffset, edgeOffset + 3).toString("hex")}` : "#ffffff";
  const background = source.background ?? brand.background ?? inferredBackground;
  let tile;
  if (mode === "tile") {
    tile = await sharp(data, { raw: { width, height, channels: 4 } })
      .resize(256, 256, { fit: "fill" })
      .flatten({ background })
      .removeAlpha()
      .png()
      .toBuffer();
  } else {
    const mark = await sharp(data, { raw: { width, height, channels: 4 } })
      .trim({ threshold: 12 })
      .png()
      .toBuffer();
    const cleanMark = await sharp(mark).trim({ threshold: 12 }).png().toBuffer();
    const box = await sharp(cleanMark).metadata();
    if (Math.max(box.width / box.height, box.height / box.width) > 2.8)
      throw new Error("Wordmark rather than app mark");
    const resized = await sharp(cleanMark).resize(174, 174, { fit: "inside" }).png().toBuffer();
    tile = await sharp({ create: { width: 256, height: 256, channels: 3, background } })
      .composite([{ input: resized, gravity: "centre" }])
      .png()
      .toBuffer();
  }
  const stats = await sharp(tile).stats();
  if (stats.entropy < 0.1) throw new Error("Blank icon");
  const webp = await sharp(tile).webp({ quality: 90, effort: 6 }).toBuffer();
  if (webp.length > 25_600) throw new Error(`Tile exceeds 25 KB: ${webp.length}`);
  return {
    data: `data:image/webp;base64,${webp.toString("base64")}`,
    mode,
    width: meta.width,
    height: meta.height,
    format: meta.format,
    bytes: webp.length,
  };
};
const icons = {};
const aliases = {};
const missing = [];
const failures = {};
let cursor = 0;
await NodeFSP.mkdir(pack, { recursive: true });
const license =
  "Brand-owned artwork used to identify the service; trademarks remain with their respective owners. No open artwork license asserted.";
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (cursor < brands.length) {
      const brand = brands[cursor++];
      if (brand.omitted) continue;
      const si = simple.find((item) => item.slug === (simpleNames[brand.key] ?? slug(brand.key)));
      let candidates = [];
      const add = (url, extra = {}) =>
        candidates.push({ kind: "official", url, licenseNote: license, ...extra });
      if (brand.source?.rendering) candidates.push(brand.source);
      if (!brand.source?.rendering) {
        if (si?.source && si.source.endsWith(".svg"))
          add(si.source.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/"));
        if (!brand.source?.rendering && brand.website) {
          try {
            for (const url of await siteIcons(brand.website))
              if (/\.svg(?:\?|$)/.test(url)) add(url, { color: si ? `#${si.hex}` : undefined });
          } catch {
            /* Try catalog sources. */
          }
        }
        if (si)
          add(`https://cdn.jsdelivr.net/npm/simple-icons@${simpleVersion}/icons/${si.slug}.svg`, {
            kind: "simple-icons",
            color: `#${si.hex}`,
            mode: "mark",
            licenseNote:
              "Simple Icons 16.36.0 SVG: CC0-1.0; brand trademarks remain with their owners.",
            brandSource: si.source,
          });
        if (brand.source?.url && brand.source.kind !== "codex-plugin")
          candidates.push({ ...brand.source, licenseNote: license });
        if (brand.website && !brand.source?.rendering) {
          try {
            for (const url of await siteIcons(brand.website))
              if (!/\.svg(?:\?|$)/.test(url)) add(url);
          } catch {
            /* Try catalog source. */
          }
        }
        if (brand.source?.url && brand.source.kind === "codex-plugin")
          candidates.push({ ...brand.source, licenseNote: license });
      }
      let result;
      const errors = [];
      for (const source of candidates) {
        try {
          result = await render(await fetchResource(source.url), source, brand);
          brand.source = {
            ...source,
            rendering: result.mode,
            sourceWidth: result.width,
            sourceHeight: result.height,
            sourceFormat: result.format,
            outputBytes: result.bytes,
          };
          break;
        } catch (error) {
          errors.push(`${source.url}: ${String(error)}`);
        }
      }
      if (!result) {
        missing.push(brand.key);
        console.error("MISSING", brand.key);
        failures[brand.key] = errors;
        continue;
      }
      if (Object.hasOwn(curated, brand.key)) curated[brand.key] = result.data;
      else icons[brand.key] = result.data;
      for (const name of [brand.key, ...brand.names]) {
        const key = normalize(name);
        if (aliases[key] && aliases[key] !== brand.key) throw new Error(`Ambiguous alias: ${key}`);
        aliases[key] = brand.key;
      }
      console.log(brand.key, brand.source.kind, result.mode, `${result.width}×${result.height}`);
    }
  }),
);
await NodeFSP.writeFile(
  new URL(".logs/icon-source-failures.json", root),
  JSON.stringify(failures, null, 2),
);
await NodeFSP.writeFile(listPath, JSON.stringify(brands, null, 2) + "\n");
if (missing.length) throw new Error(`Missing active brands: ${missing.join(", ")}`);
const sorted = (record) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
const bytes = Buffer.byteLength(JSON.stringify(icons)) + Buffer.byteLength(JSON.stringify(curated));
if (bytes > 4_000_000) throw new Error(`Pack exceeds 4 MB: ${bytes}`);
await NodeFSP.writeFile(
  new URL("brandIcons.json", pack),
  JSON.stringify(sorted(icons), null, 2) + "\n",
);
await NodeFSP.writeFile(
  new URL("../discover/curatedIcons.json", pack),
  JSON.stringify(sorted(curated), null, 2) + "\n",
);
await NodeFSP.writeFile(
  new URL("aliases.json", pack),
  JSON.stringify(sorted(aliases), null, 2) + "\n",
);
const escape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const shipped = brands.filter((brand) => aliases[normalize(brand.key)]);
const examples = new Set([
  "hex",
  "motherduck",
  "supabase",
  "kaggle",
  "github",
  "linear",
  "atlassian",
  "vercel",
  "spotify",
  "posthog",
  "gmail",
  "google-drive",
  "google-calendar",
  "slack",
  "notion",
  "figma",
]);
for (const [file, entries] of [
  ["extension-brand-icons", shipped],
  ["extension-owner-examples", shipped.filter((brand) => examples.has(brand.key))],
]) {
  const html = `<!doctype html><meta charset="utf-8"><title>Scient extension brand icons</title>
<style>*{box-sizing:border-box}body{margin:0;font:12px system-ui;background:#eee;color:#111}main{display:grid;grid-template-columns:repeat(6,180px)}figure{margin:0;padding:8px;text-align:center;overflow-wrap:anywhere}section{display:flex;align-items:center;justify-content:space-evenly;padding:12px;background:#fff}section.dark{background:#191919}img{display:block;width:40px;height:40px;object-fit:cover;border-radius:25%;border:1px solid #dedede}section.dark img{border-color:#ffffff1a}img.large{width:64px;height:64px}img.avatar{border-radius:50%}figcaption{height:34px;padding-top:4px}</style>
<h1>${entries.length} bundled brands · 2× capture · row / large / avatar</h1><main>${entries.map((brand) => `<figure>${["light", "dark"].map((theme) => `<section class="${theme}">${["row", "large", "avatar"].map((size) => `<img class="${size}" src="${curated[brand.key] ?? icons[brand.key]}">`).join("")}</section>`).join("")}<figcaption>${escape(brand.key)}</figcaption></figure>`).join("\n")}</main>`;
  await NodeFSP.writeFile(new URL(`.logs/${file}.html`, root), html);
}
console.log(`${shipped.length} brands; ${bytes} bytes including curated pack`);
