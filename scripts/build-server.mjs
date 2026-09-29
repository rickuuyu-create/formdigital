import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const outdir = path.resolve(process.argv[2] || "dist");
const external = [
  "@pdf-lib/fontkit",
  "@trpc/server",
  "csv-parse",
  "dotenv",
  "express",
  "fflate",
  "jose",
  "pdf-lib",
  "pdfjs-dist",
  "superjson",
  "zod",
  "vite",
  "nanoid",
];
await build({
  entryPoints: {
    index: "server/_core/index.ts",
    "mcp-stdio": "server/mcp/stdio.ts",
  },
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  outdir,
  external,
  banner: {
    js: 'import { createRequire as __fdCreateRequire } from "node:module"; const require = __fdCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});
if (process.argv.includes("--with-browser")) {
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(
    require.resolve("@playwright/test/package.json")
  );
  const playwrightRequire = createRequire(
    testRequire.resolve("playwright/package.json")
  );
  const core = path.dirname(
    playwrightRequire.resolve("playwright-core/package.json")
  );
  const executable = chromium.executablePath();
  await fs.access(executable);
  const runtime = path.join(outdir, "mcp-runtime");
  await fs.mkdir(runtime, { recursive: true });
  await fs.cp(core, path.join(runtime, "playwright-core"), {
    recursive: true,
    dereference: true,
  });
  await fs.cp(path.dirname(executable), path.join(runtime, "chromium"), {
    recursive: true,
    dereference: true,
    // Browser test runs can leave GPU/Windows caches beside chrome.exe.
    // Distribute only the runtime's shipped files and resource directories.
    filter: source => {
      const relative = path.relative(path.dirname(executable), source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return [
        "hyphen-data", "IwaKeyDistribution", "locales", "MEIPreload",
        "PrivacySandboxAttestationsPreloaded", "resources", "ABOUT",
      ].includes(first) || (!relative.includes(path.sep) &&
        /\.(?:manifest|pak|dll|exe|dat|bin|json)$/i.test(first));
    },
  });
  await fs.writeFile(
    path.join(runtime, "README.txt"),
    "Offline Form Digital conversion runtime. Playwright is Apache-2.0; see playwright-core/LICENSE and NOTICE. Chromium includes its own license/credits files. This engine starts only for MCP document import or preview. No user profile or browsing history is included.\n"
  );
}
