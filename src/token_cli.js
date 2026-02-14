#!/usr/bin/env node

/**
 * CLI tool for managing bearer tokens.
 *
 * Usage (positional — works with npm start tokens):
 *   npm start tokens create <models> [note]
 *   npm start tokens list
 *   npm start tokens revoke <token>
 *   npm start tokens update <token> <models> [note]
 *
 * Usage (flags — works with npm run tokens --):
 *   npm run tokens -- create --note "Jerry's iPad" --models baseball,assistant
 *   npm run tokens -- list
 *   npm run tokens -- revoke <token>
 *   npm run tokens -- update <token> --note "new note" --models baseball
 */

import { resolve } from 'path';
import {
  create_token,
  revoke_token,
  list_tokens,
  update_token
} from './token_manager.js';

const DEFAULT_TOKEN_PATH = resolve('./tokens.json');

function parse_args() {
  const args = process.argv.slice(2);
  const command = args[0];
  let token_path = DEFAULT_TOKEN_PATH;
  let note = '';
  let models = [];
  let token = null;
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--tokens-file') {
      token_path = resolve(args[++i]);
    } else if (args[i] === '--note') {
      note = args[++i];
    } else if (args[i] === '--models') {
      models = args[++i]
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    }
  }

  // For commands that accept a token arg, first positional is the token
  if (command === 'revoke' || command === 'update') {
    token = positional[0] || null;
  }

  // Positional fallbacks (for npm start tokens create <models> [note]):
  //   create: positional[0] = models, positional[1..] = note
  //   update: positional[0] = token, positional[1] = models, positional[2..] = note
  if (command === 'create' && models.length === 0 && positional.length > 0) {
    models = positional[0]
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (!note && positional.length > 1) {
      note = positional.slice(1).join(' ');
    }
  } else if (
    command === 'update' &&
    models.length === 0 &&
    positional.length > 1
  ) {
    models = positional[1]
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (!note && positional.length > 2) {
      note = positional.slice(2).join(' ');
    }
  }

  return { command, token_path, note, models, token };
}

function print_usage() {
  console.log(`Token Management CLI

Usage:
  npm start tokens <command> [args...]

Commands:
  create <models> [note]           Create a new token
  list                             List all tokens
  revoke <token>                   Revoke a token
  update <token> <models> [note]   Update a token

Arguments:
  models       Comma-separated list of allowed models (e.g. baseball,assistant)
  note         Description for the token (optional)
  token        The token string to revoke or update

Options (flag style, requires -- separator with npm):
  --note <text>             Description for the token
  --models <m1,m2,...>      Comma-separated list of allowed models
  --tokens-file <path>      Path to tokens.json (default: ./tokens.json)

Examples:
  npm start tokens create baseball,assistant Jerry's iPad
  npm start tokens list
  npm start tokens revoke abc123def456...
  npm start tokens update abc123def456... baseball,assistant Kitchen Mac`);
}

function cmd_create({ token_path, note, models }) {
  if (models.length === 0) {
    console.error('Error: --models is required when creating a token');
    process.exit(1);
  }

  const token = create_token(token_path, note, models);
  console.log('Token created successfully.\n');
  console.log(`  Token:  ${token}`);
  console.log(`  Note:   ${note || '(none)'}`);
  console.log(`  Models: ${models.join(', ')}`);
  console.log(`\nSaved to: ${token_path}`);
}

function cmd_list({ token_path }) {
  const tokens = list_tokens(token_path);

  if (tokens.length === 0) {
    console.log('No tokens found.');
    return;
  }

  console.log(
    `${'Token'.padEnd(20)} ${'Note'.padEnd(25)} ${'Models'.padEnd(30)} Created`
  );
  console.log('-'.repeat(95));

  for (const entry of tokens) {
    const short_token = entry.token.slice(0, 16) + '...';
    const note = (entry.note || '(none)').slice(0, 23);
    const models = entry.models.join(', ').slice(0, 28);
    const created = entry.created_at
      ? entry.created_at.slice(0, 10)
      : 'unknown';
    console.log(
      `${short_token.padEnd(20)} ${note.padEnd(25)} ${models.padEnd(30)} ${created}`
    );
  }

  console.log(`\n${tokens.length} token(s) total`);
}

function cmd_revoke({ token_path, token }) {
  if (!token) {
    console.error('Error: token argument is required');
    console.error('Usage: node src/token_cli.js revoke <token>');
    process.exit(1);
  }

  const removed = revoke_token(token_path, token);
  if (removed) {
    console.log('Token revoked successfully.');
  } else {
    console.error('Error: token not found');
    process.exit(1);
  }
}

function cmd_update({ token_path, token, note, models }) {
  if (!token) {
    console.error('Error: token argument is required');
    console.error(
      'Usage: node src/token_cli.js update <token> --note "..." --models m1,m2'
    );
    process.exit(1);
  }

  const updates = {};
  if (note) updates.note = note;
  if (models.length > 0) updates.models = models;

  if (Object.keys(updates).length === 0) {
    console.error('Error: provide --note and/or --models to update');
    process.exit(1);
  }

  const updated = update_token(token_path, token, updates);
  if (updated) {
    console.log('Token updated successfully.');
    if (updates.note !== undefined) console.log(`  Note:   ${updates.note}`);
    if (updates.models !== undefined)
      console.log(`  Models: ${updates.models.join(', ')}`);
  } else {
    console.error('Error: token not found');
    process.exit(1);
  }
}

// Main
const parsed = parse_args();

switch (parsed.command) {
  case 'create':
    cmd_create(parsed);
    break;
  case 'list':
    cmd_list(parsed);
    break;
  case 'revoke':
    cmd_revoke(parsed);
    break;
  case 'update':
    cmd_update(parsed);
    break;
  default:
    print_usage();
    process.exit(parsed.command ? 1 : 0);
}
