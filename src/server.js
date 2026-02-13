#!/usr/bin/env node

/**
 * Ollama-compatible HTTP server for llama.cpp with MCP tool support
 */

import { createServer } from 'http';
import { getLlama } from 'node-llama-cpp';
import { load_config, detect_model_type } from './config.js';
import { McpClientManager } from './mcp_client.js';
import { get_handler } from './model_handlers/index.js';

const DEFAULT_CONFIG_PATH = './config.json';
const DEFAULT_PORT = 9000;
const DEFAULT_HOST = '0.0.0.0';
const MAX_TOOL_ITERATIONS = 10;

let DEBUG = false;

/**
 * Log a message only when --debug is active
 * @param  {...any} args - Arguments to log
 */
function debug_log(...args) {
  if (DEBUG) {
    console.log(`[DEBUG ${new Date().toISOString()}]`, ...args);
  }
}

/**
 * Parse command line arguments
 */
function parse_args() {
  const args = process.argv.slice(2);
  let config_path = DEFAULT_CONFIG_PATH;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      config_path = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--host' || args[i] === '-h') {
      host = args[++i];
    } else if (args[i] === '--debug' || args[i] === '-d') {
      debug = true;
    }
  }

  return { config_path, port, host, debug };
}

/**
 * Read request body as JSON
 */
async function read_json_body(req) {
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
 * Send JSON response
 */
function send_json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

/**
 * Send streaming response chunk
 */
function send_chunk(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

/**
 * Main server class
 */
class OllamaServer {
  constructor(config, port, host) {
    this.config = config;
    this.port = port;
    this.host = host;
    this.llama = null;
    this.model = null;
    this.mcp_manager = new McpClientManager();
    this.model_type = detect_model_type(config.model);
    this.handler = get_handler(this.model_type);
    this.tools = [];
    this.request_queue = Promise.resolve();
  }

  async initialize() {
    // Connect to MCP servers
    if (this.config.mcp_servers.length > 0) {
      console.log('Connecting to MCP servers...');
      await this.mcp_manager.connect_all(this.config.mcp_servers);
    }

    // Load model
    console.log('Loading model...');
    this.llama = await getLlama();
    this.model = await this.llama.loadModel({
      modelPath: this.config.model_path
    });

    // Get available tools
    this.tools = this.mcp_manager.get_all_tools();
    console.log(`Model loaded: ${this.config.model}`);
    console.log(`Tools available: ${this.tools.length}`);
  }

  /**
   * Build system prompt with tools
   */
  build_system_prompt(request_tools) {
    let system_prompt = this.config.system_prompt || '';

    // Use request tools if provided, otherwise use MCP tools
    const tools_to_use = request_tools || this.tools;
    if (tools_to_use.length > 0) {
      // Convert Ollama tool format to our format if needed
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
      system_prompt += this.handler.format_tools_for_prompt(normalized_tools);
    }

    return system_prompt;
  }

  /**
   * Handle chat completion with tool execution
   */
  async handle_chat(messages, request_tools, stream, res) {
    // Queue requests to run sequentially
    const do_request = async () => {
      const { LlamaChatSession } = await import('node-llama-cpp');

      debug_log('handle_chat start', {
        stream,
        message_count: messages.length
      });

      const system_prompt = this.build_system_prompt(request_tools);
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

      debug_log('creating context with size:', this.config.context_size);

      // Create a context for this request
      const context = await this.model.createContext({
        contextSize: this.config.context_size
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

      // If streaming, open the response immediately so the client sees headers
      let stream_started = false;
      const created_at = new Date().toISOString();

      const start_stream = () => {
        if (stream && !stream_started) {
          stream_started = true;
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

          // Open the stream early so the client doesn't time out waiting
          // during tool call iterations. We send empty keepalive chunks
          // during inference so the connection stays alive.
          if (stream) {
            start_stream();
          }

          let keepalive_interval = null;
          if (stream) {
            keepalive_interval = setInterval(() => {
              send_chunk(res, {
                model: this.config.model,
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
          if (this.handler.has_tool_calls(response)) {
            const tool_calls = this.handler.parse_tool_calls(response);
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
                const result = await this.mcp_manager.call_tool(
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
              let formatted = this.handler.format_tool_result(r.name, r.result);

              const is_empty =
                !r.result ||
                r.result === '[]' ||
                r.result === '{}' ||
                r.result === 'null' ||
                (typeof r.result === 'string' && r.result.trim() === '') ||
                (Array.isArray(r.result) && r.result.length === 0);

              if (!r.success || is_empty) {
                const tool_schema = this.tools.find((t) => t.name === r.name);
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

            debug_log(
              'formatted tool results length:',
              formatted_results.length
            );
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

        // Now stream or send the final clean response (no tool call markup)
        if (stream) {
          start_stream();

          // Re-generate the final response with live streaming to the client
          if (final_response) {
            // We already have the final text from the last iteration.
            // Stream it to the client using onTextChunk by re-prompting
            // with the same context -- but since the session already has
            // the response, we just send the collected text as chunks.
            const words = final_response.split(' ');
            for (let i = 0; i < words.length; i++) {
              const chunk = i === 0 ? words[i] : ' ' + words[i];
              send_chunk(res, {
                model: this.config.model,
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
            model: this.config.model,
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
            model: this.config.model,
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
        // Dispose context to free resources
        await context.dispose();
      }
    };

    // Queue this request
    this.request_queue = this.request_queue.then(do_request).catch(do_request);
    await this.request_queue;
  }

  /**
   * Handle chat completion in OpenAI format
   */
  async handle_chat_openai(messages, request_tools, stream, res) {
    // Queue requests to run sequentially
    const do_request = async () => {
      const { LlamaChatSession } = await import('node-llama-cpp');

      const system_prompt = this.build_system_prompt(request_tools);

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

      // Create a context for this request
      const context = await this.model.createContext({
        contextSize: this.config.context_size
      });
      const sequence = context.getSequence();
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: effective_system
      });

      try {
        // Replay conversation history except last user message
        for (let i = 0; i < chat_messages.length - 1; i++) {
          const msg = chat_messages[i];
          if (msg.role === 'user') {
            await session.prompt(msg.content);
          }
        }

        // Get the last user message
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

          // Check for tool calls
          if (this.handler.has_tool_calls(response)) {
            const tool_calls = this.handler.parse_tool_calls(response);

            if (tool_calls.length === 0) {
              final_response = response;
              break;
            }

            // Execute tool calls
            const results = [];
            for (const call of tool_calls) {
              try {
                const result = await this.mcp_manager.call_tool(
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

            // Format results and continue
            const formatted_results = results
              .map((r) => this.handler.format_tool_result(r.name, r.result))
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
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });

          // Stream the response
          const words = final_response.split(' ');
          for (let i = 0; i < words.length; i++) {
            const chunk = i === 0 ? words[i] : ' ' + words[i];
            const data = {
              id: completion_id,
              object: 'chat.completion.chunk',
              created,
              model: this.config.model,
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

          // Final chunk
          const final_data = {
            id: completion_id,
            object: 'chat.completion.chunk',
            created,
            model: this.config.model,
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
            model: this.config.model,
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
        // Dispose context to free resources
        await context.dispose();
      }
    };

    // Queue this request
    this.request_queue = this.request_queue.then(do_request).catch(do_request);
    await this.request_queue;
  }

  /**
   * Build the model info object used across multiple endpoints
   */
  get_model_info() {
    return {
      name: this.config.model,
      model: this.config.model,
      modified_at: new Date().toISOString(),
      size: 0,
      digest:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      details: {
        parent_model: '',
        format: 'gguf',
        family: this.model_type,
        families: [this.model_type],
        parameter_size: '',
        quantization_level: ''
      }
    };
  }

  /**
   * Handle HTTP requests
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

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    try {
      // GET / or HEAD / - health check (Ollama returns plain text)
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

      // GET /api/tags - list models
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        send_json(res, 200, {
          models: [this.get_model_info()]
        });
        return;
      }

      // GET /api/version
      if (req.method === 'GET' && url.pathname === '/api/version') {
        send_json(res, 200, { version: '0.6.2' });
        return;
      }

      // GET /api/ps - list running models
      if (req.method === 'GET' && url.pathname === '/api/ps') {
        send_json(res, 200, {
          models: [
            {
              name: this.config.model,
              model: this.config.model,
              size: 0,
              digest:
                'sha256:0000000000000000000000000000000000000000000000000000000000000000',
              expires_at: new Date(Date.now() + 300_000).toISOString(),
              size_vram: 0
            }
          ]
        });
        return;
      }

      // POST /api/show - model details
      if (req.method === 'POST' && url.pathname === '/api/show') {
        const body = await read_json_body(req);
        debug_log('api/show body:', JSON.stringify(body));
        send_json(res, 200, {
          license: '',
          modelfile: `FROM ${this.config.model_path || 'unknown'}`,
          parameters: `num_ctx ${this.config.context_size}`,
          template: '',
          details: {
            parent_model: '',
            format: 'gguf',
            family: this.model_type,
            families: [this.model_type],
            parameter_size: '',
            quantization_level: ''
          },
          model_info: {},
          modified_at: new Date().toISOString()
        });
        return;
      }

      // POST /api/chat
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await read_json_body(req);
        debug_log(
          'api/chat body:',
          `model=${body.model} stream=${body.stream} messages=${body.messages?.length}`
        );
        const { messages, tools, stream = true } = body;

        if (!messages || !Array.isArray(messages)) {
          send_json(res, 400, { error: 'messages array required' });
          return;
        }

        await this.handle_chat(messages, tools, stream, res);
        return;
      }

      // POST /api/generate (simple completion)
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const body = await read_json_body(req);
        debug_log(
          'api/generate body:',
          `model=${body.model} stream=${body.stream}`
        );
        const { prompt, stream = true } = body;

        if (!prompt) {
          send_json(res, 400, { error: 'prompt required' });
          return;
        }

        // Convert to chat format
        await this.handle_chat(
          [{ role: 'user', content: prompt }],
          null,
          stream,
          res
        );
        return;
      }

      // OpenAI-compatible endpoint
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await read_json_body(req);
        debug_log(
          'v1/chat/completions body:',
          `model=${body.model} stream=${body.stream} messages=${body.messages?.length}`
        );
        const { messages, tools, stream = false } = body;

        if (!messages || !Array.isArray(messages)) {
          send_json(res, 400, { error: 'messages array required' });
          return;
        }

        await this.handle_chat_openai(messages, tools, stream, res);
        return;
      }

      // OpenAI models endpoint
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        send_json(res, 200, {
          object: 'list',
          data: [
            {
              id: this.config.model,
              object: 'model',
              created: Date.now(),
              owned_by: 'local'
            }
          ]
        });
        return;
      }

      // 404 for unknown routes
      console.log(`  [404] No handler for ${req.method} ${url.pathname}`);
      send_json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error(`  [ERROR] ${error.message}`);
      send_json(res, 500, { error: error.message });
    }
  }

  /**
   * Start the server
   */
  async start() {
    await this.initialize();

    const server = createServer((req, res) => {
      this.handle_request(req, res);
    });

    server.listen(this.port, this.host, () => {
      console.log(
        `\nOllama-compatible server running at http://${this.host}:${this.port}`
      );
      console.log(`Model: ${this.config.model}`);
      console.log(
        `Tools: ${this.tools.map((t) => t.name).join(', ') || 'none'}`
      );
      console.log('\nEndpoints:');
      console.log('  Ollama API:');
      console.log(`    POST /api/chat     - Chat completions`);
      console.log(`    POST /api/generate - Text generation`);
      console.log(`    GET  /api/tags     - List models`);
      console.log(`    GET  /api/version  - Server version`);
      console.log('  OpenAI API:');
      console.log(`    POST /v1/chat/completions - Chat completions`);
      console.log(`    GET  /v1/models           - List models`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      try {
        if (this.model) await this.model.dispose();
        if (this.llama) await this.llama.dispose();
      } catch (e) {}
      await this.mcp_manager.disconnect_all();
      console.log('Goodbye!');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Main
async function main() {
  const { config_path, port, host, debug } = parse_args();
  DEBUG = debug;

  console.log('='.repeat(50));
  console.log('  Ollama-compatible MCP Server');
  console.log('='.repeat(50));
  if (DEBUG) {
    console.log('  Debug mode: ON');
  }
  console.log('');

  let config;
  try {
    config = load_config(config_path);
  } catch (error) {
    console.error(`Failed to load configuration: ${error.message}`);
    process.exit(1);
  }

  if (!config.model_path) {
    console.error('Error: model_path is required in configuration');
    process.exit(1);
  }

  const server = new OllamaServer(config, port, host);
  await server.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
