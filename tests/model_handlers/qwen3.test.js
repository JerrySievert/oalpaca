import { describe, it, expect } from 'vitest';
import {
  format_tools_for_prompt,
  parse_tool_calls,
  has_tool_calls,
  format_tool_result,
  get_text_content,
  build_message
} from '../../src/model_handlers/qwen3.js';

const SAMPLE_TOOL = {
  name: 'get_weather',
  description: 'Get current weather',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  }
};

describe('qwen3 handler', () => {
  describe('format_tools_for_prompt', () => {
    it('returns empty string for empty tools array', () => {
      expect(format_tools_for_prompt([])).toBe('');
    });

    it('returns empty string for null/undefined tools', () => {
      expect(format_tools_for_prompt(null)).toBe('');
      expect(format_tools_for_prompt(undefined)).toBe('');
    });

    it('includes tool name and description', () => {
      const result = format_tools_for_prompt([SAMPLE_TOOL]);
      expect(result).toContain('get_weather');
      expect(result).toContain('Get current weather');
    });

    it('includes multiple tools', () => {
      const tools = [
        SAMPLE_TOOL,
        { name: 'search', description: 'Search the web' }
      ];
      const result = format_tools_for_prompt(tools);
      expect(result).toContain('get_weather');
      expect(result).toContain('search');
    });

    it('uses default inputSchema when missing', () => {
      const tool = { name: 'ping', description: 'Ping' };
      const result = format_tools_for_prompt([tool]);
      expect(result).toContain('ping');
    });
  });

  describe('parse_tool_calls', () => {
    it('returns empty array when no tool_call tags', () => {
      expect(parse_tool_calls('Hello, how are you?')).toEqual([]);
    });

    it('parses a single tool call', () => {
      const output =
        '<tool_call>{"name": "get_weather", "arguments": {"city": "Seattle"}}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('get_weather');
      expect(calls[0].arguments).toEqual({ city: 'Seattle' });
    });

    it('parses multiple tool calls', () => {
      const output =
        '<tool_call>{"name": "a", "arguments": {"x": 1}}</tool_call> text <tool_call>{"name": "b", "arguments": {"y": 2}}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe('a');
      expect(calls[1].name).toBe('b');
    });

    it('defaults missing arguments to empty object', () => {
      const output = '<tool_call>{"name": "ping"}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({});
    });

    it('skips malformed JSON without throwing', () => {
      const output = '<tool_call>not valid json</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toEqual([]);
    });

    it('skips entries without a name field', () => {
      const output = '<tool_call>{"arguments": {"x": 1}}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toEqual([]);
    });

    it('handles extra whitespace inside tags', () => {
      const output =
        '<tool_call>\n  {"name": "test", "arguments": {}}\n</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('test');
    });
  });

  describe('has_tool_calls', () => {
    it('returns true when <tool_call> tag is present', () => {
      expect(has_tool_calls('Some text <tool_call>...</tool_call>')).toBe(true);
    });

    it('returns false when no tool_call tag', () => {
      expect(has_tool_calls('Just a normal response')).toBe(false);
    });
  });

  describe('format_tool_result', () => {
    it('wraps string result in tool_response tags', () => {
      const result = format_tool_result('get_weather', 'Sunny, 72F');
      expect(result).toContain('<tool_response>');
      expect(result).toContain('</tool_response>');
      expect(result).toContain('get_weather');
      expect(result).toContain('Sunny, 72F');
    });

    it('stringifies object results', () => {
      const result = format_tool_result('search', { results: [1, 2] });
      expect(result).toContain('search');
      // The result is JSON-stringified then wrapped in JSON, so keys are escaped
      expect(result).toContain('results');
    });
  });

  describe('get_text_content', () => {
    it('strips tool_call tags and returns surrounding text', () => {
      const output = 'Hello <tool_call>{"name":"x"}</tool_call> world';
      expect(get_text_content(output)).toBe('Hello  world');
    });

    it('returns empty string when only tool calls', () => {
      const output = '<tool_call>{"name":"x"}</tool_call>';
      expect(get_text_content(output)).toBe('');
    });

    it('returns full text when no tool calls', () => {
      expect(get_text_content('Just text')).toBe('Just text');
    });
  });

  describe('build_message', () => {
    it('returns role and content object', () => {
      expect(build_message('user', 'hi')).toEqual({
        role: 'user',
        content: 'hi'
      });
    });
  });
});
