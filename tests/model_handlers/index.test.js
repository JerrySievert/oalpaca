import { describe, it, expect } from 'vitest';
import { get_handler, qwen3_handler, llama3_handler, granite_handler } from '../../src/model_handlers/index.js';

const EXPECTED_METHODS = [
  'format_tools_for_prompt',
  'parse_tool_calls',
  'has_tool_calls',
  'format_tool_result',
  'get_text_content',
  'build_message'
];

describe('handler factory', () => {
  it('returns qwen3 handler', () => {
    const handler = get_handler('qwen3');
    expect(handler).toBe(qwen3_handler);
    for (const method of EXPECTED_METHODS) {
      expect(typeof handler[method]).toBe('function');
    }
  });

  it('returns llama3 handler', () => {
    const handler = get_handler('llama3');
    expect(handler).toBe(llama3_handler);
    for (const method of EXPECTED_METHODS) {
      expect(typeof handler[method]).toBe('function');
    }
  });

  it('returns granite handler', () => {
    const handler = get_handler('granite');
    expect(handler).toBe(granite_handler);
    for (const method of EXPECTED_METHODS) {
      expect(typeof handler[method]).toBe('function');
    }
  });

  it('throws on unknown model type', () => {
    expect(() => get_handler('gpt4')).toThrow(/Unknown model type/);
    expect(() => get_handler('gpt4')).toThrow(/gpt4/);
  });
});
