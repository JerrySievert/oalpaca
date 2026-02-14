#!/usr/bin/env node

/**
 * Ollama-compatible HTTP server entry point.
 * Parses CLI args, loads config and tokens, and starts the server.
 */

import { resolve, dirname } from 'path';
import { OllamaServer, parse_args, set_debug } from './server_core.js';
import { load_config } from './config.js';
import { load_tokens } from './token_manager.js';

async function main() {
  const { config_path, port, host, debug, require_token } = parse_args();
  set_debug(debug);

  console.log('='.repeat(50));
  console.log('  Ollama-compatible MCP Server');
  console.log('='.repeat(50));
  if (debug) {
    console.log('  Debug mode: ON');
  }
  if (require_token) {
    console.log('  Token auth: REQUIRED');
  }
  console.log('');

  let config;
  try {
    config = load_config(config_path);
  } catch (error) {
    console.error(`Failed to load configuration: ${error.message}`);
    process.exit(1);
  }

  const model_names = Object.keys(config.models);
  if (model_names.length === 0) {
    console.error('Error: at least one model must be configured');
    process.exit(1);
  }

  // Always load token store — tokens filter model access even without -t
  const config_dir = dirname(resolve(config_path));
  const token_path = resolve(config_dir, 'tokens.json');
  const token_store = load_tokens(token_path);
  const token_count = Object.keys(token_store.tokens).length;

  if (require_token && token_count === 0) {
    console.warn('Warning: --require-token is set but no tokens exist.');
    console.warn(
      `  Create tokens with: node src/token_cli.js create --note "my device" --models ${model_names.join(',')}`
    );
  } else if (token_count > 0) {
    console.log(`Loaded ${token_count} token(s) from ${token_path}`);
  }

  const server = new OllamaServer(config, port, host, {
    require_token,
    token_store
  });
  await server.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
