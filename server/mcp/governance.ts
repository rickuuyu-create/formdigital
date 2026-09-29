import { randomUUID } from "node:crypto";
import { changeState, hash, requireClient, type Permission } from "./state";
import { editContext, type EditExpectation } from "../formdigital/editGuard";

let writeTail: Promise<unknown> = Promise.resolve();
export async function governed(input: {
  clientId: string;
  tool: string;
  args: any;
  permission: Permission;
  dangerous?: boolean;
  expected?: EditExpectation[];
  run: (operationId?: string) => Promise<any>;
}) {
  await requireClient(input.clientId, input.permission);
  if (input.permission === "read") return input.run();
  const key = input.args.operationKey;
  if (typeof key !== "string" || key.length < 8 || key.length > 128)
    throw new Error(
      "OPERATION_KEY_REQUIRED: Use a unique key of 8-128 characters; keep it when retrying."
    );
  const execute = async () => {
    await requireClient(input.clientId, input.permission);
    const digest = hash(JSON.stringify({ tool: input.tool, args: input.args }));
    const op = await changeState(s => {
      const prior = s.operations.find(
        o => o.clientId === input.clientId && o.key === key
      );
      if (prior) {
        if (prior.digest !== digest)
          throw new Error("OPERATION_KEY_REUSED_WITH_DIFFERENT_ARGUMENTS");
        return prior;
      }
      if (s.operations.length >= 10000)
        throw new Error(
          "MCP_HISTORY_LIMIT: Archive the MCP history before continuing."
        );
      const next = {
        id: randomUUID(),
        clientId: input.clientId,
        key,
        digest,
        tool: input.tool,
        args: input.args,
        state: input.dangerous ? "awaiting-approval" : "approved",
        at: new Date().toISOString(),
      } as const;
      s.operations.push(next);
      return next;
    });
    if (op.state === "done") return op.result;
    if (op.state === "awaiting-approval")
      return {
        approvalRequired: true,
        operationId: op.id,
        message:
          "Review this exact operation in Form Digital Settings > AI connections, then retry the same call.",
      };
    if (op.state !== "approved")
      throw new Error(`OPERATION_${op.state.toUpperCase()}: ${op.id}`);
    if (input.dangerous && Date.now() - Date.parse(op.at) > 15 * 60_000)
      throw new Error("APPROVAL_EXPIRED");
    await changeState(s => {
      s.operations.find(o => o.id === op.id)!.state = "running";
    });
    try {
      const value = await editContext.run(input.expected ?? [], () =>
        input.run(op.id)
      );
      const result =
        value && typeof value === "object" && !Array.isArray(value)
          ? { ...value, operationId: op.id }
          : { value, operationId: op.id };
      await changeState(s => {
        Object.assign(s.operations.find(o => o.id === op.id)!, {
          state: "done",
          result,
        });
      });
      return result;
    } catch (error: any) {
      // A failed response can follow a committed write: never replay it blindly.
      await changeState(s => {
        Object.assign(s.operations.find(o => o.id === op.id)!, {
          state: "failed",
          error: String(error.message).slice(0, 1000),
        });
      });
      throw error;
    }
  };
  const task = writeTail.then(execute);
  writeTail = task.catch(() => undefined);
  return task;
}
