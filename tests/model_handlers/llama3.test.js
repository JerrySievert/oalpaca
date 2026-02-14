import { describe, it, expect } from 'vitest';
import {
  format_tools_for_prompt,
  parse_tool_calls,
  has_tool_calls,
  format_tool_result,
  get_text_content,
  build_message
} from '../../src/model_handlers/llama3.js';

describe('llama3 handler', () => {
  describe('format_tools_for_prompt', () => {
    it('returns empty string for empty tools array', () => {
      expect(format_tools_for_prompt([])).toBe('');
    });

    it('returns empty string for null/undefined', () => {
      expect(format_tools_for_prompt(null)).toBe('');
      expect(format_tools_for_prompt(undefined)).toBe('');
    });

    it('includes tool name and format instructions', () => {
      const tool = { name: 'search', description: 'Search the web' };
      const result = format_tools_for_prompt([tool]);
      expect(result).toContain('search');
      expect(result).toContain('[function_name(');
    });
  });

  describe('parse_tool_calls', () => {
    it('returns empty array when no brackets', () => {
      expect(parse_tool_calls('Hello world')).toEqual([]);
    });

    it('parses function with no arguments', () => {
      const calls = parse_tool_calls('[get_time()]');
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('get_time');
      expect(calls[0].arguments).toEqual({});
    });

    it('parses single-quoted string argument', () => {
      const calls = parse_tool_calls("[get_weather(city='Seattle')]");
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ city: 'Seattle' });
    });

    it('parses double-quoted string argument', () => {
      const calls = parse_tool_calls('[get_weather(city="Seattle")]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ city: 'Seattle' });
    });

    it('parses integer argument', () => {
      const calls = parse_tool_calls('[get_player(person_id=123)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ person_id: 123 });
    });

    it('parses float argument', () => {
      const calls = parse_tool_calls('[set_temp(value=98.6)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ value: 98.6 });
    });

    it('parses True as boolean true', () => {
      const calls = parse_tool_calls('[set_flag(active=True)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ active: true });
    });

    it('parses False as boolean false', () => {
      const calls = parse_tool_calls('[set_flag(active=False)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ active: false });
    });

    it('parses None as null', () => {
      const calls = parse_tool_calls('[set_value(val=None)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ val: null });
    });

    it('parses bare identifier as string', () => {
      const calls = parse_tool_calls('[get_status(type=active)]');
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ type: 'active' });
    });

    it('parses multiple arguments', () => {
      const calls = parse_tool_calls("[search(query='test', limit=10)]");
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ query: 'test', limit: 10 });
    });

    it('parses multiple function calls', () => {
      const calls = parse_tool_calls("[get_weather(city='NYC'), get_time()]");
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe('get_weather');
      expect(calls[0].arguments).toEqual({ city: 'NYC' });
      expect(calls[1].name).toBe('get_time');
      expect(calls[1].arguments).toEqual({});
    });

    it('ignores surrounding text', () => {
      const calls = parse_tool_calls("I'll look that up for you. [search(q='test')]");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('search');
    });
  });

  describe('has_tool_calls', () => {
    it('returns true for function call pattern', () => {
      expect(has_tool_calls('[func()]')).toBe(true);
      expect(has_tool_calls("[search(q='test')]")).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(has_tool_calls('Hello world')).toBe(false);
    });

    it('returns false for brackets without function call', () => {
      expect(has_tool_calls('[just text]')).toBe(false);
    });
  });

  describe('format_tool_result', () => {
    it('wraps result with function name', () => {
      const result = format_tool_result('search', 'found 5 results');
      expect(result).toBe('Function search returned: found 5 results');
    });

    it('stringifies object results', () => {
      const result = format_tool_result('api', { status: 200 });
      expect(result).toContain('Function api returned:');
      expect(result).toContain('"status"');
    });
  });

  describe('get_text_content', () => {
    it('strips bracket function calls', () => {
      const output = "Let me check. [search(q='test')] Here are the results.";
      const text = get_text_content(output);
      expect(text).not.toContain('[search');
      expect(text).toContain('Let me check.');
      expect(text).toContain('Here are the results.');
    });

    it('returns full text when no calls present', () => {
      expect(get_text_content('No tools here')).toBe('No tools here');
    });
  });

  describe('build_message', () => {
    it('returns role and content object', () => {
      expect(build_message('assistant', 'hi')).toEqual({ role: 'assistant', content: 'hi' });
    });
  });
});
