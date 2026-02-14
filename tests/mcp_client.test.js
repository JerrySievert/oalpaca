import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK modules before importing McpClientManager.
// vi.fn() with a function body that returns an object works as a constructor.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function () {
    return {};
  })
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function () {
    return {};
  })
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return {};
  })
}));

import { McpClientManager } from '../src/mcp_client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function make_mock_client(tools = []) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'result' }]
    }),
    close: vi.fn().mockResolvedValue(undefined)
  };
}

describe('McpClientManager', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to constructable implementations after clearAllMocks wipes them
    Client.mockImplementation(function () {
      return make_mock_client();
    });
    StdioClientTransport.mockImplementation(function () {
      return {};
    });
    StreamableHTTPClientTransport.mockImplementation(function () {
      return {};
    });
    manager = new McpClientManager();
  });

  describe('constructor', () => {
    it('initializes with empty maps', () => {
      expect(manager.clients.size).toBe(0);
      expect(manager.tools.size).toBe(0);
      expect(manager.tool_to_server.size).toBe(0);
    });
  });

  describe('connect_server', () => {
    it('connects to a stdio server and fetches tools', async () => {
      const mock_client = make_mock_client([
        { name: 'get_weather', description: 'Get weather', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'weather',
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      });

      expect(manager.clients.has('weather')).toBe(true);
      expect(mock_client.connect).toHaveBeenCalled();
      expect(mock_client.listTools).toHaveBeenCalled();
      expect(manager.tools.has('get_weather')).toBe(true);
    });

    it('connects to an HTTP server', async () => {
      const mock_client = make_mock_client([]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'api',
        transport: 'http',
        url: 'http://localhost:3000'
      });

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      expect(manager.clients.has('api')).toBe(true);
    });

    it('registers tools with both simple and qualified names', async () => {
      const mock_client = make_mock_client([
        { name: 'search', description: 'Search', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'myserver',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      // Both simple and qualified names should work
      expect(manager.tools.has('search')).toBe(true);
      expect(manager.tools.has('myserver__search')).toBe(true);
      expect(manager.tool_to_server.get('search')).toBe('myserver');
      expect(manager.tool_to_server.get('myserver__search')).toBe('myserver');
    });

    it('does not overwrite simple name on conflict', async () => {
      // First server registers "search"
      const mock_client_1 = make_mock_client([
        { name: 'search', description: 'Server1 search', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client_1;
      });

      await manager.connect_server({
        name: 'server1',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      // Second server also has "search"
      const mock_client_2 = make_mock_client([
        { name: 'search', description: 'Server2 search', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client_2;
      });

      await manager.connect_server({
        name: 'server2',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      // Simple name should still point to first server
      expect(manager.tool_to_server.get('search')).toBe('server1');
      // Qualified name should point to second server
      expect(manager.tool_to_server.get('server2__search')).toBe('server2');
    });
  });

  describe('connect_all', () => {
    it('connects to all provided server configs', async () => {
      const mock_client = make_mock_client([]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_all([
        { name: 's1', transport: 'stdio', command: 'node', args: [] },
        { name: 's2', transport: 'stdio', command: 'node', args: [] }
      ]);

      expect(manager.clients.size).toBe(2);
    });

    it('continues connecting other servers if one fails', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let call_count = 0;
      Client.mockImplementation(function () {
        call_count++;
        if (call_count === 1) {
          return {
            connect: vi.fn().mockRejectedValue(new Error('connection refused')),
            listTools: vi.fn(),
            close: vi.fn()
          };
        }
        return make_mock_client([]);
      });

      await manager.connect_all([
        { name: 'broken', transport: 'stdio', command: 'bad', args: [] },
        { name: 'good', transport: 'stdio', command: 'node', args: [] }
      ]);

      expect(manager.clients.has('good')).toBe(true);
      expect(manager.clients.has('broken')).toBe(false);
      error_spy.mockRestore();
    });
  });

  describe('get_all_tools', () => {
    it('returns empty array when no tools', () => {
      expect(manager.get_all_tools()).toEqual([]);
    });

    it('returns unique tools preferring simple names', async () => {
      const mock_client = make_mock_client([
        { name: 'tool_a', description: 'A', inputSchema: {} },
        { name: 'tool_b', description: 'B', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      const tools = manager.get_all_tools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('tool_a');
      expect(names).toContain('tool_b');
    });
  });

  describe('call_tool', () => {
    beforeEach(async () => {
      const mock_client = make_mock_client([
        { name: 'my_tool', description: 'Test', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        args: []
      });
    });

    it('calls a tool and returns text content', async () => {
      const result = await manager.call_tool('my_tool', { arg: 'value' });
      expect(result).toBe('result');
    });

    it('throws for unknown tool', async () => {
      await expect(manager.call_tool('nonexistent', {})).rejects.toThrow(
        'Unknown tool: nonexistent'
      );
    });

    it('returns full result when no text content', async () => {
      const client_info = manager.clients.get('srv');
      client_info.client.callTool.mockResolvedValue({
        content: [{ type: 'image', data: 'base64...' }]
      });

      const result = await manager.call_tool('my_tool', {});
      expect(result).toEqual({
        content: [{ type: 'image', data: 'base64...' }]
      });
    });

    it('throws when server is disconnected but tool is mapped', async () => {
      // Simulate a state where tool_to_server has a mapping but the client is gone
      manager.clients.delete('srv');
      await expect(manager.call_tool('my_tool', {})).rejects.toThrow(
        'Server not connected'
      );
    });

    it('wraps callTool errors', async () => {
      const client_info = manager.clients.get('srv');
      client_info.client.callTool.mockRejectedValue(new Error('timeout'));

      await expect(manager.call_tool('my_tool', {})).rejects.toThrow(
        'Tool call failed: timeout'
      );
    });
  });

  describe('disconnect_all', () => {
    it('closes all clients and clears maps', async () => {
      const mock_client = make_mock_client([
        { name: 'tool', description: 'T', inputSchema: {} }
      ]);
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      await manager.disconnect_all();

      expect(mock_client.close).toHaveBeenCalled();
      expect(manager.clients.size).toBe(0);
      expect(manager.tools.size).toBe(0);
      expect(manager.tool_to_server.size).toBe(0);
    });

    it('handles close errors gracefully', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mock_client = make_mock_client([]);
      mock_client.close.mockRejectedValue(new Error('close failed'));
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      // Should not throw
      await manager.disconnect_all();

      expect(manager.clients.size).toBe(0);
      error_spy.mockRestore();
    });
  });

  describe('fetch_tools', () => {
    it('handles listTools error gracefully', async () => {
      const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mock_client = {
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockRejectedValue(new Error('not supported')),
        close: vi.fn()
      };
      Client.mockImplementation(function () {
        return mock_client;
      });

      await manager.connect_server({
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        args: []
      });

      // Server should still be connected, just no tools
      expect(manager.clients.has('srv')).toBe(true);
      expect(manager.tools.size).toBe(0);

      error_spy.mockRestore();
    });
  });
});
