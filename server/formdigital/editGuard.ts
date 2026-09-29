import { AsyncLocalStorage } from "node:async_hooks";
import { sha256 } from "./domain";

export type EditExpectation = { collection: string; id: string; hash: string };
export const editContext = new AsyncLocalStorage<EditExpectation[]>();
export function recordHash(record: unknown) {
  return sha256(JSON.stringify(record));
}
export function assertExpectedRecord(collection: string, record: any) {
  for (const expected of editContext.getStore() ?? []) {
    if (
      expected.collection === collection &&
      expected.id === record?.id &&
      recordHash(record) !== expected.hash
    )
      throw new Error(
        "EDIT_CONFLICT: The item changed. Read it again before editing."
      );
  }
}
export function assertExpectedWorkspace(workspace: any) {
  for (const expected of editContext.getStore() ?? []) {
    const record = workspace[expected.collection]?.find(
      (r: any) => r.id === expected.id
    );
    if (!record || recordHash(record) !== expected.hash)
      throw new Error(
        "EDIT_CONFLICT: The item changed. Read it again before editing."
      );
  }
}
