import { sourceToRasterPageBatches, blobToBase64 } from "./lib/document-files";
import { runSourceImport } from "./lib/import-pipeline";
import { detectFormStructures } from "./lib/form-structure";
import { createFreeOcrSession } from "./lib/free-ocr";
import * as pdfjs from "pdfjs-dist";

declare global {
  interface Window {
    fdBridge: (method: string, args?: any) => Promise<any>;
    fdWorker: any;
  }
}
let controller: AbortController;
const invoke = (method: string, args?: any) => window.fdBridge(method, args);
window.fdWorker = {
  cancel: () => controller?.abort(),
  async import(input: any) {
    controller = new AbortController();
    const signal = controller.signal;
    const files = input.files.map(
      (f: any) =>
        new File(
          [Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))],
          f.name,
          { type: f.mimeType }
        )
    );
    const ocr = createFreeOcrSession(input.language ?? "auto");
    try {
      return await runSourceImport(
        {
          files,
          name: input.name,
          runDetection: input.detect,
          preprocessing: input.preprocessing,
          signal,
        },
        {
          createDraft: name => invoke("createDraft", { name }),
          uploadAsset: async u => {
            const { blob, ...meta } = u;
            return invoke("uploadAsset", {
              ...meta,
              base64: await blobToBase64(blob, signal),
            });
          },
          pageBatches: options => sourceToRasterPageBatches(files, options),
          detectStructures: async blob => detectFormStructures(blob),
          recognizeWords: async page => {
            const r = await ocr.recognize(
              new File([page.blob], "page.png", { type: "image/png" }),
              { signal }
            );
            return {
              truncated: r.truncated,
              words: r.suggestions.map(w => ({
                text: w.text,
                confidence: w.confidence,
                left: w.bbox.x0,
                top: w.bbox.y0,
                width: Math.max(1, w.bbox.x1 - w.bbox.x0),
                height: Math.max(1, w.bbox.y1 - w.bbox.y0),
              })),
            };
          },
          savePages: a => invoke("savePages", a),
          saveFields: a => invoke("saveFields", a),
          rollbackDeps: {
            deleteTemplate: id => invoke("deleteTemplate", { id }),
            deleteAsset: id => invoke("deleteAsset", { id }),
            listTemplateIds: () => invoke("listTemplateIds"),
            listAssetIds: () => invoke("listAssetIds"),
          },
          onProgress: message => {
            void invoke("progress", { message });
          },
          ocrAvailable: true,
          onReview: async ctx => {
            const { signal, ...review } = ctx;
            await invoke("review", review);
            return ctx.suggestedFields.map(f => ({
              ...f,
              definition: {
                ...f.definition,
                confirmed: false,
                aiSuggested: true,
              },
            }));
          },
        }
      );
    } finally {
      await ocr.terminate();
    }
  },
  async preview(input: any) {
    const bytes = Uint8Array.from(atob(input.base64), c => c.charCodeAt(0));
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d")!;
    let text = "",
      pageCount = 1;
    if (input.mimeType === "application/pdf") {
      const pdf = await pdfjs.getDocument({
        data: bytes,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard-fonts/",
      }).promise;
      try {
        pageCount = pdf.numPages;
        const page = await pdf.getPage(input.page);
        const original = page.getViewport({ scale: 1 }),
          viewport = page.getViewport({
            scale: Math.min(2, 1600 / original.width, 2000 / original.height),
          });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        text = (await page.getTextContent()).items
          .map((i: any) => i.str ?? "")
          .join(" ")
          .slice(0, 12000);
      } finally {
        await pdf.destroy();
      }
    } else {
      const image = await createImageBitmap(
        new Blob([bytes], { type: input.mimeType })
      );
      const scale = Math.min(1, 1600 / image.width);
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
    }
    if (input.fields)
      for (const f of input.fields) {
        const c = f.coordinate;
        ctx.strokeStyle = "#cc4422";
        ctx.lineWidth = 2;
        ctx.strokeRect(
          (c.xMm / input.widthMm) * canvas.width,
          (c.yMm / input.heightMm) * canvas.height,
          (c.widthMm / input.widthMm) * canvas.width,
          (c.heightMm / input.heightMm) * canvas.height
        );
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#992200";
        ctx.fillText(
          f.stableFieldId,
          (c.xMm / input.widthMm) * canvas.width,
          (c.yMm / input.heightMm) * canvas.height - 3
        );
      }
    if (input.crop) {
      const c = input.crop,
        out = document.createElement("canvas");
      out.width = Math.ceil(canvas.width * c.width);
      out.height = Math.ceil(canvas.height * c.height);
      out
        .getContext("2d")!
        .drawImage(
          canvas,
          canvas.width * c.x,
          canvas.height * c.y,
          out.width,
          out.height,
          0,
          0,
          out.width,
          out.height
        );
      return {
        base64: out.toDataURL("image/png").split(",")[1],
        text,
        pageCount,
        width: out.width,
        height: out.height,
      };
    }
    return {
      base64: canvas.toDataURL("image/png").split(",")[1],
      text,
      pageCount,
      width: canvas.width,
      height: canvas.height,
    };
  },
};
