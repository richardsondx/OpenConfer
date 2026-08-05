#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { OpenConferClient } from "@openconfer/sdk-typescript";

const baseUrl = process.env.OPENCONFER_BASE_URL ?? "http://localhost:8787";
const apiToken = process.env.OPENCONFER_API_TOKEN ?? "";
const client = new OpenConferClient({ baseUrl, apiToken });

const server = new Server(
  { name: "openconfer", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "openconfer.create_session",
      description: "Create a confer session. Returns immediately with session ID — does not wait for human.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["decision", "approval", "briefing", "incident"] },
          objective: { type: "string" },
          brief: { type: "object" },
          result_schema: { type: "object" },
          participant: { type: "object", properties: { operator_id: { type: "string" } } },
          initiator: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              harness: { type: "string" },
              project: { type: "string" },
            },
          },
          callback: { type: "object", properties: { url: { type: "string" } } },
        },
        required: ["objective", "brief", "result_schema", "participant", "initiator"],
      },
    },
    {
      name: "openconfer.get_session",
      description: "Get current session status",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
    {
      name: "openconfer.get_result",
      description: "Get completed session result",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
    {
      name: "openconfer.cancel_session",
      description: "Cancel a pending session",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "openconfer.create_session") {
      const result = await client.createSession(a as never);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "openconfer.get_session") {
      const result = await client.getSession(a.session_id as string);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "openconfer.get_result") {
      const result = await client.getSession(a.session_id as string);
      return { content: [{ type: "text", text: JSON.stringify(result.result ?? result, null, 2) }] };
    }
    if (name === "openconfer.cancel_session") {
      const result = await client.cancelSession(a.session_id as string);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : "Error" }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
