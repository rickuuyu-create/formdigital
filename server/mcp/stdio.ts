import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

async function main() {
  const index = process.argv.indexOf("--connection");
  if (index < 0 || !process.argv[index + 1])
    throw new Error(
      "Pass --connection and the private file created in Form Digital Settings."
    );
  const config = JSON.parse(await fs.readFile(process.argv[index + 1], "utf8")),
    url = new URL(config.endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Only a local Form Digital MCP endpoint is allowed.");
  const client = new Client({
    name: "formdigital-stdio",
    version: "2026.09.30.1",
  });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${config.token}` },
        redirect: "error",
      },
    })
  );
  const server = new Server(
    { name: "formdigital", version: "2026.09.30.1" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: client.getInstructions(),
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, r =>
    client.listTools(r.params)
  );
  server.setRequestHandler(CallToolRequestSchema, r =>
    client.callTool(r.params)
  );
  server.setRequestHandler(ListResourcesRequestSchema, r =>
    client.listResources(r.params)
  );
  server.setRequestHandler(ReadResourceRequestSchema, r =>
    client.readResource(r.params)
  );
  server.setRequestHandler(ListPromptsRequestSchema, r =>
    client.listPrompts(r.params)
  );
  server.setRequestHandler(GetPromptRequestSchema, r =>
    client.getPrompt(r.params)
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on("end", () => {
    void client.close();
    void server.close();
  });
}
main().catch(error => {
  console.error(
    `Form Digital MCP: ${error.message}. Open the app and enable MCP in Settings.`
  );
  process.exitCode = 1;
});
