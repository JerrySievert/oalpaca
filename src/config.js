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

const model_entry_schema = z.object({
  model_path: z.string(),
  model_type: z.enum(['qwen3', 'llama3', 'granite']).optional(),
  system_prompt_file: z.string().optional(),
  system_prompt: z.string().optional(),
  context_size: z.number().optional().default(8192),
  gpu_layers: z.number().optional(),
  assistant_name: z.string().optional().default('Assistant'),
  mcp_servers: z.array(mcp_server_schema).optional().default([])
});

const config_schema = z.object({
  models: z.record(z.string(), model_entry_schema)
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

  // Resolve relative paths for each model entry
  for (const [name, entry] of Object.entries(config.models)) {
    entry.model_path = resolve(config_dir, entry.model_path);

    if (entry.system_prompt_file) {
      const prompt_path = resolve(config_dir, entry.system_prompt_file);
      if (existsSync(prompt_path)) {
        entry.system_prompt = readFileSync(prompt_path, 'utf-8');
      } else {
        throw new Error(
          `System prompt file not found for model "${name}": ${prompt_path}`
        );
      }
    }

    // Resolve MCP server working directories
    for (const server of entry.mcp_servers) {
      if (server.cwd) {
        server.cwd = resolve(config_dir, server.cwd);
      }
    }
  }

  return config;
}

/**
 * Detect model type from an explicit override, model name, or model path.
 * @param {string} model - Model name or path
 * @param {string} [explicit_type] - Explicit model_type from config (takes priority)
 * @returns {'qwen3' | 'llama3' | 'granite'} Detected model type
 */
export function detect_model_type(model, explicit_type) {
  if (explicit_type) {
    return explicit_type;
  }

  const lower = model.toLowerCase();

  if (lower.includes('qwen')) {
    return 'qwen3';
  }

  if (lower.includes('llama')) {
    return 'llama3';
  }

  if (lower.includes('granite')) {
    return 'granite';
  }

  // Default to qwen3 as it has broader compatibility
  console.warn(
    `Could not detect model type from "${model}", defaulting to qwen3`
  );
  return 'qwen3';
}
