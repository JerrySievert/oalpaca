import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detect_model_type, load_config } from '../src/config.js';

describe('detect_model_type', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns explicit type when provided', () => {
    expect(detect_model_type('baseball', 'llama3')).toBe('llama3');
  });

  it('explicit type overrides name match', () => {
    expect(detect_model_type('qwen-model', 'granite')).toBe('granite');
  });

  it('detects qwen from name', () => {
    expect(detect_model_type('qwen3:8b')).toBe('qwen3');
  });

  it('detects llama from name', () => {
    expect(detect_model_type('llama3.2:3b')).toBe('llama3');
  });

  it('detects granite from name', () => {
    expect(detect_model_type('granite-3.2-8b')).toBe('granite');
  });

  it('is case insensitive', () => {
    expect(detect_model_type('Qwen3-8B')).toBe('qwen3');
    expect(detect_model_type('LLAMA-3')).toBe('llama3');
  });

  it('defaults to qwen3 for unknown names', () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(detect_model_type('baseball')).toBe('qwen3');
    expect(warn_spy).toHaveBeenCalled();
  });
});

describe('load_config', () => {
  let tmp_dir;

  function make_config(dir, config_obj) {
    const config_path = join(dir, 'config.json');
    writeFileSync(config_path, JSON.stringify(config_obj));
    return config_path;
  }

  beforeEach(() => {
    tmp_dir = mkdtempSync(join(tmpdir(), 'llama-test-'));
  });

  it('loads a valid multi-model config', () => {
    // Create a dummy model file so the path resolves
    const model_file = join(tmp_dir, 'model.gguf');
    writeFileSync(model_file, 'fake');

    const config_path = make_config(tmp_dir, {
      models: {
        test: {
          model_path: './model.gguf',
          context_size: 4096
        }
      }
    });

    const config = load_config(config_path);
    expect(config.models.test).toBeDefined();
    expect(config.models.test.model_path).toBe(model_file);
    expect(config.models.test.context_size).toBe(4096);
  });

  it('applies default values', () => {
    const model_file = join(tmp_dir, 'model.gguf');
    writeFileSync(model_file, 'fake');

    const config_path = make_config(tmp_dir, {
      models: {
        test: { model_path: './model.gguf' }
      }
    });

    const config = load_config(config_path);
    expect(config.models.test.context_size).toBe(8192);
    expect(config.models.test.assistant_name).toBe('Assistant');
    expect(config.models.test.mcp_servers).toEqual([]);
  });

  it('loads system_prompt_file content', () => {
    const model_file = join(tmp_dir, 'model.gguf');
    writeFileSync(model_file, 'fake');
    const prompt_file = join(tmp_dir, 'prompt.txt');
    writeFileSync(prompt_file, 'You are a helpful bot.');

    const config_path = make_config(tmp_dir, {
      models: {
        test: {
          model_path: './model.gguf',
          system_prompt_file: './prompt.txt'
        }
      }
    });

    const config = load_config(config_path);
    expect(config.models.test.system_prompt).toBe('You are a helpful bot.');
  });

  it('throws for missing config file', () => {
    expect(() => load_config('/nonexistent/config.json')).toThrow(/not found/);
  });

  it('throws for invalid JSON', () => {
    const config_path = join(tmp_dir, 'config.json');
    writeFileSync(config_path, '{broken json}}}');
    expect(() => load_config(config_path)).toThrow();
  });

  it('throws for missing required model_path', () => {
    const config_path = make_config(tmp_dir, {
      models: {
        test: { context_size: 4096 }
      }
    });
    expect(() => load_config(config_path)).toThrow();
  });

  it('throws for invalid model_type enum', () => {
    const config_path = make_config(tmp_dir, {
      models: {
        test: { model_path: './m.gguf', model_type: 'gpt4' }
      }
    });
    expect(() => load_config(config_path)).toThrow();
  });

  it('throws for missing system_prompt_file', () => {
    const model_file = join(tmp_dir, 'model.gguf');
    writeFileSync(model_file, 'fake');

    const config_path = make_config(tmp_dir, {
      models: {
        test: {
          model_path: './model.gguf',
          system_prompt_file: './nonexistent.txt'
        }
      }
    });
    expect(() => load_config(config_path)).toThrow(/not found/);
  });

  it('resolves relative model_path to absolute', () => {
    const model_file = join(tmp_dir, 'model.gguf');
    writeFileSync(model_file, 'fake');

    const config_path = make_config(tmp_dir, {
      models: { test: { model_path: './model.gguf' } }
    });

    const config = load_config(config_path);
    expect(config.models.test.model_path).toMatch(/^\//);
    expect(config.models.test.model_path).toBe(model_file);
  });
});
