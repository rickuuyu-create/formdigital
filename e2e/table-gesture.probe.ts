/** Mounted production-component regression; synthetic data, no LDS or accounts. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "@playwright/test";
import path from "node:path";

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, format: "iife", platform: "browser",
    jsx: "automatic", tsconfig: path.join(root, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {FormCanvas} from './client/src/components/FormCanvas';
      import {I18nProvider} from './client/src/lib/i18n';
      const guides=[{xRatio:0,yRatio:0,widthRatio:.4,heightRatio:.4},{xRatio:.5,yRatio:0,widthRatio:.4,heightRatio:.4},{xRatio:0,yRatio:.5,widthRatio:.4,heightRatio:.4},{xRatio:.5,yRatio:.5,widthRatio:.4,heightRatio:.4}];
      window.commits=[];
      const field={id:'synthetic',type:'table',label:'probe',status:'confirmed',confirmed:true,page:1,x:10,y:10,width:80,height:40,maxRows:2,tableColumns:2,tableCellGuides:guides};
      createRoot(document.getElementById('root')).render(<I18nProvider><FormCanvas fields={[field]} values={{}} activeFieldId="synthetic" onActivate={()=>{}} mode="editor" tableEditMode="cell" onUpdateField={(id,patch)=>window.commits.push(patch)}/></I18nProvider>);
    ` },
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/bundle.js" ? result.outputFiles[0]!.text : `<style>.absolute{position:absolute}.inset-0{inset:0}.field-overlay{position:absolute}.mark-position-handle{position:absolute;display:block;border:1px solid green}.form-page{position:relative}</style><div id="root"></div><script src="/bundle.js"></script>`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
  };
  try {
    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      const browser = await engine.launch(name === "chromium" ? { channel: "chrome" } : {});
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const handle = page.locator('.mark-position-handle').first();
        await handle.waitFor();
        const box = (await handle.boundingBox())!;
        await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
        // Continuous pointer events and release can reach React in the same frame.
        await handle.evaluate((el, start) => {
          const rect = el.parentElement!.getBoundingClientRect();
          for (const type of ['pointermove', 'pointerup']) el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: type === 'pointerup' ? 0 : 1,
            clientX: start.x + 10 + rect.width * .05, clientY: start.y + 10,
          }));
        }, box);
        await page.mouse.up();
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        const commits = await page.evaluate(() => (window as any).commits);
        console.log(JSON.stringify({ engine: name, commits: commits.length, xRatio: commits[0]?.tableCellGuides?.[0]?.xRatio }));
        assert.equal(commits.length, 1, `${name}: one release must commit exactly once`);
        assert.ok(Math.abs(commits[0].tableCellGuides[0].xRatio - .05) < 1e-6, `${name}: commit latest event geometry`);

        await page.reload(); await handle.waitFor();
        const releaseStart = (await handle.boundingBox())!;
        await page.mouse.move(releaseStart.x + 10, releaseStart.y + 10); await page.mouse.down();
        await handle.evaluate((el, start) => {
          const rect = el.parentElement!.getBoundingClientRect();
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1,
            clientX: start.x + 10 + rect.width * .05, clientY: start.y + 10 }));
        }, releaseStart);
        await page.mouse.up();
        const releaseOnly = await page.evaluate(() => (window as any).commits);
        check(releaseOnly.length === 1 && Math.abs(releaseOnly[0].tableCellGuides[0].xRatio - .05) < 1e-6,
          `${name}: release coordinates work even when the last move was coalesced`);

        await page.reload(); await handle.waitFor();
        const still = (await handle.boundingBox())!;
        await page.mouse.move(still.x + 10, still.y + 10); await page.mouse.down(); await page.mouse.up();
        check(await page.evaluate(() => (window as any).commits.length) === 0, `${name}: stationary click commits nothing`);

        // A keyboard preview on one cell must survive starting a pointer gesture
        // on another cell; both belong to the pending geometry snapshot.
        await page.reload();
        await handle.waitFor();
        await handle.focus();
        await handle.press('ArrowRight');
        const second = page.locator('.mark-position-handle').nth(1);
        const secondBox = (await second.boundingBox())!;
        const parentWidth = await second.evaluate(el => el.parentElement!.getBoundingClientRect().width);
        await page.mouse.move(secondBox.x + 10, secondBox.y + 10);
        await page.mouse.down();
        await page.mouse.move(secondBox.x + 10 + parentWidth * .05, secondBox.y + 10, { steps: 3 });
        await page.mouse.up();
        const combined = await page.evaluate(() => (window as any).commits);
        console.log(JSON.stringify({engine: name, scenario: 'keyboard-then-other-cell', commits: combined.length,
          x0: combined[0]?.tableCellGuides?.[0]?.xRatio, x1: combined[0]?.tableCellGuides?.[1]?.xRatio}));
        assert.equal(combined.length, 1);
        check(Math.abs(combined[0].tableCellGuides[0].xRatio - .01) < 1e-6, `${name}: preserve prior keyboard preview`);
        // Native mouse coordinates may be rounded by an engine; bound this to
        // half a CSS pixel, while the keyboard-only cell stays exact above.
        check(Math.abs(combined[0].tableCellGuides[1].xRatio - .55) <= .5 / parentWidth, `${name}: preserve pointer edit`);

        for (const action of ['capture-loss', 'pointercancel', 'enter', 'arrow-mid-drag'] as const) {
          await page.reload();
          await handle.waitFor(); await handle.focus();
          await handle.evaluate(el => el.addEventListener('pointerdown', e => (window as any).pointerId = (e as PointerEvent).pointerId, { once: true }));
          const start = (await handle.boundingBox())!;
          await page.mouse.move(start.x + 10, start.y + 10); await page.mouse.down();
          await page.mouse.move(start.x + 25, start.y + 10, { steps: 3 });
          if (action === 'capture-loss') {
            await handle.evaluate(el => el.releasePointerCapture((window as any).pointerId));
          } else if (action === 'pointercancel') {
            await handle.evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: (window as any).pointerId })));
          } else if (action === 'enter') { await page.keyboard.press('Enter'); }
          else {
            const beforeKey = await handle.evaluate(el => (el as HTMLElement).style.left);
            await page.keyboard.press('ArrowRight');
            const afterKey = await handle.evaluate(el => (el as HTMLElement).style.left);
            check(beforeKey === afterKey, `${name}: pointer gesture ignores arrow nudge`);
          }
          await page.mouse.move(start.x + 30, start.y + 10); await page.mouse.up();
          const count = await page.evaluate(() => (window as any).commits.length);
          const left = await handle.evaluate(el => (el as HTMLElement).style.left);
          const completes = action === 'enter' || action === 'arrow-mid-drag';
          check(count === (completes ? 1 : 0), `${name}: ${action} commits=${count}`);
          if (!completes) check(left === '0%', `${name}: ${action} discards preview (${left})`);
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(failures, []);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
