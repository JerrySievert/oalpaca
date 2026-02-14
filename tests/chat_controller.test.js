import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-llama-cpp
vi.mock('node-llama-cpp', () => ({
  LlamaChatSession: vi.fn()
}));

import { ChatController } from '../src/chat_controller.js';
import { LlamaChatSession } from 'node-llama-cpp';

function make_handler({ has_tools = false, tool_calls = [] } = {}) {
  return {
    format_tools_for_prompt: vi
      .fn()
      .mockReturnValue(has_tools ? '\n<tools>...</tools>' : ''),
    has_tool_calls: vi.fn().mockReturnValue(tool_calls.length > 0),
    parse_tool_calls: vi.fn().mockReturnValue(tool_calls),
    get_text_content: vi.fn().mockReturnValue(''),
    format_tool_result: vi.fn((name, result) => `<result>${result}</result>`)
  };
}

function make_mcp_manager(tools = []) {
  return {
    get_all_tools: vi.fn().mockReturnValue(tools),
    call_tool: vi.fn().mockResolvedValue('tool result')
  };
}

describe('ChatController', () => {
  let controller;
  let mock_session;
  let mock_mcp;
  let mock_handler;

  beforeEach(() => {
    vi.clearAllMocks();

    mock_session = {
      prompt: vi.fn().mockResolvedValue('Hello! How can I help?'),
      getChatHistory: vi.fn().mockReturnValue([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello!' }
      ])
    };

    LlamaChatSession.mockImplementation(function () {
      return mock_session;
    });

    mock_handler = make_handler();
    mock_mcp = make_mcp_manager();

    controller = new ChatController({
      llama: {},
      model: {},
      context: {
        getSequence: vi.fn().mockReturnValue({})
      },
      model_type: 'qwen3',
      mcp_manager: mock_mcp,
      system_prompt: 'You are helpful.'
    });

    // Override handler with our mock
    controller.handler = mock_handler;
  });

  describe('constructor', () => {
    it('stores provided options', () => {
      expect(controller.model_type).toBe('qwen3');
      expect(controller.system_prompt).toBe('You are helpful.');
      expect(controller.messages).toEqual([]);
    });

    it('defaults system_prompt to empty string', () => {
      const ctrl = new ChatController({
        llama: {},
        model: {},
        context: { getSequence: vi.fn().mockReturnValue({}) },
        model_type: 'qwen3',
        mcp_manager: mock_mcp
      });
      expect(ctrl.system_prompt).toBe('');
    });
  });

  describe('initialize', () => {
    it('creates a LlamaChatSession', async () => {
      await controller.initialize();
      expect(LlamaChatSession).toHaveBeenCalled();
      expect(controller.session).toBeDefined();
    });

    it('includes tools in system prompt when available', async () => {
      mock_mcp.get_all_tools.mockReturnValue([
        { name: 'search', description: 'Search', inputSchema: {} }
      ]);
      mock_handler.format_tools_for_prompt.mockReturnValue(
        '\n<tools>[search]</tools>'
      );

      await controller.initialize();

      const session_args = LlamaChatSession.mock.calls[0][0];
      expect(session_args.systemPrompt).toContain('You are helpful.');
      expect(session_args.systemPrompt).toContain('<tools>');
    });
  });

  describe('chat', () => {
    beforeEach(async () => {
      await controller.initialize();
    });

    it('sends user message and returns response', async () => {
      const response = await controller.chat('Hello');
      expect(mock_session.prompt).toHaveBeenCalledWith('Hello');
      expect(response).toBe('Hello! How can I help?');
    });

    it('handles tool calls and re-prompts with results', async () => {
      let call_count = 0;

      // First call: model returns tool call
      // Second call: model returns final response
      mock_session.prompt = vi.fn().mockImplementation(async () => {
        call_count++;
        if (call_count === 1)
          return '<tool_call>{"name":"search","arguments":{"q":"test"}}</tool_call>';
        return 'Here are the search results.';
      });

      mock_handler.has_tool_calls = vi.fn().mockImplementation((text) => {
        return text.includes('<tool_call>');
      });
      mock_handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'search', arguments: { q: 'test' } }]);

      const response = await controller.chat('Search for test');

      expect(mock_mcp.call_tool).toHaveBeenCalledWith('search', { q: 'test' });
      expect(response).toBe('Here are the search results.');
      expect(mock_session.prompt).toHaveBeenCalledTimes(2);
    });

    it('handles tool call errors gracefully', async () => {
      let call_count = 0;
      mock_session.prompt = vi.fn().mockImplementation(async () => {
        call_count++;
        if (call_count === 1) return '<tool_call>bad</tool_call>';
        return 'Sorry, there was an error.';
      });

      mock_handler.has_tool_calls = vi
        .fn()
        .mockImplementation((text) => text.includes('<tool_call>'));
      mock_handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'broken', arguments: {} }]);
      mock_mcp.call_tool = vi.fn().mockRejectedValue(new Error('tool error'));

      const response = await controller.chat('Do something');
      expect(response).toBe('Sorry, there was an error.');
    });

    it('stops when parse_tool_calls returns empty', async () => {
      mock_session.prompt = vi
        .fn()
        .mockResolvedValue('response with <tool_call> tags');

      mock_handler.has_tool_calls = vi.fn().mockReturnValue(true);
      mock_handler.parse_tool_calls = vi.fn().mockReturnValue([]);

      const response = await controller.chat('test');
      // Should return the response as-is since no tool calls parsed
      expect(response).toBe('response with <tool_call> tags');
      expect(mock_session.prompt).toHaveBeenCalledTimes(1);
    });

    it('stops after MAX_TOOL_ITERATIONS and logs warning', async () => {
      // Always return tool calls — never stops
      mock_session.prompt = vi
        .fn()
        .mockResolvedValue('<tool_call>loop</tool_call>');
      mock_handler.has_tool_calls = vi.fn().mockReturnValue(true);
      mock_handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'loop_tool', arguments: {} }]);

      const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = await controller.chat('loop test');

      // Should have iterated 10 times (MAX_TOOL_ITERATIONS)
      expect(mock_session.prompt).toHaveBeenCalledTimes(10);
      expect(response).toBe('');

      // Should have logged the warning (line 117)
      expect(warn_spy).toHaveBeenCalledWith(
        expect.stringContaining('Maximum tool iterations reached')
      );

      warn_spy.mockRestore();
    });
  });

  describe('get_history', () => {
    it('returns empty array when session not initialized', () => {
      expect(controller.get_history()).toEqual([]);
    });

    it('returns chat history from session', async () => {
      await controller.initialize();
      const history = controller.get_history();
      expect(history).toHaveLength(3);
      expect(history[0].role).toBe('system');
    });
  });
});
