import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock node-llama-cpp so execute_chat / execute_chat_openai can work
const mock_llama_session = {
  prompt: vi.fn().mockResolvedValue('Hello from the model!')
};

vi.mock('node-llama-cpp', () => ({
  LlamaChatSession: vi.fn(function () {
    return mock_llama_session;
  })
}));
import {
  parse_args,
  read_json_body,
  send_json,
  send_chunk,
  set_debug,
  debug_log,
  OllamaServer
} from '../src/server_core.js';

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function make_req(method, url, body = null, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;

  // Simulate body delivery after a tick
  if (body !== null) {
    process.nextTick(() => {
      req.emit('data', JSON.stringify(body));
      req.emit('end');
    });
  } else if (method === 'POST') {
    // POST with no body — emit end immediately
    process.nextTick(() => req.emit('end'));
  }

  return req;
}

function make_res() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(function (status, hdrs) {
      this.statusCode = status;
      this.headers = hdrs || {};
      this.headersSent = true;
    }),
    write: vi.fn(function (data) {
      this.body += data;
    }),
    end: vi.fn(function (data) {
      if (data) this.body += data;
      this.writableEnded = true;
    })
  };
  // Bind functions so `this` works
  res.writeHead = res.writeHead.bind(res);
  res.write = res.write.bind(res);
  res.end = res.end.bind(res);
  return res;
}

function make_model_manager(overrides = {}) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    get_model_names: vi.fn().mockReturnValue(['llama3:3b', 'qwen3:8b']),
    has_model: vi.fn((name) => ['llama3:3b', 'qwen3:8b'].includes(name)),
    get_all_model_info: vi.fn((allowed) => {
      const all = [
        {
          name: 'llama3:3b',
          model: 'llama3:3b',
          size: 1000,
          details: { format: 'gguf', family: 'llama3' }
        },
        {
          name: 'qwen3:8b',
          model: 'qwen3:8b',
          size: 2000,
          details: { format: 'gguf', family: 'qwen3' }
        }
      ];
      if (allowed) return all.filter((m) => allowed.includes(m.name));
      return all;
    }),
    get_running_model_info: vi.fn((allowed) => {
      const running = [{ name: 'llama3:3b', model: 'llama3:3b', size: 1000 }];
      if (allowed) return running.filter((m) => allowed.includes(m.name));
      return running;
    }),
    get_model_details: vi.fn((name) => {
      if (name === 'llama3:3b')
        return { details: { family: 'llama3' }, parameters: 'num_ctx 4096' };
      return null;
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function make_scheduler(overrides = {}) {
  return {
    submit: vi.fn(async (model_name, execute_fn, res, stream) => {
      // Execute immediately with a mock entry
      await execute_fn({
        name: model_name,
        config: { context_size: 4096, system_prompt: '' },
        handler: {
          format_tools_for_prompt: vi.fn().mockReturnValue(''),
          has_tool_calls: vi.fn().mockReturnValue(false),
          parse_tool_calls: vi.fn().mockReturnValue([])
        },
        tools: [],
        mcp_manager: { call_tool: vi.fn() },
        model: {
          createContext: vi.fn().mockResolvedValue({
            getSequence: vi.fn().mockReturnValue({}),
            dispose: vi.fn().mockResolvedValue(undefined)
          })
        }
      });
    }),
    ...overrides
  };
}

function make_server(opts = {}) {
  const config = { models: { 'llama3:3b': {}, 'qwen3:8b': {} } };
  const model_manager = opts.model_manager || make_model_manager();
  const scheduler = opts.scheduler || make_scheduler();
  const token_store = opts.token_store || { tokens: {} };
  const require_token = opts.require_token || false;

  return new OllamaServer(config, 9000, '0.0.0.0', {
    require_token,
    token_store,
    model_manager,
    scheduler
  });
}

// ────────────────────────────────────────────
// Tests for utility functions
// ────────────────────────────────────────────

describe('parse_args', () => {
  it('returns defaults when no args', () => {
    const result = parse_args([]);
    expect(result.config_path).toBe('./config.json');
    expect(result.port).toBe(9000);
    expect(result.host).toBe('0.0.0.0');
    expect(result.debug).toBe(false);
    expect(result.require_token).toBe(false);
  });

  it('parses --config', () => {
    expect(parse_args(['--config', '/my/config.json']).config_path).toBe(
      '/my/config.json'
    );
  });

  it('parses -c short flag', () => {
    expect(parse_args(['-c', '/my/config.json']).config_path).toBe(
      '/my/config.json'
    );
  });

  it('parses --port', () => {
    expect(parse_args(['--port', '8080']).port).toBe(8080);
  });

  it('parses -p short flag', () => {
    expect(parse_args(['-p', '3000']).port).toBe(3000);
  });

  it('parses --host', () => {
    expect(parse_args(['--host', '127.0.0.1']).host).toBe('127.0.0.1');
  });

  it('parses -h short flag', () => {
    expect(parse_args(['-h', 'localhost']).host).toBe('localhost');
  });

  it('parses --debug', () => {
    expect(parse_args(['--debug']).debug).toBe(true);
  });

  it('parses -d short flag', () => {
    expect(parse_args(['-d']).debug).toBe(true);
  });

  it('parses --require-token', () => {
    expect(parse_args(['--require-token']).require_token).toBe(true);
  });

  it('parses -t short flag', () => {
    expect(parse_args(['-t']).require_token).toBe(true);
  });

  it('parses multiple args together', () => {
    const result = parse_args(['-p', '8080', '-d', '-t', '--config', 'c.json']);
    expect(result.port).toBe(8080);
    expect(result.debug).toBe(true);
    expect(result.require_token).toBe(true);
    expect(result.config_path).toBe('c.json');
  });
});

describe('read_json_body', () => {
  it('parses valid JSON body', async () => {
    const req = make_req('POST', '/', { hello: 'world' });
    const body = await read_json_body(req);
    expect(body).toEqual({ hello: 'world' });
  });

  it('rejects on invalid JSON', async () => {
    const req = new EventEmitter();
    process.nextTick(() => {
      req.emit('data', 'not json{{{');
      req.emit('end');
    });
    await expect(read_json_body(req)).rejects.toThrow('Invalid JSON');
  });

  it('rejects on request error', async () => {
    const req = new EventEmitter();
    process.nextTick(() => {
      req.emit('error', new Error('connection reset'));
    });
    await expect(read_json_body(req)).rejects.toThrow('connection reset');
  });
});

describe('send_json', () => {
  it('sends JSON with correct headers', () => {
    const res = make_res();
    send_json(res, 200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('sends error status codes', () => {
    const res = make_res();
    send_json(res, 404, { error: 'Not found' });
    expect(res.statusCode).toBe(404);
  });
});

describe('send_chunk', () => {
  it('writes NDJSON line', () => {
    const res = make_res();
    send_chunk(res, { data: 'test' });
    expect(res.body).toBe('{"data":"test"}\n');
  });
});

describe('debug_log', () => {
  it('logs nothing when debug is off', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    set_debug(false);
    debug_log('should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs when debug is on', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    set_debug(true);
    debug_log('test message');
    expect(spy).toHaveBeenCalled();
    set_debug(false);
    spy.mockRestore();
  });
});

// ────────────────────────────────────────────
// Tests for OllamaServer
// ────────────────────────────────────────────

describe('OllamaServer', () => {
  let server;
  let model_manager;
  let scheduler;

  beforeEach(() => {
    model_manager = make_model_manager();
    scheduler = make_scheduler();
    server = make_server({ model_manager, scheduler });
  });

  describe('extract_token', () => {
    it('extracts bearer token', () => {
      const req = { headers: { authorization: 'Bearer abc123' } };
      expect(server.extract_token(req)).toBe('abc123');
    });

    it('returns null for missing header', () => {
      const req = { headers: {} };
      expect(server.extract_token(req)).toBeNull();
    });

    it('returns null for non-bearer auth', () => {
      const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
      expect(server.extract_token(req)).toBeNull();
    });

    it('is case-insensitive for Bearer keyword', () => {
      const req = { headers: { authorization: 'bearer abc123' } };
      expect(server.extract_token(req)).toBe('abc123');
    });
  });

  describe('authenticate', () => {
    it('returns null when no token provided and require_token is false', () => {
      const req = { headers: {} };
      const res = make_res();
      expect(server.authenticate(req, res)).toBeNull();
    });

    it('returns 401 when token is missing and required', () => {
      server.require_token = true;
      const req = { headers: {} };
      const res = make_res();
      expect(server.authenticate(req, res)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for invalid token when required', () => {
      server.require_token = true;
      server.token_store = { tokens: {} };
      const req = { headers: { authorization: 'Bearer invalid' } };
      const res = make_res();
      expect(server.authenticate(req, res)).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('returns allowed models for valid token when required', () => {
      server.require_token = true;
      server.token_store = {
        tokens: {
          valid_token: { models: ['llama3:3b'], note: '', created_at: '' }
        }
      };
      const req = { headers: { authorization: 'Bearer valid_token' } };
      const res = make_res();
      const result = server.authenticate(req, res);
      expect(result).toEqual(['llama3:3b']);
    });

    it('filters models when token provided without require_token', () => {
      server.require_token = false;
      server.token_store = {
        tokens: {
          vol_token: { models: ['llama3:3b'], note: '', created_at: '' }
        }
      };
      const req = { headers: { authorization: 'Bearer vol_token' } };
      const res = make_res();
      const result = server.authenticate(req, res);
      expect(result).toEqual(['llama3:3b']);
    });

    it('returns null for invalid token without require_token', () => {
      server.require_token = false;
      server.token_store = { tokens: {} };
      const req = { headers: { authorization: 'Bearer bad_token' } };
      const res = make_res();
      const result = server.authenticate(req, res);
      expect(result).toBeNull();
    });
  });

  describe('build_system_prompt', () => {
    it('returns base system prompt with date/time when no tools', () => {
      const entry = {
        config: { system_prompt: 'You are helpful.' },
        tools: [],
        handler: { format_tools_for_prompt: vi.fn().mockReturnValue('') }
      };
      const result = server.build_system_prompt(entry, null);
      expect(result).toContain('You are helpful.');
      expect(result).toMatch(/Current date and time: \w+, \w+ \d+, \d{4}/);
    });

    it('appends tool prompt after date/time when tools available', () => {
      const entry = {
        config: { system_prompt: 'Base.' },
        tools: [{ name: 'search' }],
        handler: {
          format_tools_for_prompt: vi
            .fn()
            .mockReturnValue('\n<tools>...</tools>')
        }
      };
      const result = server.build_system_prompt(entry, null);
      expect(result).toContain('Base.');
      expect(result).toMatch(/Current date and time: \w+, \w+ \d+, \d{4}/);
      expect(result).toContain('<tools>...</tools>');
    });

    it('uses request_tools over model tools when provided', () => {
      const entry = {
        config: { system_prompt: '' },
        tools: [{ name: 'model_tool' }],
        handler: {
          format_tools_for_prompt: vi.fn().mockReturnValue('tools_prompt')
        }
      };
      const request_tools = [{ name: 'req_tool' }];
      server.build_system_prompt(entry, request_tools);
      expect(entry.handler.format_tools_for_prompt).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: 'req_tool' })])
      );
    });

    it('normalizes OpenAI-format tools', () => {
      const entry = {
        config: { system_prompt: '' },
        tools: [],
        handler: { format_tools_for_prompt: vi.fn().mockReturnValue('') }
      };
      const request_tools = [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object' }
          }
        }
      ];
      server.build_system_prompt(entry, request_tools);
      const normalized = entry.handler.format_tools_for_prompt.mock.calls[0][0];
      expect(normalized[0]).toEqual({
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object' }
      });
    });
  });

  describe('handle_request', () => {
    describe('health check', () => {
      it('GET / returns Ollama is running', async () => {
        const req = make_req('GET', '/');
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.body).toBe('Ollama is running');
        expect(res.statusCode).toBe(200);
      });

      it('HEAD / returns 200 with no body', async () => {
        const req = make_req('HEAD', '/');
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('');
      });
    });

    describe('OPTIONS (CORS)', () => {
      it('returns 204 with CORS headers', async () => {
        const req = make_req('OPTIONS', '/api/chat');
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(204);
      });
    });

    describe('GET /api/version', () => {
      it('returns version', async () => {
        const req = make_req('GET', '/api/version');
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.version).toBeDefined();
      });
    });

    describe('GET /api/tags', () => {
      it('returns all models', async () => {
        const req = make_req('GET', '/api/tags', null, {});
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.models).toHaveLength(2);
      });

      it('filters models when token auth is enabled', async () => {
        server.require_token = true;
        server.token_store = {
          tokens: {
            tok1: { models: ['llama3:3b'], note: '', created_at: '' }
          }
        };
        const req = make_req('GET', '/api/tags', null, {
          authorization: 'Bearer tok1'
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(model_manager.get_all_model_info).toHaveBeenCalledWith([
          'llama3:3b'
        ]);
      });
    });

    describe('GET /api/ps', () => {
      it('returns running models', async () => {
        const req = make_req('GET', '/api/ps', null, {});
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.models).toHaveLength(1);
      });
    });

    describe('POST /api/show', () => {
      it('returns model details', async () => {
        const req = make_req('POST', '/api/show', { name: 'llama3:3b' });
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.details.family).toBe('llama3');
      });

      it('returns 404 for unknown model', async () => {
        const req = make_req('POST', '/api/show', { name: 'unknown' });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(404);
      });

      it('returns 403 for unauthorized model', async () => {
        server.require_token = true;
        server.token_store = {
          tokens: {
            tok1: { models: ['qwen3:8b'], note: '', created_at: '' }
          }
        };
        const req = make_req(
          'POST',
          '/api/show',
          { name: 'llama3:3b' },
          {
            authorization: 'Bearer tok1'
          }
        );
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });
    });

    describe('POST /api/chat', () => {
      it('returns 400 when messages missing', async () => {
        const req = make_req('POST', '/api/chat', { model: 'llama3:3b' });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for unknown model', async () => {
        const req = make_req('POST', '/api/chat', {
          model: 'unknown',
          messages: [{ role: 'user', content: 'hi' }]
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(404);
      });

      it('returns 403 for unauthorized model', async () => {
        server.require_token = true;
        server.token_store = {
          tokens: { tok1: { models: ['qwen3:8b'], note: '', created_at: '' } }
        };
        const req = make_req(
          'POST',
          '/api/chat',
          {
            model: 'llama3:3b',
            messages: [{ role: 'user', content: 'hi' }]
          },
          { authorization: 'Bearer tok1' }
        );
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('submits to scheduler for valid request', async () => {
        // Use a scheduler that doesn't actually call execute_fn
        scheduler.submit = vi.fn().mockResolvedValue(undefined);

        const req = make_req('POST', '/api/chat', {
          model: 'llama3:3b',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(scheduler.submit).toHaveBeenCalledWith(
          'llama3:3b',
          expect.any(Function),
          res,
          false
        );
      });
    });

    describe('POST /api/generate', () => {
      it('returns 400 when prompt missing', async () => {
        const req = make_req('POST', '/api/generate', { model: 'llama3:3b' });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for unknown model', async () => {
        const req = make_req('POST', '/api/generate', {
          model: 'unknown',
          prompt: 'hello'
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(404);
      });

      it('submits to scheduler for valid request', async () => {
        scheduler.submit = vi.fn().mockResolvedValue(undefined);

        const req = make_req('POST', '/api/generate', {
          model: 'llama3:3b',
          prompt: 'Why is the sky blue?',
          stream: false
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(scheduler.submit).toHaveBeenCalledWith(
          'llama3:3b',
          expect.any(Function),
          res,
          false
        );
      });
    });

    describe('POST /v1/chat/completions', () => {
      it('returns 400 when messages missing', async () => {
        const req = make_req('POST', '/v1/chat/completions', {
          model: 'llama3:3b'
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for unknown model', async () => {
        const req = make_req('POST', '/v1/chat/completions', {
          model: 'unknown',
          messages: [{ role: 'user', content: 'hi' }]
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(404);
      });

      it('submits to scheduler for valid request', async () => {
        scheduler.submit = vi.fn().mockResolvedValue(undefined);

        const req = make_req('POST', '/v1/chat/completions', {
          model: 'llama3:3b',
          messages: [{ role: 'user', content: 'hi' }]
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(scheduler.submit).toHaveBeenCalled();
      });
    });

    describe('GET /v1/models', () => {
      it('returns OpenAI-format model list', async () => {
        const req = make_req('GET', '/v1/models', null, {});
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.object).toBe('list');
        expect(body.data).toHaveLength(2);
        expect(body.data[0].object).toBe('model');
      });

      it('filters models by token', async () => {
        server.require_token = true;
        server.token_store = {
          tokens: { tok1: { models: ['qwen3:8b'], note: '', created_at: '' } }
        };
        const req = make_req('GET', '/v1/models', null, {
          authorization: 'Bearer tok1'
        });
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].id).toBe('qwen3:8b');
      });
    });

    describe('404 handling', () => {
      it('returns 404 for unknown routes', async () => {
        const req = make_req('GET', '/api/unknown');
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(404);
      });
    });

    describe('trailing slash normalization', () => {
      it('handles trailing slash on routes', async () => {
        const req = make_req('GET', '/api/version/');
        const res = make_res();
        await server.handle_request(req, res);
        const body = JSON.parse(res.body);
        expect(body.version).toBeDefined();
      });
    });

    describe('error handling', () => {
      it('returns 500 on handler errors without crashing', async () => {
        // Simulate scheduler throwing
        scheduler.submit = vi
          .fn()
          .mockRejectedValue(new Error('scheduler boom'));
        const req = make_req('POST', '/api/chat', {
          model: 'llama3:3b',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false
        });
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(500);
      });

      it('returns 500 on unexpected error', async () => {
        model_manager.get_all_model_info.mockImplementation(() => {
          throw new Error('unexpected');
        });
        const req = make_req('GET', '/api/tags', null, {});
        const res = make_res();
        await server.handle_request(req, res);
        expect(res.statusCode).toBe(500);
      });
    });

    describe('require_token strict mode', () => {
      let guarded_server;

      beforeEach(() => {
        guarded_server = make_server({
          model_manager,
          scheduler,
          require_token: true,
          token_store: {
            tokens: {
              valid_tok: { models: ['llama3:3b'], note: '', created_at: '' }
            }
          }
        });
      });

      it('returns 403 for GET / without token', async () => {
        const req = make_req('GET', '/');
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('returns 403 for HEAD / without token', async () => {
        const req = make_req('HEAD', '/');
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('returns 403 for GET /api/tags without token', async () => {
        const req = make_req('GET', '/api/tags', null, {});
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('returns 403 for GET /api/version without token', async () => {
        const req = make_req('GET', '/api/version');
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('returns 403 for POST /api/chat without token', async () => {
        const req = make_req('POST', '/api/chat', {
          model: 'llama3:3b',
          messages: [{ role: 'user', content: 'hi' }]
        });
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('returns 403 for invalid token', async () => {
        const req = make_req('GET', '/', null, {
          authorization: 'Bearer wrong_token'
        });
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
      });

      it('allows OPTIONS without token (CORS preflight)', async () => {
        const req = make_req('OPTIONS', '/api/chat');
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(204);
      });

      it('allows GET / with valid token', async () => {
        const req = make_req('GET', '/', null, {
          authorization: 'Bearer valid_tok'
        });
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('Ollama is running');
      });

      it('allows GET /api/version with valid token', async () => {
        const req = make_req('GET', '/api/version', null, {
          authorization: 'Bearer valid_tok'
        });
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.version).toBeDefined();
      });

      it('allows HEAD / with valid token', async () => {
        const req = make_req('HEAD', '/', null, {
          authorization: 'Bearer valid_tok'
        });
        const res = make_res();
        await guarded_server.handle_request(req, res);
        expect(res.statusCode).toBe(200);
      });

      it('returns 403 for token with no matching configured models', async () => {
        const bad_models_server = make_server({
          model_manager,
          scheduler,
          require_token: true,
          token_store: {
            tokens: {
              mismatched: { models: ['nonexistent'], note: '', created_at: '' }
            }
          }
        });
        const req = make_req('GET', '/', null, {
          authorization: 'Bearer mismatched'
        });
        const res = make_res();
        await bad_models_server.handle_request(req, res);
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toContain('does not grant access');
      });
    });
  });

  describe('execute_chat', () => {
    let entry;

    beforeEach(() => {
      mock_llama_session.prompt
        .mockReset()
        .mockResolvedValue('Model response.');
      entry = {
        name: 'llama3:3b',
        config: { context_size: 4096, system_prompt: 'You are helpful.' },
        handler: {
          format_tools_for_prompt: vi.fn().mockReturnValue(''),
          has_tool_calls: vi.fn().mockReturnValue(false),
          parse_tool_calls: vi.fn().mockReturnValue([]),
          format_tool_result: vi.fn(
            (name, result) => `<result>${result}</result>`
          )
        },
        tools: [],
        mcp_manager: { call_tool: vi.fn().mockResolvedValue('tool result') },
        model: {
          createContext: vi.fn().mockResolvedValue({
            getSequence: vi.fn().mockReturnValue({}),
            dispose: vi.fn().mockResolvedValue(undefined)
          })
        }
      };
    });

    it('sends non-streaming response with model output', async () => {
      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'Hello' }],
        null,
        false,
        res
      );
      const body = JSON.parse(res.body);
      expect(body.message.role).toBe('assistant');
      expect(body.message.content).toBe('Model response.');
      expect(body.done).toBe(true);
    });

    it('sends streaming response', async () => {
      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'Hello' }],
        null,
        true,
        res
      );
      // Should have written streaming headers
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/x-ndjson');
      // Should have multiple chunks written
      expect(res.writableEnded).toBe(true);
      // Parse the NDJSON lines
      const lines = res.body.trim().split('\n').map(JSON.parse);
      const final = lines[lines.length - 1];
      expect(final.done).toBe(true);
    });

    it('extracts system message from messages', async () => {
      const res = make_res();
      await server.execute_chat(
        entry,
        [
          { role: 'system', content: 'Custom system prompt' },
          { role: 'user', content: 'Hello' }
        ],
        null,
        false,
        res
      );
      const body = JSON.parse(res.body);
      expect(body.message.content).toBe('Model response.');
    });

    it('replays conversation history', async () => {
      const res = make_res();
      await server.execute_chat(
        entry,
        [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First reply' },
          { role: 'user', content: 'Second message' }
        ],
        null,
        false,
        res
      );
      // prompt should have been called twice: once for history replay, once for final
      expect(mock_llama_session.prompt).toHaveBeenCalledTimes(2);
      expect(mock_llama_session.prompt).toHaveBeenCalledWith('First message');
      expect(mock_llama_session.prompt).toHaveBeenCalledWith('Second message');
    });

    it('throws when last message is not from user', async () => {
      const res = make_res();
      await expect(
        server.execute_chat(
          entry,
          [{ role: 'assistant', content: 'oops' }],
          null,
          false,
          res
        )
      ).rejects.toThrow('Last message must be from user');
    });

    it('disposes context even on error', async () => {
      const dispose_fn = vi.fn().mockResolvedValue(undefined);
      entry.model.createContext.mockResolvedValue({
        getSequence: vi.fn().mockReturnValue({}),
        dispose: dispose_fn
      });

      const res = make_res();
      await expect(
        server.execute_chat(entry, [], null, false, res)
      ).rejects.toThrow();

      expect(dispose_fn).toHaveBeenCalled();
    });

    it('handles tool calls and re-prompts', async () => {
      let call_count = 0;
      mock_llama_session.prompt.mockImplementation(async () => {
        call_count++;
        if (call_count === 1) return '<tool_call>{"name":"search"}</tool_call>';
        return 'Final answer after tool use.';
      });

      entry.handler.has_tool_calls = vi.fn((text) =>
        text.includes('<tool_call>')
      );
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'search', arguments: { q: 'test' } }]);
      entry.tools = [
        { name: 'search', inputSchema: { properties: {}, required: [] } }
      ];

      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'search for something' }],
        null,
        false,
        res
      );

      expect(entry.mcp_manager.call_tool).toHaveBeenCalledWith('search', {
        q: 'test'
      });
      const body = JSON.parse(res.body);
      expect(body.message.content).toBe('Final answer after tool use.');
      expect(body.message.tool_calls).toHaveLength(1);
    });

    it('detects repeated tool call loops and breaks out', async () => {
      // Always returns the same tool call
      mock_llama_session.prompt.mockResolvedValue(
        '<tool_call>{"name":"loop"}</tool_call>'
      );
      entry.handler.has_tool_calls = vi.fn().mockReturnValue(true);
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'loop', arguments: { x: 1 } }]);
      entry.tools = [];

      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'loop test' }],
        null,
        false,
        res
      );

      const body = JSON.parse(res.body);
      expect(body.message.content).toContain('kept trying to call');
    });

    it('adds parameter guidance on empty tool results', async () => {
      let call_count = 0;
      mock_llama_session.prompt.mockImplementation(async () => {
        call_count++;
        if (call_count === 1) return '<tool_call>empty</tool_call>';
        return 'Final.';
      });

      entry.handler.has_tool_calls = vi.fn((text) =>
        text.includes('<tool_call>')
      );
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'search', arguments: {} }]);
      entry.mcp_manager.call_tool.mockResolvedValue('');
      entry.tools = [
        {
          name: 'search',
          inputSchema: {
            properties: { q: { type: 'string', description: 'query' } },
            required: ['q']
          }
        }
      ];

      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'test' }],
        null,
        false,
        res
      );

      // The formatted result passed to re-prompt should contain parameter guidance
      const re_prompt_input = mock_llama_session.prompt.mock.calls[1][0];
      expect(re_prompt_input).toContain('returned no results');
      expect(re_prompt_input).toContain('q');
    });

    it('handles tool call errors with parameter guidance', async () => {
      let call_count = 0;
      mock_llama_session.prompt.mockImplementation(async () => {
        call_count++;
        if (call_count === 1) return '<tool_call>fail</tool_call>';
        return 'After error.';
      });

      entry.handler.has_tool_calls = vi.fn((text) =>
        text.includes('<tool_call>')
      );
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'search', arguments: {} }]);
      entry.mcp_manager.call_tool.mockRejectedValue(new Error('tool failed'));
      entry.tools = [
        {
          name: 'search',
          inputSchema: {
            properties: { q: { type: 'string', description: 'query' } },
            required: ['q']
          }
        }
      ];

      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'test' }],
        null,
        false,
        res
      );

      const re_prompt_input = mock_llama_session.prompt.mock.calls[1][0];
      expect(re_prompt_input).toContain('failed');
    });

    it('stops with message when MAX_TOOL_ITERATIONS reached', async () => {
      // Always return tool calls
      mock_llama_session.prompt.mockResolvedValue(
        '<tool_call>forever</tool_call>'
      );
      entry.handler.has_tool_calls = vi.fn().mockReturnValue(true);
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'tool_a', arguments: { x: Math.random() } }]);
      // Make each call signature unique to avoid loop detection
      let counter = 0;
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockImplementation(() => [
          { name: 'tool_a', arguments: { x: counter++ } }
        ]);
      entry.tools = [];

      const res = make_res();
      await server.execute_chat(
        entry,
        [{ role: 'user', content: 'test' }],
        null,
        false,
        res
      );

      const body = JSON.parse(res.body);
      expect(body.message.content).toContain('too many tool calls');
    });
  });

  describe('execute_chat_openai', () => {
    let entry;

    beforeEach(() => {
      mock_llama_session.prompt
        .mockReset()
        .mockResolvedValue('OpenAI response.');
      entry = {
        name: 'llama3:3b',
        config: { context_size: 4096, system_prompt: 'You are helpful.' },
        handler: {
          format_tools_for_prompt: vi.fn().mockReturnValue(''),
          has_tool_calls: vi.fn().mockReturnValue(false),
          parse_tool_calls: vi.fn().mockReturnValue([]),
          format_tool_result: vi.fn(
            (name, result) => `<result>${result}</result>`
          )
        },
        tools: [],
        mcp_manager: { call_tool: vi.fn().mockResolvedValue('result') },
        model: {
          createContext: vi.fn().mockResolvedValue({
            getSequence: vi.fn().mockReturnValue({}),
            dispose: vi.fn().mockResolvedValue(undefined)
          })
        }
      };
    });

    it('sends non-streaming OpenAI format response', async () => {
      const res = make_res();
      await server.execute_chat_openai(
        entry,
        [{ role: 'user', content: 'Hello' }],
        null,
        false,
        res
      );

      const body = JSON.parse(res.body);
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.content).toBe('OpenAI response.');
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage).toBeDefined();
    });

    it('sends streaming OpenAI format response', async () => {
      const res = make_res();
      await server.execute_chat_openai(
        entry,
        [{ role: 'user', content: 'Hello' }],
        null,
        true,
        res
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.body).toContain('data: ');
      expect(res.body).toContain('[DONE]');
      expect(res.writableEnded).toBe(true);
    });

    it('extracts system message from messages', async () => {
      const res = make_res();
      await server.execute_chat_openai(
        entry,
        [
          { role: 'system', content: 'Custom system' },
          { role: 'user', content: 'Hello' }
        ],
        null,
        false,
        res
      );
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('OpenAI response.');
    });

    it('handles tool calls in OpenAI format', async () => {
      let call_count = 0;
      mock_llama_session.prompt.mockImplementation(async () => {
        call_count++;
        if (call_count === 1) return '<tool_call>{"name":"search"}</tool_call>';
        return 'Result after tools.';
      });

      entry.handler.has_tool_calls = vi.fn((text) =>
        text.includes('<tool_call>')
      );
      entry.handler.parse_tool_calls = vi
        .fn()
        .mockReturnValue([{ name: 'search', arguments: { q: 'test' } }]);

      const res = make_res();
      await server.execute_chat_openai(
        entry,
        [{ role: 'user', content: 'search' }],
        null,
        false,
        res
      );

      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('Result after tools.');
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].message.tool_calls[0].type).toBe('function');
    });

    it('throws when last message is not from user', async () => {
      const res = make_res();
      await expect(
        server.execute_chat_openai(
          entry,
          [{ role: 'assistant', content: 'oops' }],
          null,
          false,
          res
        )
      ).rejects.toThrow('Last message must be from user');
    });

    it('disposes context in finally block', async () => {
      const dispose_fn = vi.fn().mockResolvedValue(undefined);
      entry.model.createContext.mockResolvedValue({
        getSequence: vi.fn().mockReturnValue({}),
        dispose: dispose_fn
      });

      const res = make_res();
      await server.execute_chat_openai(
        entry,
        [{ role: 'user', content: 'hi' }],
        null,
        false,
        res
      );
      expect(dispose_fn).toHaveBeenCalled();
    });
  });
});
