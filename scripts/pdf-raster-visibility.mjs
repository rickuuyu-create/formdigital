/**
 * R10-P1 — REAL PDF page-raster / pixel visibility helper.
 *
 * TEST-ONLY. This module is imported exclusively by test scripts
 * (`scripts/test-stored-csv-v2.mjs`). It MUST NEVER be imported by production code.
 *
 * Why this exists: the round-9 `analyzeTextVisibility()` was a hand-written
 * content-stream heuristic, not raster evidence. It could be fooled by a visible
 * blank run standing in for an invisible value, missed real ExtGState opacity, and
 * mis-classified rendering modes. This helper instead produces ACTUAL device
 * pixels: a real headless Chromium renders the page with pdf.js onto a canvas at a
 * fixed scale, and raw RGBA crops are returned for inspection.
 *
 * Nothing here is inferred from the content stream, operator counts, `Tj`
 * statistics or text extraction — the pixels come from genuine rasterisation.
 *
 * Design constraints honoured:
 *  - `node:http` server bound to 127.0.0.1 on a dynamically allocated free port.
 *  - Serves only: the test HTML, `node_modules/pdfjs-dist/build/pdf.mjs`,
 *    `pdf.worker.mjs`, pdf.js standard fonts, and the in-memory PDF bytes for the
 *    current call (never written to disk).
 *  - Browser, page and HTTP server are always released in `finally` / `close()`:
 *    no leaked listener, process or file.
 *  - R11-P2: a startup failure in `chromium.launch()` / `browser.newPage()` also
 *    releases the already-listening HTTP server and any half-built browser/page
 *    before rethrowing the original error; `close()` is idempotent.
 *  - No new dependencies (uses the already-present `playwright` + `pdfjs-dist`).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/** Fixed rasterisation scale. Device pixels = PDF points * scale. */
export const RASTER_SCALE = 3;

/**
 * Per-channel threshold above which a pixel counts as "actually different".
 * Chosen to sit above antialiasing noise but well below real glyph ink;
 * see the round-10 report for the measured positive/negative control values.
 */
export const DEFAULT_DIFF_THRESHOLD = 24;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot() {
  // scripts/ -> project root
  return path.resolve(HERE, "..");
}

/** The page loaded in the browser. Exposes window.__raster. */
const HTML_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>raster</title></head>
<body>
<script type="module">
window.__raster = async (opts) => {
  const docId = opts.docId;
  const scale = opts.scale || 3;
  const pageNumber = opts.pageNumber || 1;
  const pdfRegions = opts.pdfRegions || [];

  const pdfjs = await import("/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

  const res = await fetch("/doc/" + docId + ".pdf");
  const buf = new Uint8Array(await res.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: buf, standardFontDataUrl: "/standard_fonts/" }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    // A blank PDF page has no content at all (transparent). Real viewers composite
    // onto white paper; do the same so that "no ink" really means white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    const regions = pdfRegions.map((r) => {
      // OFFICIAL pdf.js coordinate conversion. The rectangle is a PDF user-space
      // rect [x0, y0, x1, y1]; pdf.js applies the real viewport transform, so the
      // y-axis flip is handled by pdf.js rather than being guessed here.
      const vr = viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
      const vx0 = Math.min(vr[0], vr[2]);
      const vx1 = Math.max(vr[0], vr[2]);
      const vy0 = Math.min(vr[1], vr[3]);
      const vy1 = Math.max(vr[1], vr[3]);

      const rx0 = Math.max(0, Math.floor(vx0));
      const ry0 = Math.max(0, Math.floor(vy0));
      const rx1 = Math.min(canvas.width, Math.ceil(vx1));
      const ry1 = Math.min(canvas.height, Math.ceil(vy1));
      const w = Math.max(0, rx1 - rx0);
      const hgt = Math.max(0, ry1 - ry0);

      let dataBase64 = "";
      if (w > 0 && hgt > 0) {
        const img = ctx.getImageData(rx0, ry0, w, hgt);
        const bytes = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
        let s = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        dataBase64 = btoa(s);
      }
      return {
        pdfRect: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
        canvasRect: { x: rx0, y: ry0, width: w, height: hgt },
        dataBase64: dataBase64,
      };
    });

    return {
      width: canvas.width,
      height: canvas.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      // [a, b, c, d, e, f] — authoritative PDF user space -> canvas device space.
      transform: Array.from(viewport.transform),
      scale: scale,
      regions: regions,
    };
  } finally {
    await doc.destroy();
  }
};
window.__ready = true;
</script>
</body>
</html>`;

/**
 * Release the page, browser and HTTP server, in that order, ignoring any error
 * from an individual step so that one failure never prevents the next release.
 * Idempotent: `state.closed` is set before anything is torn down, and the flag
 * is honoured by `close()` too, so a startup failure path and a normal close can
 * never double-release or leave a listener behind.
 *
 * @param {{ closed: boolean }} state
 * @param {{ page: import("playwright").Page | null, browser: import("playwright").Browser | null, server: import("node:http").Server, docs: Map<string, Buffer> }} resources
 */
async function releaseResources(state, resources) {
  if (state.closed) return;
  state.closed = true;
  const { page, browser, server, docs } = resources;
  if (page) {
    try {
      await page.close();
    } catch {
      /* a page that never opened or already died must not mask the real error */
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* same: teardown errors are swallowed, the original error is rethrown */
    }
  }
  try {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } catch {
    /* ignore */
  }
  docs.clear();
}

/**
 * Start a raster session: one HTTP server + one headless Chromium page, reused
 * for several PDFs. Always call `close()` in a `finally`.
 *
 * R11-P2: `launch()` and `newPage()` run inside a startup `try/catch`. If either
 * throws, the already-listening HTTP server (and any page/browser that did get
 * created) is released before the ORIGINAL error is rethrown unchanged, so a
 * failed startup can never leave a listening port or a browser child behind.
 *
 * @param {{ scale?: number, headless?: boolean, failureMode?: "none" | "launch" | "newPage" }} options
 *   `failureMode` is a TEST-ONLY injection point. Production code never imports
 *   this module, so it can never set it.
 * @param {{ port?: number, browser?: unknown, page?: unknown } | null} startupProbe
 *   TEST-ONLY out-parameter used by the round-11 startup-failure probe: it
 *   receives the listening port and, once created, the browser/page handles so
 *   the test can prove they were released. Never used by callers that render.
 */
export async function createRasterSession(options = {}, startupProbe = null) {
  const scale = options.scale ?? RASTER_SCALE;
  const root = findProjectRoot();
  const pdfjsBuild = path.join(root, "node_modules", "pdfjs-dist", "build");
  const pdfjsFonts = path.join(root, "node_modules", "pdfjs-dist", "standard_fonts");

  for (const p of [path.join(pdfjsBuild, "pdf.mjs"), path.join(pdfjsBuild, "pdf.worker.mjs")]) {
    if (!fs.existsSync(p)) throw new Error("pdfjs-dist build asset missing: " + p);
  }

  /** In-memory PDF bytes for the current/registered calls: id -> Buffer. */
  const docs = new Map();
  let nextId = 1;

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const sendFile = (file, type) => {
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    };

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(HTML_PAGE);
      return;
    }
    if (pathname === "/pdf.mjs") return sendFile(path.join(pdfjsBuild, "pdf.mjs"), "text/javascript; charset=utf-8");
    if (pathname === "/pdf.worker.mjs") return sendFile(path.join(pdfjsBuild, "pdf.worker.mjs"), "text/javascript; charset=utf-8");
    if (pathname.startsWith("/standard_fonts/")) {
      const name = path.basename(pathname);
      return sendFile(path.join(pdfjsFonts, name), "font/otf");
    }
    const m = pathname.match(/^\/doc\/([A-Za-z0-9_-]+)\.pdf$/);
    if (m && docs.has(m[1])) {
      const body = docs.get(m[1]);
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  if (startupProbe) startupProbe.port = port;

  // R11-P2: everything from here on must be released if startup fails.
  const state = { closed: false };
  let browser = null;
  let page = null;
  try {
    // TEST-ONLY injection: deterministic startup failure, fixed message, no path,
    // token or secret. Used by the round-11 probe to prove the cleanup below.
    if (options.failureMode === "launch")
      throw new Error("raster-startup-probe: simulated launch failure");
    browser = await chromium.launch({ headless: options.headless ?? true });
    if (startupProbe) startupProbe.browser = browser;
    if (options.failureMode === "newPage")
      throw new Error("raster-startup-probe: simulated newPage failure");
    page = await browser.newPage();
    if (startupProbe) startupProbe.page = page;
  } catch (error) {
    await releaseResources(state, { page, browser, server, docs });
    throw error; // the ORIGINAL error, unchanged
  }

  const session = {
    port,
    scale,

    /**
     * Rasterise page 1 of `bytes` and return real RGBA crops.
     *
     * @param {Uint8Array|Buffer} bytes
     * @param {{ pdfRegions?: Array<{x0:number,y0:number,x1:number,y1:number}> }} opts
     *        pdfRegions are PDF USER-SPACE rectangles (y-up, origin bottom-left).
     */
    async rasterize(bytes, opts = {}) {
      if (state.closed) throw new Error("raster session already closed");
      const id = "d" + nextId++;
      docs.set(id, Buffer.from(bytes));
      try {
        await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
        await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });
        const result = await page.evaluate(
          (args) => window.__raster(args),
          { docId: id, scale, pageNumber: opts.pageNumber ?? 1, pdfRegions: opts.pdfRegions ?? [] },
        );
        return result;
      } finally {
        // The bytes only ever live for the duration of this call.
        docs.delete(id);
      }
    },

    /** Idempotent: safe to call after a startup failure or after a normal run. */
    async close() {
      await releaseResources(state, { page, browser, server, docs });
    },
  };

  return session;
}

/** Decode a base64 RGBA crop back into a Uint8Array. */
export function decodeCrop(region) {
  if (!region || !region.dataBase64) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(region.dataBase64, "base64"));
}

/**
 * Apply a pdf.js viewport transform to a PDF user-space point.
 * transform = [a, b, c, d, e, f]; canvasX = a*x + c*y + e; canvasY = b*x + d*y + f.
 */
export function pdfToCanvas(transform, x, y) {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

/**
 * Convert a PDF user-space rect into a canvas rect using the authoritative
 * viewport transform (same semantics as pdf.js convertToViewportRectangle).
 */
export function pdfRectToCanvasRect(transform, x0, y0, x1, y1) {
  const p0 = pdfToCanvas(transform, x0, y0);
  const p1 = pdfToCanvas(transform, x1, y1);
  return {
    x0: Math.min(p0.x, p1.x),
    y0: Math.min(p0.y, p1.y),
    x1: Math.max(p0.x, p1.x),
    y1: Math.max(p0.y, p1.y),
  };
}

/**
 * Per-pixel difference between two crops that cover the SAME canvas rect.
 * Returns the number of differing pixels and their bounding box in canvas coords.
 */
export function diffCrops(testRegion, baseRegion, threshold = DEFAULT_DIFF_THRESHOLD) {
  const a = testRegion.canvasRect;
  const b = baseRegion.canvasRect;
  if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) {
    throw new Error(
      "diffCrops: crop rectangles differ (" + JSON.stringify(a) + " vs " + JSON.stringify(b) + ")",
    );
  }
  const ta = decodeCrop(testRegion);
  const ba = decodeCrop(baseRegion);

  let diffCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const w = a.width;
  const h = a.height;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(ta[i] - ba[i]);
      const dg = Math.abs(ta[i + 1] - ba[i + 1]);
      const db = Math.abs(ta[i + 2] - ba[i + 2]);
      const da = Math.abs(ta[i + 3] - ba[i + 3]);
      const d = dr > dg ? (dr > db ? (dr > da ? dr : da) : db > da ? db : da) : dg > db ? (dg > da ? dg : da) : db > da ? db : da;
      if (d > threshold) {
        diffCount += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (diffCount === 0) {
    return { diffCount: 0, bbox: null, width: 0, height: 0, ratio: 0 };
  }
  const bbox = { x0: a.x + minX, y0: a.y + minY, x1: a.x + maxX + 1, y1: a.y + maxY + 1 };
  return {
    diffCount,
    bbox,
    width: bbox.x1 - bbox.x0,
    height: bbox.y1 - bbox.y0,
    ratio: diffCount / Math.max(1, a.width * a.height),
  };
}

/** Intersection area / union area of two canvas rects (0 when either is missing). */
export function rectOverlapRatio(rectA, rectB) {
  if (!rectA || !rectB) return 0;
  const ix0 = Math.max(rectA.x0, rectB.x0);
  const iy0 = Math.max(rectA.y0, rectB.y0);
  const ix1 = Math.min(rectA.x1, rectB.x1);
  const iy1 = Math.min(rectA.y1, rectB.y1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const areaA = Math.max(0, rectA.x1 - rectA.x0) * Math.max(0, rectA.y1 - rectA.y0);
  const areaB = Math.max(0, rectB.x1 - rectB.x0) * Math.max(0, rectB.y1 - rectB.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
