import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { AuthenticatedUser } from "../formdigital/googleAuth";
import { authenticateAppRequest } from "../formdigital/localOnly";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthenticatedUser | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  const user = await authenticateAppRequest(opts.req);

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
