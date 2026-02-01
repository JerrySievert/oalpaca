/**
 * MCP Client Manager
 * Handles connections to MCP servers and tool execution
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Manages multiple MCP server connections
 */
export class McpClientManager {
  constructor() {
    this.clients = new Map();
    this.tools = new Map();
    this.tool_to_server = new Map();
  }

  /**
   * Connect to all configured MCP servers
   * @param {Array} server_configs - Array of server configurations
   */
  async connect_all(server_configs) {
    for (const config of server_configs) {
      try {
        await this.connect_server(config);
      } catch (error) {
        console.error(
          `Failed to connect to MCP server "${config.name}": ${error.message}`
        );
      }
    }
  }

  /**
   * Connect to a single MCP server
   * @param {object} config - Server configuration
   */
  async connect_server(config) {
    const { name, transport: transport_type } = config;

    console.log(`Connecting to MCP server: ${name}...`);

    let transport;

    if (transport_type === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(config.url));
    } else {
      // Default to stdio
      const { command, args = [], cwd, env } = config;
      transport = new StdioClientTransport({
        command,
        args,
        cwd,
        env: { ...process.env, ...env }
      });
    }

    const client = new Client({
      name: 'llama-mcp-host',
      version: '1.0.0'
    });

    await client.connect(transport);

    this.clients.set(name, { client, transport });

    // Fetch and register tools from this server
    await this.fetch_tools(name, client);

    console.log(`Connected to MCP server: ${name}`);
  }

  /**
   * Fetch tools from a connected server
   * @param {string} server_name - Name of the server
   * @param {Client} client - MCP client instance
   */
  async fetch_tools(server_name, client) {
    try {
      const response = await client.listTools();

      for (const tool of response.tools) {
        const qualified_name = `${server_name}__${tool.name}`;
        this.tools.set(qualified_name, tool);
        this.tool_to_server.set(qualified_name, server_name);

        // Also register with simple name if no conflict
        if (!this.tools.has(tool.name)) {
          this.tools.set(tool.name, tool);
          this.tool_to_server.set(tool.name, server_name);
        }
      }

      console.log(
        `  Registered ${response.tools.length} tools from ${server_name}`
      );
    } catch (error) {
      console.error(
        `Failed to fetch tools from ${server_name}:`,
        error.message
      );
    }
  }

  /**
   * Get all available tools
   * @returns {Array} Array of tool definitions
   */
  get_all_tools() {
    const seen = new Set();
    const tools = [];

    for (const [name, tool] of this.tools) {
      // Skip qualified names if simple name exists
      if (name.includes('__')) {
        const simple_name = name.split('__')[1];
        if (this.tools.has(simple_name)) {
          continue;
        }
      }

      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        tools.push(tool);
      }
    }

    return tools;
  }

  /**
   * Call a tool by name
   * @param {string} tool_name - Name of the tool to call
   * @param {object} arguments_ - Arguments to pass to the tool
   * @returns {any} Tool result
   */
  async call_tool(tool_name, arguments_) {
    const server_name = this.tool_to_server.get(tool_name);

    if (!server_name) {
      throw new Error(`Unknown tool: ${tool_name}`);
    }

    const client_info = this.clients.get(server_name);

    if (!client_info) {
      throw new Error(`Server not connected: ${server_name}`);
    }

    // Get the actual tool name (may be qualified)
    const tool = this.tools.get(tool_name);
    const actual_name = tool.name;

    try {
      const result = await client_info.client.callTool({
        name: actual_name,
        arguments: arguments_
      });

      // Extract content from result
      if (result.content && Array.isArray(result.content)) {
        const text_content = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        return text_content || result;
      }

      return result;
    } catch (error) {
      throw new Error(`Tool call failed: ${error.message}`);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnect_all() {
    for (const [name, { client, transport }] of this.clients) {
      try {
        await client.close();
        console.log(`Disconnected from MCP server: ${name}`);
      } catch (error) {
        console.error(`Error disconnecting from ${name}:`, error.message);
      }
    }

    this.clients.clear();
    this.tools.clear();
    this.tool_to_server.clear();
  }
}

export default McpClientManager;
