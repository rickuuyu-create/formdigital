// Test-only harness: real canvas and PDF.js, no templates or customer data.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FormCanvas } from "../client/src/components/FormCanvas";
import { I18nProvider } from "../client/src/lib/i18n";
import type { FormField } from "../client/src/lib/form-model";
import * as pdfjs from "pdfjs-dist";

export function mountTextBaseline(fields: FormField[], values: Record<string, string>) {
  document.getElementById("root")!.style.display = "none";
  const host = document.createElement("div");
  host.id = "baseline-preview";
  host.style.width = "500px";
  document.body.appendChild(host);
  const root = createRoot(host);
  function Fixture() {
    const [current, setCurrent] = useState(values);
    return <FormCanvas fields={fields} values={current}
      activeFieldId="" onActivate={() => {}} mode="fill" onValueChange={(id, value) => setCurrent(old => ({ ...old, [id]: value }))}
      pageWidthMm={100} pageHeightMm={130} showDemoBackground={false} />;
  }
  root.render(<I18nProvider><Fixture /></I18nProvider>);
}

export async function renderBaselinePdf(base64: string, assets: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assets}/build/pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({ data: Uint8Array.from(atob(base64), c => c.charCodeAt(0)), standardFontDataUrl: `${assets}/standard_fonts/` });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const width = document.querySelector("#baseline-preview .document-page")!.getBoundingClientRect().width;
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.id = "baseline-pdf";
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    document.body.appendChild(canvas);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
    const content = await page.getTextContent();
    return content.items.filter((item): item is pdfjs.TextItem => "str" in item).map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5], height: item.height }));
  } finally { await doc.destroy(); }
}

export async function inkCenters(base64: string, rows: Array<{ y: number; height: number }>) {
  const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return rows.map(row => {
    let top = Infinity, bottom = -Infinity;
    for (let y = Math.ceil(row.y / 130 * canvas.height); y < Math.floor((row.y + row.height) / 130 * canvas.height); y++)
      for (let x = Math.ceil(canvas.width * .12); x < canvas.width * .88; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] < 80 && data[i + 1] < 130 && data[i + 2] > data[i] + 30 && data[i + 2] > data[i + 1] + 10) {
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
    return { top: top / canvas.height * 130, bottom: bottom / canvas.height * 130, center: (top + bottom) / 2 / canvas.height * 130 };
  });
}
