import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';

const mcp_stdio_server_schema = z.object({
  name: z.string(),
  transport: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional()
});

const mcp_http_server_schema = z.object({
  name: z.string(),
  transport: z.literal('http'),
  url: z.string().url()
});

const mcp_server_schema = z.union([
  mcp_stdio_server_schema,
  mcp_http_server_schema
]);

const config_schema = z.object({
  model: z.string(),
  model_path: z.string().optional(),
  system_prompt_file: z.string().optional(),
  system_prompt: z.string().optional(),
  context_size: z.number().optional().default(8192),
  gpu_layers: z.number().optional(),
  assistant_name: z.string().optional().default('Assistant'),
  mcp_servers: z.array(mcp_server_schema).optional().default([])
});

/**
 * Load and validate configuration from a JSON file
 * @param {string} config_path - Path to the configuration file
 * @returns {object} Validated configuration object
 */
export function load_config(config_path) {
  const absolute_path = resolve(config_path);

  if (!existsSync(absolute_path)) {
    throw new Error(`Configuration file not found: ${absolute_path}`);
  }

  const config_dir = dirname(absolute_path);
  const raw_config = JSON.parse(readFileSync(absolute_path, 'utf-8'));

  const config = config_schema.parse(raw_config);

  // Resolve relative paths
  if (config.model_path) {
    config.model_path = resolve(config_dir, config.model_path);
  }

  if (config.system_prompt_file) {
    const prompt_path = resolve(config_dir, config.system_prompt_file);
    if (existsSync(prompt_path)) {
      config.system_prompt = readFileSync(prompt_path, 'utf-8');
    } else {
      throw new Error(`System prompt file not found: ${prompt_path}`);
    }
  }

  // Resolve MCP server working directories
  for (const server of config.mcp_servers) {
    if (server.cwd) {
      server.cwd = resolve(config_dir, server.cwd);
    }
  }

  return config;
}

/**
 * Detect model type from model name or path
 * @param {string} model - Model name or path
 * @returns {'qwen3' | 'llama3'} Detected model type
 */
export function detect_model_type(model) {
  const lower = model.toLowerCase();

  if (lower.includes('qwen')) {
    return 'qwen3';
  }

  if (lower.includes('llama')) {
    return 'llama3';
  }

  // Default to qwen3 as it has broader compatibility
  console.warn(
    `Could not detect model type from "${model}", defaulting to qwen3`
  );
  return 'qwen3';
}
