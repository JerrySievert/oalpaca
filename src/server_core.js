/**
 * Ollama-compatible HTTP server core.
 * Contains the OllamaServer class and utility functions, with no auto-executing code.
 * Imported by server.js (the entry point) and by tests.
 */

import { createServer } from 'http';
import { get_models_for_token } from './token_manager.js';
import { ModelManager } from './model_manager.js';
import { RequestScheduler } from './request_scheduler.js';

const DEFAULT_CONFIG_PATH = './config.json';
const DEFAULT_PORT = 9000;
const DEFAULT_HOST = '0.0.0.0';
const MAX_TOOL_ITERATIONS = 10;

let DEBUG = false;

/**
 * Set the global DEBUG flag.
 * @param {boolean} value
 */
export function set_debug(value) {
  DEBUG = value;
}

/**
 * Log a message only when --debug is active
 * @param  {...any} args - Arguments to log
 */
export function debug_log(...args) {
  if (DEBUG) {
    console.log(`[DEBUG ${new Date().toISOString()}]`, ...args);
  }
}

/**
 * Parse command line arguments for the HTTP server.
 * @param {string[]} [argv] - Argument array (defaults to process.argv.slice(2))
 * @returns {{ config_path: string, port: number, host: string, debug: boolean, require_token: boolean }}
 */
export function parse_args(argv) {
  const args = argv || process.argv.slice(2);
  let config_path = DEFAULT_CONFIG_PATH;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let debug = false;
  let require_token = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      config_path = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--host' || args[i] === '-h') {
      host = args[++i];
    } else if (args[i] === '--debug' || args[i] === '-d') {
      debug = true;
    } else if (args[i] === '--require-token' || args[i] === '-t') {
      require_token = true;
    }
  }

  return { config_path, port, host, debug, require_token };
}

/**
 * Read the request body and parse it as JSON.
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {Promise<object>} Parsed JSON body
 * @throws {Error} If the body is not valid JSON
 */
export async function read_json_body(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response with CORS headers.
 * @param {import('http').ServerResponse} res - HTTP response
 * @param {number} status - HTTP status code
 * @param {object} data - Response body (will be JSON-serialized)
 */
export function send_json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

/**
 * Write a single NDJSON chunk to a streaming response.
 * @param {import('http').ServerResponse} res - HTTP response
 * @param {object} data - Chunk data (will be JSON-serialized with trailing newline)
 */
export function send_chunk(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

/**
 * Ollama-compatible HTTP server with OpenAI endpoint support.
 */
export class OllamaServer {
  /**
   * @param {object} config - Validated configuration object from load_config()
   * @param {number} port - Port to listen on
   * @param {string} host - Host to bind to
   * @param {object} [options]
   * @param {boolean} [options.require_token=false] - Require bearer token auth on all requests
   * @param {object} [options.token_store=null] - Token store loaded by load_tokens()
   * @param {ModelManager} [options.model_manager=null] - Custom ModelManager (for testing)
   * @param {RequestScheduler} [options.scheduler=null] - Custom RequestScheduler (for testing)
   */
  constructor(
    config,
    port,
    host,
    {
      require_token = false,
      token_store = null,
      model_manager = null,
      scheduler = null
    } = {}
  ) {
    this.config = config;
    this.port = port;
    this.host = host;
    this.require_token = require_token;
    this.token_store = token_store || { tokens: {} };
    this.model_manager = model_manager || new ModelManager(config, debug_log);
    this.scheduler =
      scheduler || new RequestScheduler(this.model_manager, debug_log);
  }

  async initialize() {
    await this.model_manager.initialize();
  }

  /**
   * Extract bearer token from the Authorization header.
   * @param {object} req - HTTP request
   * @returns {string|null} The token string, or null if not present
   */
  extract_token(req) {
    const auth = req.headers['authorization'];
    if (!auth) return null;
    const parts = auth.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      return parts[1];
    }
    return null;
  }

  /**
   * Authenticate a request and return the allowed models.
   * When a bearer token is present, returns the models it grants access to.
   * When no token is present and require_token is false, returns null (no filtering).
   * When no token is present and require_token is true, the global gate in
   * handle_request already rejected the request, so this is defense-in-depth.
   * @param {object} req - HTTP request
   * @param {object} res - HTTP response
   * @returns {string[]|null|false} Allowed model names array, null if no filtering needed, false if auth failed (response already sent)
   */
  authenticate(req, res) {
    const token = this.extract_token(req);

    if (!token) {
      if (this.require_token) {
        // Global gate should have caught this, but defense-in-depth
        debug_log('auth: missing bearer token');
        send_json(res, 401, { error: 'Authorization required' });
        return false;
      }
      return null; // No token, no filtering
    }

    const allowed_models = get_models_for_token(this.token_store, token);
    if (!allowed_models) {
      if (this.require_token) {
        debug_log('auth: invalid token');
        send_json(res, 401, { error: 'Invalid token' });
        return false;
      }
      return null; // Invalid token but auth not required — ignore it
    }

    debug_log('auth: token valid, allowed models:', allowed_models);
    return allowed_models;
  }

  /**
   * Build system prompt with tools for a given model entry
   * @param {object} entry - LoadedModelEntry
   * @param {Array|null} request_tools - Tools from the request (Ollama format)
   * @returns {string}
   */
  build_system_prompt(entry, request_tools) {
    let system_prompt = entry.config.system_prompt || '';

    // Append current date and time so the model has a concept of time
    const now = new Date();
    system_prompt += `\n\nCurrent date and time: ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}`;

    // Use request tools if provided, otherwise use the model's MCP tools
    const tools_to_use = request_tools || entry.tools;
    if (tools_to_use.length > 0) {
      const normalized_tools = tools_to_use.map((t) => {
        if (t.type === 'function' && t.function) {
          return {
            name: t.function.name,
            description: t.function.description,
            inputSchema: t.function.parameters
          };
        }
        return t;
      });
      system_prompt += entry.handler.format_tools_for_prompt(normalized_tools);
    }

    return system_prompt;
  }

  /**
   * Execute a chat completion against a loaded model entry.
   * Called by the scheduler once the model is loaded and it's this request's turn.
   * @param {object} entry - LoadedModelEntry
   * @param {Array} messages - Chat messages
   * @param {Array|null} request_tools - Tools from the request
   * @param {boolean} stream - Whether to stream the response
   * @param {object} res - HTTP response object
   */
  async execute_chat(entry, messages, request_tools, stream, res) {
    const { LlamaChatSession } = await import('node-llama-cpp');

    debug_log('execute_chat start', {
      model: entry.name,
      stream,
      message_count: messages.length
    });

    const system_prompt = this.build_system_prompt(entry, request_tools);
    debug_log('system_prompt length:', system_prompt.length);

    // Extract system message from messages if present
    let effective_system = system_prompt;
    const chat_messages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        effective_system = msg.content + '\n' + system_prompt;
      } else {
        chat_messages.push(msg);
      }
    }

    debug_log('creating context with size:', entry.config.context_size);

    const context = await entry.model.createContext({
      contextSize: entry.config.context_size
    });
    const sequence = context.getSequence();
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt: effective_system
    });

    debug_log(
      'context created, replaying',
      chat_messages.length - 1,
      'history messages'
    );

    const created_at = new Date().toISOString();

    const start_stream = () => {
      if (stream && !res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*'
        });
        debug_log('streaming response headers sent');
      }
    };

    try {
      // Replay conversation history except last user message
      for (let i = 0; i < chat_messages.length - 1; i++) {
        const msg = chat_messages[i];
        if (msg.role === 'user') {
          debug_log(
            'replaying history message',
            i,
            ':',
            msg.content.slice(0, 80)
          );
          await session.prompt(msg.content);
        }
      }

      // Get the last user message
      const last_message = chat_messages[chat_messages.length - 1];
      if (!last_message || last_message.role !== 'user') {
        throw new Error('Last message must be from user');
      }

      debug_log('user input:', last_message.content.slice(0, 200));

      let current_input = last_message.content;
      let iteration = 0;
      let final_response = '';
      let tool_calls_made = [];
      let recent_call_signatures = [];

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        debug_log(`inference iteration ${iteration}, prompting model...`);
        const prompt_start = Date.now();

        if (stream) {
          start_stream();
        }

        let keepalive_interval = null;
        if (stream) {
          keepalive_interval = setInterval(() => {
            send_chunk(res, {
              model: entry.name,
              created_at,
              message: { role: 'assistant', content: '' },
              done: false
            });
          }, 3000);
        }

        const response = await session.prompt(current_input);

        if (keepalive_interval) {
          clearInterval(keepalive_interval);
        }

        const prompt_ms = Date.now() - prompt_start;
        debug_log(
          `model responded in ${prompt_ms}ms, length=${response.length}`
        );
        debug_log('raw response:', response.slice(0, 500));

        // Check for tool calls
        if (entry.handler.has_tool_calls(response)) {
          const tool_calls = entry.handler.parse_tool_calls(response);
          debug_log(
            'parsed tool calls:',
            tool_calls.length,
            JSON.stringify(tool_calls.map((c) => c.name))
          );

          if (tool_calls.length === 0) {
            final_response = response;
            break;
          }

          // Detect repeated identical tool calls (stuck in a loop)
          const call_signature = JSON.stringify(
            tool_calls.map((c) => ({ name: c.name, arguments: c.arguments }))
          );
          recent_call_signatures.push(call_signature);

          const repeat_count = recent_call_signatures.filter(
            (s) => s === call_signature
          ).length;

          if (repeat_count >= 3) {
            debug_log(
              'detected repeated tool call loop, breaking out:',
              call_signature.slice(0, 200)
            );
            const tool_names = tool_calls.map((c) => c.name).join(', ');
            final_response =
              `I wasn't able to get the right information — I kept trying to call ${tool_names} ` +
              `with the same arguments without success. Could you try rephrasing your question ` +
              `or providing more specific details?`;
            break;
          }

          // Execute tool calls
          const results = [];
          for (const call of tool_calls) {
            debug_log(
              `MCP call: ${call.name}(${JSON.stringify(call.arguments)})`
            );
            const mcp_start = Date.now();
            try {
              const result = await entry.mcp_manager.call_tool(
                call.name,
                call.arguments
              );
              const mcp_ms = Date.now() - mcp_start;
              debug_log(
                `MCP result for ${call.name} in ${mcp_ms}ms:`,
                String(result).slice(0, 300)
              );
              results.push({ name: call.name, result, success: true });
              tool_calls_made.push({
                function: { name: call.name, arguments: call.arguments }
              });
            } catch (error) {
              const mcp_ms = Date.now() - mcp_start;
              debug_log(
                `MCP error for ${call.name} in ${mcp_ms}ms:`,
                error.message
              );
              results.push({
                name: call.name,
                result: error.message,
                success: false
              });
            }
          }

          // Format results, adding parameter guidance for empty/failed results
          const formatted_parts = [];
          for (const r of results) {
            let formatted = entry.handler.format_tool_result(r.name, r.result);

            const is_empty =
              !r.result ||
              r.result === '[]' ||
              r.result === '{}' ||
              r.result === 'null' ||
              (typeof r.result === 'string' && r.result.trim() === '') ||
              (Array.isArray(r.result) && r.result.length === 0);

            if (!r.success || is_empty) {
              const tool_schema = entry.tools.find((t) => t.name === r.name);
              if (tool_schema && tool_schema.inputSchema) {
                const schema = tool_schema.inputSchema;
                const required = schema.required || [];
                const props = schema.properties || {};
                const param_descriptions = Object.entries(props)
                  .map(([k, v]) => {
                    const req_marker = required.includes(k)
                      ? ' (required)'
                      : ' (optional)';
                    const type_str = v.type ? ` [${v.type}]` : '';
                    return `  - ${k}${type_str}${req_marker}: ${v.description || 'no description'}`;
                  })
                  .join('\n');

                formatted +=
                  `\n\nThe call to ${r.name} ${!r.success ? 'failed' : 'returned no results'}. ` +
                  `Review the required parameters and try a different approach. ` +
                  `Expected parameters for ${r.name}:\n${param_descriptions}` +
                  `\n\nIf you do not have the correct values for the required parameters, ` +
                  `do NOT retry with the same arguments. Instead, try a different tool ` +
                  `to find the needed information, or respond to the user explaining ` +
                  `what information you need.`;
              }
            }

            formatted_parts.push(formatted);
          }

          const formatted_results = formatted_parts.join('\n\n');

          debug_log('formatted tool results length:', formatted_results.length);
          current_input = formatted_results;
        } else {
          debug_log('no tool calls detected, final response');
          final_response = response;
          break;
        }
      }

      if (iteration >= MAX_TOOL_ITERATIONS) {
        debug_log('hit MAX_TOOL_ITERATIONS limit');
        if (!final_response) {
          final_response =
            'I was unable to complete this request — too many tool calls were needed. ' +
            'Please try rephrasing your question or providing more specific details.';
        }
      }

      // Stream or send the final clean response
      if (stream) {
        start_stream();

        if (final_response) {
          const words = final_response.split(' ');
          for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            send_chunk(res, {
              model: entry.name,
              created_at,
              message: {
                role: 'assistant',
                content: chunk
              },
              done: false
            });
          }
        }
        send_chunk(res, {
          model: entry.name,
          created_at,
          message: {
            role: 'assistant',
            content: ''
          },
          done: true,
          done_reason: 'stop',
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: 0,
          prompt_eval_duration: 0,
          eval_count: 0,
          eval_duration: 0
        });

        res.end();
        debug_log('streaming response ended');
      } else {
        const response_message = {
          role: 'assistant',
          content: final_response
        };

        if (tool_calls_made.length > 0) {
          response_message.tool_calls = tool_calls_made;
        }

        debug_log('sending non-streaming response');
        send_json(res, 200, {
          model: entry.name,
          created_at,
          message: response_message,
          done: true,
          done_reason: 'stop',
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: 0,
          prompt_eval_duration: 0,
          eval_count: 0,
          eval_duration: 0
        });
        debug_log('non-streaming response sent');
      }
    } finally {
      debug_log('disposing context');
      await context.dispose();
    }
  }

  /**
   * Execute a chat completion in OpenAI format
   * @param {object} entry - LoadedModelEntry
   * @param {Array} messages - Chat messages
   * @param {Array|null} request_tools - Tools from the request
   * @param {boolean} stream - Whether to stream the response
   * @param {object} res - HTTP response object
   */
  async execute_chat_openai(entry, messages, request_tools, stream, res) {
    const { LlamaChatSession } = await import('node-llama-cpp');

    const system_prompt = this.build_system_prompt(entry, request_tools);

    let effective_system = system_prompt;
    const chat_messages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        effective_system = msg.content + '\n' + system_prompt;
      } else {
        chat_messages.push(msg);
      }
    }

    const context = await entry.model.createContext({
      contextSize: entry.config.context_size
    });
    const sequence = context.getSequence();
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt: effective_system
    });

    try {
      for (let i = 0; i < chat_messages.length - 1; i++) {
        const msg = chat_messages[i];
        if (msg.role === 'user') {
          await session.prompt(msg.content);
        }
      }

      const last_message = chat_messages[chat_messages.length - 1];
      if (!last_message || last_message.role !== 'user') {
        throw new Error('Last message must be from user');
      }

      let current_input = last_message.content;
      let iteration = 0;
      let final_response = '';
      let tool_calls_made = [];

      while (iteration < MAX_TOOL_ITERATIONS) {
        iteration++;

        const response = await session.prompt(current_input);

        if (entry.handler.has_tool_calls(response)) {
          const tool_calls = entry.handler.parse_tool_calls(response);

          if (tool_calls.length === 0) {
            final_response = response;
            break;
          }

          const results = [];
          for (const call of tool_calls) {
            try {
              const result = await entry.mcp_manager.call_tool(
                call.name,
                call.arguments
              );
              results.push({ name: call.name, result, success: true });
              tool_calls_made.push({
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments)
                }
              });
            } catch (error) {
              results.push({
                name: call.name,
                result: error.message,
                success: false
              });
            }
          }

          const formatted_results = results
            .map((r) => entry.handler.format_tool_result(r.name, r.result))
            .join('\n\n');

          current_input = formatted_results;
        } else {
          final_response = response;
          break;
        }
      }

      const created = Math.floor(Date.now() / 1000);
      const completion_id = `chatcmpl-${Date.now()}`;

      if (stream) {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
        }

        const words = final_response.split(' ');
        for (let i = 0; i < words.length; i++) {
          const chunk = i === 0 ? words[i] : ' ' + words[i];
          const data = {
            id: completion_id,
            object: 'chat.completion.chunk',
            created,
            model: entry.name,
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: null
              }
            ]
          };
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }

        const final_data = {
          id: completion_id,
          object: 'chat.completion.chunk',
          created,
          model: entry.name,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ]
        };
        res.write(`data: ${JSON.stringify(final_data)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const response_message = {
          role: 'assistant',
          content: final_response
        };

        if (tool_calls_made.length > 0) {
          response_message.tool_calls = tool_calls_made;
        }

        send_json(res, 200, {
          id: completion_id,
          object: 'chat.completion',
          created,
          model: entry.name,
          choices: [
            {
              index: 0,
              message: response_message,
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          }
        });
      }
    } finally {
      await context.dispose();
    }
  }

  /**
   * Route and handle an incoming HTTP request.
   * @param {import('http').IncomingMessage} req - HTTP request
   * @param {import('http').ServerResponse} res - HTTP response
   */
  async handle_request(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${this.port}`);
    } catch {
      debug_log('invalid URL:', req.url);
      send_json(res, 400, { error: 'Invalid URL' });
      return;
    }

    // Normalize trailing slashes (e.g. /api/chat/ -> /api/chat)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Log inbound requests (skip noisy HEAD / in non-debug mode)
    if (DEBUG || !(req.method === 'HEAD' && url.pathname === '/')) {
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${url.pathname}`
      );
    }

    // Handle CORS preflight (must come before auth so browsers can negotiate)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    // Global bearer token gate — every request must have a valid token
    // that grants access to at least one configured model
    if (this.require_token) {
      const token = this.extract_token(req);
      const token_models = token
        ? get_models_for_token(this.token_store, token)
        : null;

      if (!token || !token_models) {
        debug_log('require-token: rejected request — missing or invalid token');
        send_json(res, 403, {
          error: 'Forbidden: valid bearer token required'
        });
        return;
      }

      const configured_models = this.model_manager.get_model_names();
      const has_valid_model = token_models.some((m) =>
        configured_models.includes(m)
      );
      if (!has_valid_model) {
        debug_log(
          'require-token: rejected — token models',
          token_models,
          'do not match any configured model',
          configured_models
        );
        send_json(res, 403, {
          error: 'Forbidden: token does not grant access to any available model'
        });
        return;
      }
    }

    try {
      // GET / or HEAD / - health check
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        url.pathname === '/'
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'GET') {
          res.end('Ollama is running');
        } else {
          res.end();
        }
        return;
      }

      // GET /api/tags - list all configured models
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        send_json(res, 200, {
          models: this.model_manager.get_all_model_info(allowed_models)
        });
        return;
      }

      // GET /api/version
      if (req.method === 'GET' && url.pathname === '/api/version') {
        send_json(res, 200, { version: '0.6.2' });
        return;
      }

      // GET /api/ps - list running (loaded) models
      if (req.method === 'GET' && url.pathname === '/api/ps') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        send_json(res, 200, {
          models: this.model_manager.get_running_model_info(allowed_models)
        });
        return;
      }

      // POST /api/show - model details
      if (req.method === 'POST' && url.pathname === '/api/show') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        const body = await read_json_body(req);
        debug_log('api/show body:', JSON.stringify(body));

        const model_name = body.name || body.model;
        if (allowed_models && !allowed_models.includes(model_name)) {
          send_json(res, 403, {
            error: `access denied to model "${model_name}"`
          });
          return;
        }

        const details = this.model_manager.get_model_details(model_name);
        if (!details) {
          send_json(res, 404, { error: `model "${model_name}" not found` });
          return;
        }
        send_json(res, 200, details);
        return;
      }

      // POST /api/chat
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        const body = await read_json_body(req);
        const { model: model_name, messages, tools, stream = true } = body;
        debug_log(
          'api/chat body:',
          `model=${model_name} stream=${stream} messages=${messages?.length}`
        );

        if (!messages || !Array.isArray(messages)) {
          send_json(res, 400, { error: 'messages array required' });
          return;
        }

        if (allowed_models && !allowed_models.includes(model_name)) {
          send_json(res, 403, {
            error: `access denied to model "${model_name}"`
          });
          return;
        }

        if (!this.model_manager.has_model(model_name)) {
          send_json(res, 404, { error: `model "${model_name}" not found` });
          return;
        }

        await this.scheduler.submit(
          model_name,
          async (entry) => {
            await this.execute_chat(entry, messages, tools, stream, res);
          },
          res,
          stream
        );
        return;
      }

      // POST /api/generate (simple completion)
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        const body = await read_json_body(req);
        const { model: model_name, prompt, stream = true } = body;
        debug_log('api/generate body:', `model=${model_name} stream=${stream}`);

        if (!prompt) {
          send_json(res, 400, { error: 'prompt required' });
          return;
        }

        if (allowed_models && !allowed_models.includes(model_name)) {
          send_json(res, 403, {
            error: `access denied to model "${model_name}"`
          });
          return;
        }

        if (!this.model_manager.has_model(model_name)) {
          send_json(res, 404, { error: `model "${model_name}" not found` });
          return;
        }

        await this.scheduler.submit(
          model_name,
          async (entry) => {
            await this.execute_chat(
              entry,
              [{ role: 'user', content: prompt }],
              null,
              stream,
              res
            );
          },
          res,
          stream
        );
        return;
      }

      // OpenAI-compatible endpoint
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        const body = await read_json_body(req);
        const { model: model_name, messages, tools, stream = false } = body;
        debug_log(
          'v1/chat/completions body:',
          `model=${model_name} stream=${stream} messages=${messages?.length}`
        );

        if (!messages || !Array.isArray(messages)) {
          send_json(res, 400, { error: 'messages array required' });
          return;
        }

        if (allowed_models && !allowed_models.includes(model_name)) {
          send_json(res, 403, {
            error: `access denied to model "${model_name}"`
          });
          return;
        }

        if (!this.model_manager.has_model(model_name)) {
          send_json(res, 404, { error: `model "${model_name}" not found` });
          return;
        }

        await this.scheduler.submit(
          model_name,
          async (entry) => {
            await this.execute_chat_openai(entry, messages, tools, stream, res);
          },
          res,
          stream
        );
        return;
      }

      // OpenAI models endpoint
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const allowed_models = this.authenticate(req, res);
        if (allowed_models === false) return;

        let model_names = this.model_manager.get_model_names();
        if (allowed_models) {
          model_names = model_names.filter((name) =>
            allowed_models.includes(name)
          );
        }
        const models = model_names.map((name) => ({
          id: name,
          object: 'model',
          created: Date.now(),
          owned_by: 'local'
        }));
        send_json(res, 200, {
          object: 'list',
          data: models
        });
        return;
      }

      // 404 for unknown routes
      console.log(`  [404] No handler for ${req.method} ${url.pathname}`);
      send_json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error(`  [ERROR] ${error.message}`);
      if (!res.headersSent) {
        send_json(res, 500, { error: error.message });
      }
    }
  }

  /**
   * Start listening for HTTP requests.
   * @returns {Promise<import('http').Server>} The listening HTTP server instance
   */
  async start() {
    await this.initialize();

    const server = createServer((req, res) => {
      this.handle_request(req, res);
    });

    const model_names = this.model_manager.get_model_names();

    server.listen(this.port, this.host, () => {
      console.log(
        `\nOllama-compatible server running at http://${this.host}:${this.port}`
      );
      console.log(`Models: ${model_names.join(', ')}`);
      console.log('\nEndpoints:');
      console.log('  Ollama API:');
      console.log(`    POST /api/chat     - Chat completions`);
      console.log(`    POST /api/generate - Text generation`);
      console.log(`    GET  /api/tags     - List models`);
      console.log(`    GET  /api/ps       - Running models`);
      console.log(`    GET  /api/version  - Server version`);
      console.log('  OpenAI API:');
      console.log(`    POST /v1/chat/completions - Chat completions`);
      console.log(`    GET  /v1/models           - List models`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      await this.model_manager.shutdown();
      console.log('Goodbye!');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return server;
  }
}
