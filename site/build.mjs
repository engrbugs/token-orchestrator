import { mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const siteRoot = new URL("./", import.meta.url);
const outputRoot = new URL("../_site/", import.meta.url);
const assetVersion = "20260814";

const cssFiles = ["styles/tokens.css", "styles/base.css", "styles/components.css", "styles/sections.css"];

// All assets live in the repo-root assets/ directory (one level above site/).
const assets = [
  ["../assets/icon.png",                        "assets/icon.png"],
  ["../assets/application-main.png",            "assets/application-main.png"],
  ["../assets/application-settings-limits.png", "assets/application-settings-limits.png"],
];

// Tool/provider SVG icons from repo-root assets/icons/
const iconSvgs = [
  "claude", "codex", "opencode", "antigravity", "cline", "copilot",
  "hermes-agent", "openclaw", "kimi", "qwen", "grok", "cursor",
  "zed", "kilocode", "kiro", "codebuddy", "workbuddy", "proma",
  "deepseek", "mistral", "openrouter", "xai", "gemini",
  "token-orchestrator", "cohere", "minimax", "pi",
];

async function concat(files) {
  const parts = [];
  for (const f of files) parts.push(await readFile(new URL(f, siteRoot), "utf8"));
  return parts.join("\n");
}

function rewriteHtml(html) {
  // Collapse 4 dev CSS <link> tags into one bundled stylesheet.
  const cssRe = /\s*<link rel="stylesheet" href="styles\/tokens\.css(?:\?[^"]*)?">[\s\S]*?<link rel="stylesheet" href="styles\/sections\.css(?:\?[^"]*)?"\s*>/;
  // Collapse single dev JS <script> into the bundled version.
  const jsRe = /<script src="scripts\/main\.js(?:\?[^"]*)?"\s+defer><\/script>/;
  return html
    .replace(cssRe, `\n    <link rel="stylesheet" href="styles.css?v=${assetVersion}">`)
    .replace(jsRe, `<script src="app.js?v=${assetVersion}" defer></script>`);
}

// Clean and rebuild output directory.
await rm(outputRoot, { recursive: true, force: true });
await mkdir(new URL("assets/icons/", outputRoot), { recursive: true });

// Bundle CSS.
const bundledCss = await concat(cssFiles);
await writeFile(new URL("styles.css", outputRoot), bundledCss);

// Minify and write JS.
const rawJs = await readFile(new URL("scripts/main.js", siteRoot), "utf8");
const { code: minJs } = await transform(rawJs, { minify: true });
await writeFile(new URL("app.js", outputRoot), minJs);

// Rewrite and copy HTML.
const html = await readFile(new URL("index.html", siteRoot), "utf8");
await writeFile(new URL("index.html", outputRoot), rewriteHtml(html));

// Copy top-level assets.
for (const [src, dest] of assets) {
  await copyFile(new URL(src, siteRoot), new URL(dest, outputRoot));
}

// Copy tool/provider SVG icons.
for (const name of iconSvgs) {
  await copyFile(
    new URL(`../assets/icons/${name}.svg`, siteRoot),
    new URL(`assets/icons/${name}.svg`, outputRoot)
  );
}

console.log(`Built GitHub Pages site at ${fileURLToPath(outputRoot)}`);
