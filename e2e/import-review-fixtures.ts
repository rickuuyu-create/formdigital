import { zipSync, strToU8, zlibSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Uint8Array) {
  const type = Buffer.from(name); const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); type.copy(result, 4); Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, Buffer.from(data)])), data.length + 8); return result;
}
export function receiptPng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(32 * (1 + 32 * 3));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const p = y * 97 + 1 + x * 3; raw[p] = 220; raw[p+1] = 30; raw[p+2] = 60;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())]);
}

/** Real OOXML archive with hard page breaks and a visible embedded image on page 3. */
export function threePageDocx() {
  const text = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
  const br = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const picture = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1828800" cy="1828800"/><wp:docPr id="1" name="Synthetic receipt"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="receipt.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<w:document ${namespaces}><w:body>${text("FORM ONE")}${br}${text("FORM TWO")}${br}${text("ATTACHED RECEIPT")}${picture}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/receipt.png"/></Relationships>'),
    "word/media/receipt.png": receiptPng(),
  }));
}

export async function nativeReviewPdf(withGrid = false) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([720, 540]); page.drawText(`REVIEW PAGE ${i+1}`, { x: 40, y: 500, font, size: 14 });
    doc.getForm().createTextField(`Field-${i+1}`).addToPage(page, { x: 150, y: 440, width: 220, height: 24, font });
    if (withGrid && i === 0) {
      const xs = [60, 180, ...Array.from({ length: 11 }, (_, k) => 220 + k * 40)];
      const ys = [400, 370, 335, 295, 250, 200, 145];
      for (const x of xs) page.drawLine({ start: { x, y: 145 }, end: { x, y: 400 }, thickness: 1, color: rgb(0,0,0) });
      for (const y of ys) page.drawLine({ start: { x: 60, y }, end: { x: 620, y }, thickness: 1, color: rgb(0,0,0) });
    }
  }
  return Buffer.from(await doc.save());
}
