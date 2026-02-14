/**
 * Token Manager
 * Manages bearer tokens for API authentication.
 * Tokens are stored in a tokens.json file alongside config.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

const EMPTY_STORE = { tokens: {} };

/**
 * Load tokens from a JSON file. Returns empty store if file doesn't exist.
 * @param {string} token_path - Path to tokens.json
 * @returns {object} Token store { tokens: { [token]: { note, models, created_at } } }
 */
export function load_tokens(token_path) {
  if (!existsSync(token_path)) {
    return { tokens: {} };
  }
  try {
    return JSON.parse(readFileSync(token_path, 'utf-8'));
  } catch {
    return { tokens: {} };
  }
}

/**
 * Save tokens to a JSON file.
 * @param {string} token_path - Path to tokens.json
 * @param {object} store - Token store
 */
export function save_tokens(token_path, store) {
  writeFileSync(token_path, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Create a new token and save it to the store.
 * @param {string} token_path - Path to tokens.json
 * @param {string} note - Description for this token
 * @param {string[]} models - Models this token can access
 * @returns {string} The generated token string
 */
export function create_token(token_path, note, models) {
  const store = load_tokens(token_path);
  const token = randomBytes(32).toString('hex');
  store.tokens[token] = {
    note: note || '',
    models: models || [],
    created_at: new Date().toISOString()
  };
  save_tokens(token_path, store);
  return token;
}

/**
 * Revoke (delete) a token.
 * @param {string} token_path - Path to tokens.json
 * @param {string} token - The token to revoke
 * @returns {boolean} True if token was found and removed
 */
export function revoke_token(token_path, token) {
  const store = load_tokens(token_path);
  if (!(token in store.tokens)) {
    return false;
  }
  delete store.tokens[token];
  save_tokens(token_path, store);
  return true;
}

/**
 * List all tokens with their metadata.
 * @param {string} token_path - Path to tokens.json
 * @returns {Array<{ token: string, note: string, models: string[], created_at: string }>}
 */
export function list_tokens(token_path) {
  const store = load_tokens(token_path);
  return Object.entries(store.tokens).map(([token, entry]) => ({
    token,
    note: entry.note,
    models: entry.models,
    created_at: entry.created_at
  }));
}

/**
 * Update an existing token's note and/or models.
 * @param {string} token_path - Path to tokens.json
 * @param {string} token - The token to update
 * @param {object} updates - { note?: string, models?: string[] }
 * @returns {boolean} True if token was found and updated
 */
export function update_token(token_path, token, updates) {
  const store = load_tokens(token_path);
  if (!(token in store.tokens)) {
    return false;
  }
  if (updates.note !== undefined) {
    store.tokens[token].note = updates.note;
  }
  if (updates.models !== undefined) {
    store.tokens[token].models = updates.models;
  }
  save_tokens(token_path, store);
  return true;
}

/**
 * Get the allowed models for a token.
 * @param {object} store - Token store (already loaded)
 * @param {string} token - The bearer token
 * @returns {string[]|null} Array of allowed model names, or null if token is invalid
 */
export function get_models_for_token(store, token) {
  const entry = store.tokens[token];
  if (!entry) return null;
  return entry.models;
}
