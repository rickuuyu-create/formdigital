import fs from "node:fs/promises";
import path from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export type Permission = "read" | "write" | "export" | "manage";
export type Client = {
  id: string;
  name: string;
  hash: string;
  permissions: Permission[];
  revoked: boolean;
  createdAt: string;
  lastSeen?: string;
};
export type Operation = {
  id: string;
  clientId: string;
  key: string;
  digest: string;
  tool: string;
  args: any;
  state:
    | "awaiting-approval"
    | "approved"
    | "running"
    | "done"
    | "failed"
    | "uncertain"
    | "denied";
  at: string;
  result?: any;
  error?: string;
  before?: any;
  after?: any;
};
export type Job = {
  id: string;
  clientId: string;
  kind: string;
  status: "queued" | "running" | "review" | "done" | "failed" | "cancelled";
  progress: string;
  result?: any;
  error?: string;
  at: string;
};
export type McpState = {
  schema: 1;
  enabled: boolean;
  roots: string[];
  clients: Client[];
  operations: Operation[];
  jobs: Job[];
};
export const stateRoot = path.join(
  path.dirname(
    process.env.FORMDIGITAL_LOCAL_CONFIG ||
      path.resolve("local-service-config.json")
  ),
  "mcp"
);
const stateFile = path.join(stateRoot, "state.json");
let tail: Promise<unknown> = Promise.resolve();
export async function readState(): Promise<McpState> {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return {
      schema: 1,
      enabled: false,
      roots: [],
      clients: [],
      operations: [],
      jobs: [],
    };
  }
}
export function changeState<T>(
  update: (state: McpState) => T | Promise<T>
): Promise<T> {
  const task = tail.then(async () => {
    const state = await readState();
    const result = await update(state);
    await fs.mkdir(stateRoot, { recursive: true });
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temp, stateFile);
          break;
        } catch (e: any) {
          if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code))
            throw e;
          await new Promise(r => setTimeout(r, 50 + attempt * 20));
        }
      }
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    return result;
  });
  tail = task.catch(() => undefined);
  return task;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function authenticate(token: string): Promise<Client> {
  const state = await readState();
  if (!state.enabled) throw new Error("MCP_DISABLED");
  const digest = Buffer.from(hash(token));
  const client = state.clients.find(
    c =>
      !c.revoked &&
      c.hash.length === digest.length &&
      timingSafeEqual(Buffer.from(c.hash), digest)
  );
  if (!client) throw new Error("MCP_UNAUTHORIZED");
  return client;
}
export async function requireClient(id: string, permission?: Permission) {
  const state = await readState();
  if (!state.enabled) throw new Error("MCP_DISABLED");
  const client = state.clients.find(c => c.id === id && !c.revoked);
  if (!client || (permission && !client.permissions.includes(permission)))
    throw new Error("MCP_PERMISSION_DENIED");
  return client;
}
export async function createClient(
  name: string,
  permissions: Permission[],
  endpoint: string
) {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex");
  const connection = path.join(stateRoot, "clients", `${id}.json`);
  await changeState(async s => {
    if (s.clients.filter(c => !c.revoked).length >= 20)
      throw new Error("MCP_CLIENT_LIMIT");
    await fs.mkdir(path.dirname(connection), { recursive: true });
    await fs.writeFile(connection, JSON.stringify({ endpoint, token }), {
      mode: 0o600,
      flag: "wx",
    });
    s.clients.push({
      id,
      name,
      hash: hash(token),
      permissions,
      revoked: false,
      createdAt: new Date().toISOString(),
    });
  });
  return { id, connection, token };
}
export async function allowedFile(file: string, write = false) {
  if (!path.isAbsolute(file)) throw new Error("MCP_ABSOLUTE_PATH_REQUIRED");
  const resolved = path.resolve(file);
  if (/^\\\\|^\/\//.test(resolved)) throw new Error("MCP_LOCAL_FILES_ONLY");
  const real = write
    ? path.join(
        await fs.realpath(path.dirname(resolved)),
        path.basename(resolved)
      )
    : await fs.realpath(resolved);
  const privateRelative = path.relative(stateRoot, real);
  if (!privateRelative.startsWith("..") && !path.isAbsolute(privateRelative))
    throw new Error("MCP_PRIVATE_CONFIGURATION");
  for (const root of (await readState()).roots) {
    const canonical = await fs.realpath(root);
    const relative = path.relative(canonical, real);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      // Do not follow a destination symlink or overwrite an existing file.
      if (write) {
        try {
          await fs.lstat(real);
          throw new Error("MCP_FILE_EXISTS");
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      return real;
    }
  }
  throw new Error("MCP_FILE_OUTSIDE_ALLOWED_FOLDERS");
}
export async function recoverInterrupted() {
  await changeState(s => {
    for (const op of s.operations)
      if (op.state === "running") {
        op.state = "uncertain";
        op.error =
          "Interrupted. Inspect the result before submitting a different operation.";
      }
    for (const job of s.jobs)
      if (["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.error =
          "Interrupted. Existing draft and uploaded pages are retained for inspection.";
      }
  });
}
