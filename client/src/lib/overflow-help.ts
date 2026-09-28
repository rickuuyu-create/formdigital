import type { FormField } from "./form-model";

/** Both the template author and the person filling it see the actual output
 * policy. Paper capacity is independent of maxLength / input validation. */
export function overflowHelp(field: Pick<FormField, "type" | "overflow">): readonly [string, string] {
  switch (field.overflow) {
    case "shrink": return field.type === "textarea"
      ? ["輸出 PDF 時按英文單字換行，並按需要縮小文字；仍放不下會停止輸出。輸入時的字級不代表輸出字級。", "PDF export wraps at word boundaries and shrinks text as needed. If it still cannot fit, export stops. The editing font size is not the final output size."] as const
      : ["輸出 PDF 時保留單行並縮小文字；手動換行會保留。仍放不下會停止輸出，請縮短內容或加大欄位。輸入時的字級不代表輸出字級。", "PDF export shrinks single-line text without wrapping; manual line breaks are kept. If it still cannot fit, export stops: shorten the text or enlarge the field. The editing font size is not the final output size."] as const;
    case "block": return ["允許輸入及保存；按單字換行後若仍超出紙上欄位容量，會停止 PDF 輸出。限制輸入字數請設定「最大字數」。", "You can enter and save text. PDF export stops if it exceeds the printed field after word wrapping. Set the maximum length to limit typed characters."] as const;
    case "wrap": return ["英文優先按完整單字換行；整行也放不下的長單字或網址才會拆開。欄位高度不足時，超出部分會被裁切，請加高欄位或改用自動縮小。", "English wraps at word boundaries. A word or URL is split only if it is wider than a full line. Text below the field is clipped: increase the height or use automatic shrinking."] as const;
    default: return ["允許輸出並按單字換行；超出欄位底部的文字會被裁切。請檢查匯出的 PDF，或改用自動縮小／超限時停止輸出。", "Export is allowed and text wraps at word boundaries. Text below the field is clipped. Check the exported PDF, or choose automatic shrinking / stop export on overflow."] as const;
  }
}
