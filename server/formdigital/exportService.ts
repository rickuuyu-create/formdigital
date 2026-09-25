import { Buffer } from "node:buffer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getOwnedAssetBytes, storeOwnedAsset } from "./assetStore";
import { getInstanceForOwner, recordInstanceOutput } from "./repository";
import { renderInstancePdf, type PdfOutputMode } from "./pdfRenderer";
import { resolveEffectiveTableGrid, type TableRoleDefinition } from "../../shared/tableFormula";
import { validateFieldValues } from "../../shared/fieldValidation";

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "formdigital";
}

function csvCell(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatExportFieldValue(
  rawValue: string,
  fieldType: string,
  definition: Record<string, unknown>
): string {
  if (fieldType === "table") {
    return resolveEffectiveTableGrid(definition as TableRoleDefinition, rawValue).effectiveJson;
  }
  return rawValue;
}

export async function exportStructuredInstance(
  ownerId: string | number,
  instanceId: string,
  format: "json" | "csv"
) {
  const { instance, template, version, fields } = await getInstanceForOwner(
    ownerId,
    instanceId
  );
  const validationIssues = validateFieldValues(instance.values, fields);
  if (validationIssues.some(issue => issue.blocking)) {
    throw new Error(`Instance 尚有 ${validationIssues.filter(issue => issue.blocking).length} 項驗證錯誤，修正後才可匯出。`);
  }
  const metadata = {
    schemaVersion: 1,
    template: {
      id: template.id,
      name: template.name,
      versionId: version.id,
      versionNumber: version.versionNumber,
      versionHash: version.contentHash,
    },
    instance: {
      id: instance.id,
      name: instance.name,
      status: instance.status,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      printCount: instance.printCount,
      outputHistory: instance.outputHistory,
    },
    fields: fields.map(field => {
      const definition =
        field.definition &&
        typeof field.definition === "object" &&
        !Array.isArray(field.definition)
          ? (field.definition as Record<string, unknown>)
          : {};
      return {
        id: field.stableFieldId,
        label: String(definition.label || field.stableFieldId),
        type: field.fieldType,
        value: formatExportFieldValue(instance.values[field.stableFieldId] ?? "", field.fieldType, definition),
      };
    }),
  };
  const text =
    format === "json"
      ? JSON.stringify(metadata, null, 2)
      : `\uFEFF${["templateId", "templateName", "templateVersionId", "templateVersionNumber", "instanceId", "instanceName", "instanceStatus", "instanceCreatedAt", "instanceUpdatedAt", "fieldId", "fieldLabel", "fieldType", "fieldValue"].map(csvCell).join(",")}\r\n${metadata.fields.map(field => [template.id, template.name, version.id, version.versionNumber, instance.id, instance.name, instance.status, new Date(instance.createdAt).toISOString(), new Date(instance.updatedAt).toISOString(), field.id, field.label, field.type, field.value].map(csvCell).join(",")).join("\r\n")}`;
  const mimeType = format === "json" ? "application/json" : "text/csv";
  const stored = await storeOwnedAsset(ownerId, {
    bytes: Buffer.from(text, "utf8"),
    kind: "export",
    mimeType,
    originalFilename: `${safeFilename(instance.name)}.${format}`,
    instanceId: instance.id,
    templateVersionId: version.id,
    metadata: {
      format,
      instanceId: instance.id,
      templateVersionHash: version.contentHash,
    },
  });
  await recordInstanceOutput(
    ownerId,
    instance.id,
    {
      assetId: stored.asset.id,
      format,
      createdAt: Date.now(),
      templateVersionHash: version.contentHash,
    },
    false
  );
  return {
    assetId: stored.asset.id,
    url: stored.url,
    filename: stored.asset.originalFilename,
    format,
  };
}

export async function createBatchPdf(
  ownerId: string | number,
  input: {
    instanceIds: string[];
    mode: PdfOutputMode;
    copies: number;
    separatorPage: boolean;
    titlePage: boolean;
    pageNumbers?: number[];
    itemOptions?: Record<string, { copies?: number; pageNumbers?: number[] }>;
  }
) {
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  for (
    let itemIndex = 0;
    itemIndex < input.instanceIds.length;
    itemIndex += 1
  ) {
    const instanceId = input.instanceIds[itemIndex]!;
    const details = await getInstanceForOwner(ownerId, instanceId);
    const rendered = await renderInstancePdf(ownerId, instanceId, input.mode);
    const sourceAsset = await getOwnedAssetBytes(ownerId, rendered.assetId);
    const sourcePdf = await PDFDocument.load(sourceAsset.bytes);
    const allIndices = sourcePdf.getPageIndices();
    const itemPageNumbers =
      input.itemOptions?.[instanceId]?.pageNumbers ?? input.pageNumbers;
    const itemCopies = input.itemOptions?.[instanceId]?.copies ?? input.copies;
    const selectedIndices = itemPageNumbers?.length
      ? allIndices.filter(index => itemPageNumbers.includes(index + 1))
      : allIndices;
    if (!selectedIndices.length)
      throw new Error(
        `Instance「${details.instance.name}」沒有符合指定頁碼的頁面。`
      );
    for (let copy = 0; copy < itemCopies; copy += 1) {
      if (input.titlePage) {
        const title = output.addPage();
        title.drawText(
          `Formdigital document ${itemIndex + 1} / copy ${copy + 1}`,
          {
            x: 56,
            y: title.getHeight() - 90,
            size: 18,
            font,
            color: rgb(0.08, 0.16, 0.24),
          }
        );
        title.drawText(`Instance ID: ${details.instance.id}`, {
          x: 56,
          y: title.getHeight() - 124,
          size: 10,
          font,
          color: rgb(0.3, 0.36, 0.42),
        });
      }
      const pages = await output.copyPages(sourcePdf, selectedIndices);
      pages.forEach(page => output.addPage(page));
      if (
        input.separatorPage &&
        !(itemIndex === input.instanceIds.length - 1 && copy === itemCopies - 1)
      )
        output.addPage();
    }
  }
  const bytes = await output.save();
  const stored = await storeOwnedAsset(ownerId, {
    bytes,
    kind: "export",
    mimeType: "application/pdf",
    originalFilename: `Formdigital-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`,
    metadata: { format: "batch-pdf", ...input },
  });
  for (const instanceId of input.instanceIds)
    await recordInstanceOutput(
      ownerId,
      instanceId,
      {
        assetId: stored.asset.id,
        format: "batch-pdf",
        mode: input.mode,
        createdAt: Date.now(),
      },
      false
    );
  return {
    assetId: stored.asset.id,
    url: stored.url,
    filename: stored.asset.originalFilename,
    instances: input.instanceIds.length,
    pages: output.getPageCount(),
  };
}
