import type { OpenClawPluginApi, OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk/feishu";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/feishu";

interface MCPServerConfig {
  name: string;
  type: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface MCPConnectorConfig {
  servers: MCPServerConfig[];
}

interface MCPClient {
  name: string;
  config: MCPServerConfig;
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<string[]>;
}

// Parse SSE response format
function parseSSEResponse(text: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^data:\s*(\{.+\})\s*$/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // Invalid JSON
      }
    }
  }
  return null;
}

// MCP client class - each instance manages its own session
class StreamableHttpMCPClient implements MCPClient {
  name: string;
  config: MCPServerConfig;
  private baseUrl: string;
  private headers: Record<string, string>;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(name: string, config: MCPServerConfig) {
    this.name = name;
    this.config = config;
    this.baseUrl = config.url || "";
    this.headers = config.headers || {};
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...this.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
              prompts: { listChanged: true }
            },
            clientInfo: { name: "openclaw-mcp-connector", version: "1.0" }
          },
        }),
      });

      this.sessionId = response.headers.get("mcp-session-id");
      const text = await response.text();
      const data = parseSSEResponse(text);

      if (data && (data as any).error) {
        throw new Error(`MCP initialize failed: ${JSON.stringify((data as any).error)}`);
      }

      // Send initialized notification (required by MCP protocol)
      await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...this.headers,
          "mcp-session-id": this.sessionId || "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        }),
      });

      this.initialized = true;
      console.log(`[MCP] Initialized ${this.name}, session: ${this.sessionId}`);
    } catch (error) {
      console.error(`[MCP] Failed to initialize ${this.name}:`, error);
      throw error;
    }
  }

  private async mcpRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureInitialized();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    const text = await response.text();
    const data = parseSSEResponse(text);

    if (!data) {
      throw new Error(`Invalid SSE response: ${text}`);
    }

    if ((data as any).error) {
      throw new Error(`MCP error: ${JSON.stringify((data as any).error)}`);
    }

    return data as Record<string, unknown>;
  }

  async listTools(): Promise<string[]> {
    try {
      const data = await this.mcpRequest("tools/list", {});
      const result = (data as any).result;
      return result?.tools?.map((t: { name: string }) => t.name) || [];
    } catch (error) {
      console.error(`[MCP] Failed to list tools for ${this.name}:`, error);
      return [];
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const data = await this.mcpRequest("tools/call", {
        name: toolName,
        arguments: args,
      });
      return (data as any).result;
    } catch (error) {
      console.error(`[MCP] Failed to call tool ${toolName}:`, error);
      throw error;
    }
  }
}

function loadConfig(): MCPConnectorConfig {
  const defaultConfig: MCPConnectorConfig = { servers: [] };

  try {
    const fs = require("fs");
    const configPath = process.env.HOME + "/.openclaw/mcp-servers.json";
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error("[MCP Connector] Failed to load config:", error);
  }

  return defaultConfig;
}

const plugin = {
  id: "mcp-connector",
  name: "MCP Connector",
  description: "Connect to external MCP (Model Context Protocol) servers",
  configSchema: emptyPluginConfigSchema(),

  // Store clients in module scope
  clients: new Map<string, MCPClient>(),

  register(api: OpenClawPluginApi) {
    const config = loadConfig();
    const clientMap = plugin.clients;

    // Clear existing and reinitialize
    clientMap.clear();

    for (const server of config.servers || []) {
      if (server.type === "streamable-http") {
        const client = new StreamableHttpMCPClient(server.name, server);
        clientMap.set(server.name, client);
        console.log(`[MCP Connector] Initialized client: ${server.name} -> ${server.url}`);
      }
    }

    api.logger.info?.(`[MCP Connector] Registered ${clientMap.size} MCP clients`);

    // List all MCP servers
    api.registerTool((ctx: OpenClawPluginToolContext) => {
      return {
        name: "mcp_list_servers",
        description: "List all connected MCP servers and their status",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
        async execute(_toolCallId, _params) {
          const servers = Array.from(clientMap.entries()).map(([name, client]) => ({
            name,
            type: client.config.type,
            url: client.config.url || client.config.command,
          }));
          return { servers };
        },
      } as AnyAgentTool;
    });

    // Register tool for each MCP server
    for (const [serverName, client] of clientMap) {
      // List tools from this server
      api.registerTool((ctx: OpenClawPluginToolContext) => {
        return {
          name: `mcp_${serverName}_list_tools`,
          description: `List all available tools from MCP server "${serverName}"`,
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          async execute(_toolCallId, _params) {
            try {
              const toolsList = await client.listTools();
              return { success: true, server: serverName, tools: toolsList };
            } catch (error) {
              return { success: false, error: String(error) };
            }
          },
        } as AnyAgentTool;
      });

      // Call a tool on this server - capture client reference
      const mcpClient = client;
      api.registerTool((ctx: OpenClawPluginToolContext) => {
        return {
          name: `mcp_${serverName}_call`,
          description: `Call a tool on MCP server "${serverName}". Use mcp_${serverName}_list_tools first to see available tools.`,
          parameters: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Name of the tool to call" },
              args: { type: "object", description: "Arguments to pass to the tool" },
            },
            required: ["tool"],
          },
          async execute(_toolCallId, params) {
            const toolName = (params as any).tool as string;
            const toolArgs = (params as any).args || {};
            try {
              const result = await mcpClient.callTool(toolName, toolArgs);
              return { success: true, result };
            } catch (error) {
              return { success: false, error: String(error) };
            }
          },
        } as AnyAgentTool;
      });

      api.logger.info?.(`[MCP Connector] Registered tools for server: ${serverName}`);
    }
  },
};

export default plugin;