import { appRouter } from "../routers";
import { LOCAL_OWNER_ID } from "../formdigital/localOnly";
import { recordHash } from "../formdigital/editGuard";
export const owner = LOCAL_OWNER_ID;
// Only the MCP catalog calls this helper. Authentication occurs at the transport.
const caller = appRouter.createCaller({
  user: {
    id: owner,
    openId: "local:owner",
    googleUserId: null,
    name: "Local MCP",
    email: null,
    avatarUrl: null,
    loginMethod: "local",
    role: "user",
  },
  req: {} as any,
  res: {} as any,
});
export async function callService(name: string, input?: unknown): Promise<any> {
  let method: any = caller.formdigital;
  for (const part of name.split(".")) method = method[part];
  return method(input);
}
export function withRevisions(result: any): any {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result)) return result.map(withRevisions);
  const value: any = Object.fromEntries(
    Object.entries(result).map(([key, item]) => [key, withRevisions(item)])
  );
  if (typeof result.id === "string") value.revision = recordHash(result);
  return value;
}
export function serviceSchema(name: string): any {
  return (appRouter._def.procedures as any)[`formdigital.${name}`]._def
    .inputs[0];
}
