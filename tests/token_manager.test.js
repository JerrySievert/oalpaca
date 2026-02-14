import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  load_tokens,
  save_tokens,
  create_token,
  revoke_token,
  list_tokens,
  update_token,
  get_models_for_token
} from '../src/token_manager.js';

describe('get_models_for_token (pure)', () => {
  it('returns models array for valid token', () => {
    const store = {
      tokens: {
        abc123: { note: 'test', models: ['baseball', 'assistant'], created_at: '' }
      }
    };
    expect(get_models_for_token(store, 'abc123')).toEqual(['baseball', 'assistant']);
  });

  it('returns null for invalid token', () => {
    const store = { tokens: { abc123: { models: ['x'] } } };
    expect(get_models_for_token(store, 'wrong')).toBeNull();
  });

  it('returns null for empty store', () => {
    expect(get_models_for_token({ tokens: {} }, 'anything')).toBeNull();
  });
});

describe('token CRUD (file-based)', () => {
  let tmp_dir;
  let token_path;

  beforeEach(() => {
    tmp_dir = mkdtempSync(join(tmpdir(), 'llama-token-test-'));
    token_path = join(tmp_dir, 'tokens.json');
  });

  describe('load_tokens', () => {
    it('returns empty store for missing file', () => {
      const store = load_tokens(join(tmp_dir, 'nope.json'));
      expect(store).toEqual({ tokens: {} });
    });

    it('returns empty store for corrupt JSON', () => {
      writeFileSync(token_path, '{bad json!!!}');
      const store = load_tokens(token_path);
      expect(store).toEqual({ tokens: {} });
    });

    it('loads existing tokens', () => {
      const data = { tokens: { t1: { note: 'x', models: ['m'], created_at: '' } } };
      writeFileSync(token_path, JSON.stringify(data));
      const store = load_tokens(token_path);
      expect(store.tokens.t1.note).toBe('x');
    });
  });

  describe('create_token', () => {
    it('returns a 64-char hex string', () => {
      const token = create_token(token_path, 'test', ['baseball']);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('saves token with correct metadata', () => {
      const token = create_token(token_path, 'my note', ['baseball', 'assistant']);
      const store = load_tokens(token_path);
      const entry = store.tokens[token];
      expect(entry).toBeDefined();
      expect(entry.note).toBe('my note');
      expect(entry.models).toEqual(['baseball', 'assistant']);
      expect(entry.created_at).toBeTruthy();
    });

    it('creates unique tokens', () => {
      const t1 = create_token(token_path, 'a', ['x']);
      const t2 = create_token(token_path, 'b', ['y']);
      expect(t1).not.toBe(t2);
      const store = load_tokens(token_path);
      expect(Object.keys(store.tokens)).toHaveLength(2);
    });
  });

  describe('list_tokens', () => {
    it('returns empty array for no tokens', () => {
      expect(list_tokens(token_path)).toEqual([]);
    });

    it('returns all tokens with metadata', () => {
      create_token(token_path, 'first', ['a']);
      create_token(token_path, 'second', ['b']);
      const tokens = list_tokens(token_path);
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toHaveProperty('token');
      expect(tokens[0]).toHaveProperty('note');
      expect(tokens[0]).toHaveProperty('models');
      expect(tokens[0]).toHaveProperty('created_at');
    });
  });

  describe('revoke_token', () => {
    it('removes an existing token and returns true', () => {
      const token = create_token(token_path, 'test', ['x']);
      expect(revoke_token(token_path, token)).toBe(true);
      const store = load_tokens(token_path);
      expect(store.tokens[token]).toBeUndefined();
    });

    it('returns false for non-existent token', () => {
      expect(revoke_token(token_path, 'nonexistent')).toBe(false);
    });
  });

  describe('update_token', () => {
    it('updates note', () => {
      const token = create_token(token_path, 'old', ['x']);
      expect(update_token(token_path, token, { note: 'new' })).toBe(true);
      const store = load_tokens(token_path);
      expect(store.tokens[token].note).toBe('new');
    });

    it('updates models', () => {
      const token = create_token(token_path, 'test', ['a']);
      update_token(token_path, token, { models: ['a', 'b'] });
      const store = load_tokens(token_path);
      expect(store.tokens[token].models).toEqual(['a', 'b']);
    });

    it('returns false for non-existent token', () => {
      expect(update_token(token_path, 'nope', { note: 'x' })).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('create → save → load preserves all fields', () => {
      const token = create_token(token_path, 'round trip', ['m1', 'm2']);
      const store = load_tokens(token_path);
      const entry = store.tokens[token];
      expect(entry.note).toBe('round trip');
      expect(entry.models).toEqual(['m1', 'm2']);
      expect(new Date(entry.created_at).getTime()).not.toBeNaN();
    });
  });
});
