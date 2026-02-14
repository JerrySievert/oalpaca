import { describe, it, expect } from 'vitest';
import {
  format_tools_for_prompt,
  parse_tool_calls,
  has_tool_calls,
  format_tool_result,
  get_text_content,
  build_message
} from '../../src/model_handlers/granite.js';

describe('granite handler', () => {
  describe('format_tools_for_prompt', () => {
    it('returns empty string for empty tools array', () => {
      expect(format_tools_for_prompt([])).toBe('');
    });

    it('returns empty string for null/undefined', () => {
      expect(format_tools_for_prompt(null)).toBe('');
      expect(format_tools_for_prompt(undefined)).toBe('');
    });

    it('includes tool name and description', () => {
      const tool = {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' }
      };
      const result = format_tools_for_prompt([tool]);
      expect(result).toContain('search');
      expect(result).toContain('Search');
    });
  });

  describe('parse_tool_calls', () => {
    it('returns empty array when no tags', () => {
      expect(parse_tool_calls('Hello world')).toEqual([]);
    });

    it('parses single object format (like qwen3)', () => {
      const output =
        '<tool_call>{"name": "get_weather", "arguments": {"city": "NYC"}}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('get_weather');
      expect(calls[0].arguments).toEqual({ city: 'NYC' });
    });

    it('parses array format with multiple calls', () => {
      const output =
        '<tool_call>[{"name": "a", "arguments": {"x": 1}}, {"name": "b", "arguments": {"y": 2}}]</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe('a');
      expect(calls[0].arguments).toEqual({ x: 1 });
      expect(calls[1].name).toBe('b');
      expect(calls[1].arguments).toEqual({ y: 2 });
    });

    it('skips array entries without name field', () => {
      const output =
        '<tool_call>[{"name": "a", "arguments": {}}, {"arguments": {"y": 2}}]</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('a');
    });

    it('handles empty array', () => {
      const output = '<tool_call>[]</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toEqual([]);
    });

    it('defaults missing arguments to empty object', () => {
      const output = '<tool_call>{"name": "ping"}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({});
    });

    it('skips malformed JSON without throwing', () => {
      const output = '<tool_call>broken json</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toEqual([]);
    });

    it('parses multiple separate tool_call tags', () => {
      const output =
        '<tool_call>{"name": "a"}</tool_call><tool_call>{"name": "b"}</tool_call>';
      const calls = parse_tool_calls(output);
      expect(calls).toHaveLength(2);
    });
  });

  describe('has_tool_calls', () => {
    it('returns true when <tool_call> tag is present', () => {
      expect(has_tool_calls('Text <tool_call>...</tool_call>')).toBe(true);
    });

    it('returns false when no tag present', () => {
      expect(has_tool_calls('Just text')).toBe(false);
    });
  });

  describe('format_tool_result', () => {
    it('wraps string result in tool_response tags', () => {
      const result = format_tool_result('search', 'results here');
      expect(result).toContain('<tool_response>');
      expect(result).toContain('</tool_response>');
      expect(result).toContain('search');
    });

    it('stringifies object results', () => {
      const result = format_tool_result('api', { data: [1, 2] });
      expect(result).toContain('data');
    });
  });

  describe('get_text_content', () => {
    it('strips tool_call tags', () => {
      const output = 'Hello <tool_call>{"name":"x"}</tool_call> world';
      expect(get_text_content(output)).toBe('Hello  world');
    });

    it('returns empty string when only tool calls', () => {
      expect(get_text_content('<tool_call>{"name":"x"}</tool_call>')).toBe('');
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
