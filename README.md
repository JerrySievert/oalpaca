# O'Alpaca - an LLM Host

![An Irish Alpaca next to a pot of gold with a rainbow behind it](images/logo.jpg "O'Alpaca")

A CLI and HTTP server that connects local LLM models (via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)) with [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers, giving your locally-running models the ability to use tools. Presents itself as Ollama for compatibility with Ollama-compatible clients.

Supports **Qwen3**, **Llama 3.2**, and **Granite 3.2** models out of the box with automatic model detection and the correct tool-calling format for each family.

## Features

- **Multiple named models** -- configure as many models as you want, each with their own system prompt, MCP servers, and friendly name (e.g. "baseball", "assistant")
- **Interactive CLI chat** with tool use
- **Ollama-compatible HTTP server** (`/api/chat`, `/api/generate`, `/api/tags`, `/api/ps`, `/api/show`) and **OpenAI-compatible endpoints** (`/v1/chat/completions`, `/v1/models`)
- **MCP tool integration** -- connect any MCP server and the model can call its tools automatically
- **Memory-aware model management** -- LRU eviction with VRAM estimation so multiple models can share limited GPU memory
- **Fair request scheduling** -- batches same-model requests to minimize load/unload cycles, with streaming heartbeats while requests wait in queue
- **Bearer token authentication** -- optionally restrict access with per-token model visibility
- **Multi-model support** -- auto-detects Qwen3 (Hermes-style), Llama 3.2 (Pythonic), and Granite 3.2 tool-calling formats
- **Tool call resilience** -- detects repeated identical tool calls and breaks out of loops, provides parameter guidance on failed/empty results
- **Automatic time awareness** -- current date and time are appended to the system prompt so models can answer time-sensitive questions
- Hardware-accelerated inference via Metal (macOS), CUDA, and Vulkan

## Prerequisites

- **Node.js** >= 18
- A **GGUF model file** (see [Downloading Models](#downloading-models) below)

## Installation

```bash
git clone https://github.com/jerrysievert/oalpaca
cd oalpaca
npm install
```

`node-llama-cpp` ships pre-built binaries for macOS (Metal), Linux, and Windows and will automatically use GPU acceleration where available.

## Downloading Models

This project runs GGUF-format models locally. You can download them from [Hugging Face](https://huggingface.co). The recommended way is with the Hugging Face CLI, but you can also download files directly from the browser.

### Install the Hugging Face CLI (optional)

```bash
pip install huggingface_hub[hf_xfer]
```

### Llama 3.2

Quantized GGUF files for Llama 3.2 are available from community repos on Hugging Face.

**3B Instruct (Q4_K_M, ~2 GB) -- recommended starting point:**

```bash
hf download bartowski/Llama-3.2-3B-Instruct-GGUF \
  Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --local-dir ./models
```

**1B Instruct (Q4_K_M, ~0.8 GB) -- lighter weight:**

```bash
hf download bartowski/Llama-3.2-1B-Instruct-GGUF \
  Llama-3.2-1B-Instruct-Q4_K_M.gguf \
  --local-dir ./models
```

### Qwen3

Quantized GGUF files for Qwen3 are available from the official Qwen org and community repos.

**8B (Q4_K_M, ~5 GB) -- best balance of quality and speed:**

```bash
hf download Qwen/Qwen3-8B-GGUF \
  Qwen3-8B-Q4_K_M.gguf \
  --local-dir ./models
```

**4B (Q4_K_M, ~2.6 GB) -- lighter alternative:**

```bash
hf download Qwen/Qwen3-4B-GGUF \
  Qwen3-4B-Q4_K_M.gguf \
  --local-dir ./models
```

**1.7B (Q8_0, ~1.8 GB) -- smallest:**

```bash
hf download Qwen/Qwen3-1.7B-GGUF \
  Qwen3-1.7B-Q8_0.gguf \
  --local-dir ./models
```

### Granite 3.2

```bash
hf download lmstudio-community/granite-3.2-8b-instruct-GGUF \
  granite-3.2-8b-instruct-Q4_K_M.gguf \
  --local-dir ./models
```

> **Tip:** Q4_K_M is a good default quantization -- it offers a strong balance between quality and file size. Use Q5_K_M or Q6_K for higher quality at the cost of more RAM, or Q3_K_M for smaller files.

## Configuration

Create a `config.json` in the project root. Each key under `models` is the name that clients will see (e.g. in the Ollama model picker). You can use any name you like -- it does not need to match the model filename.

```json
{
  "models": {
    "baseball": {
      "model_path": "./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
      "model_type": "llama3",
      "system_prompt_file": "./system_prompt.txt",
      "assistant_name": "Bob",
      "context_size": 32768,
      "mcp_servers": [
        {
          "name": "mlb",
          "transport": "stdio",
          "command": "node",
          "args": ["/path/to/mcp-server/index.js"]
        }
      ]
    },
    "assistant": {
      "model_path": "./models/Qwen3-8B-Q4_K_M.gguf",
      "system_prompt": "You are a helpful assistant.",
      "context_size": 8192,
      "mcp_servers": []
    }
  }
}
```

### Model Entry Options

Each entry under `models` supports the following fields:

| Field                | Type   | Required | Default       | Description                                                |
| -------------------- | ------ | -------- | ------------- | ---------------------------------------------------------- |
| `model_path`         | string | yes      |               | Path to the GGUF model file                                |
| `model_type`         | string | no       | auto-detected | Explicit model type: `"qwen3"`, `"llama3"`, or `"granite"` |
| `system_prompt_file` | string | no       |               | Path to a text file containing the system prompt           |
| `system_prompt`      | string | no       |               | Inline system prompt (overridden by `system_prompt_file`)  |
| `assistant_name`     | string | no       | `"Assistant"` | Display name for the assistant                             |
| `context_size`       | number | no       | `8192`        | Context window size in tokens                              |
| `gpu_layers`         | number | no       |               | Number of layers to offload to GPU                         |
| `mcp_servers`        | array  | no       | `[]`          | MCP servers to connect to (see below)                      |

### Adding MCP Servers

Each entry in `mcp_servers` defines an MCP server to connect to. Tools from all connected servers are made available to that specific model.

**stdio transport** (local process):

```json
{
  "name": "my-server",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/mcp-server/index.js"],
  "cwd": "/path/to/mcp-server",
  "env": { "MY_VAR": "value" }
}
```

The `cwd` path is resolved relative to the config file directory. The `env` object is merged with `process.env` (your entries override system values).

**HTTP transport** (remote server):

```json
{
  "name": "remote-server",
  "transport": "http",
  "url": "http://localhost:3000/mcp"
}
```

### Model Detection

The model type controls which tool-calling format is used. It can be set explicitly with the `model_type` field (recommended when using friendly model names), or auto-detected from the model name:

| `model_type` value | Tool format                     | Auto-detected from name containing |
| ------------------ | ------------------------------- | ---------------------------------- |
| `qwen3`            | Hermes-style `<tool_call>` tags | `qwen`                             |
| `llama3`           | Pythonic `[func(arg=val)]`      | `llama`                            |
| `granite`          | Hermes-style `<tool_call>` tags | `granite`                          |

If no `model_type` is set and no keyword matches the model name, it defaults to `qwen3`.

> **Note:** When using friendly names like `"baseball"` that don't contain a model family keyword, you should set `model_type` explicitly so the correct tool format is used.

## Usage

### Interactive CLI

```bash
npm start
```

Or with a custom config path and model selection:

```bash
node src/index.js /path/to/config.json
```

When multiple models are configured, you can select which one to use by passing the model name as the second argument:

```bash
node src/index.js ./config.json baseball
```

If no model name is provided, the first model in `config.json` is used.

Once running, type your messages at the `You:` prompt. The model will automatically call tools when needed.

**Built-in commands:**

| Command  | Description              |
| -------- | ------------------------ |
| `/help`  | Show available commands  |
| `/tools` | List connected MCP tools |
| `/quit`  | Exit the chat            |
| `/exit`  | Exit the chat            |

### HTTP Server

Start an Ollama-compatible and OpenAI-compatible HTTP server:

```bash
npm run server
```

With options:

```bash
node src/server.js [options]
```

| Option                  | Default         | Description                  |
| ----------------------- | --------------- | ---------------------------- |
| `--config`, `-c`        | `./config.json` | Path to configuration file   |
| `--port`, `-p`          | `9000`          | Port to listen on            |
| `--host`, `-h`          | `0.0.0.0`       | Host to bind to              |
| `--debug`, `-d`         | off             | Enable verbose debug logging |
| `--require-token`, `-t` | off             | Require bearer token auth    |

**Example:**

```bash
node src/server.js --config ./config.json --port 9000 --debug --require-token
```

### API Endpoints

**Ollama-compatible endpoints:**

| Method   | Endpoint        | Description                                |
| -------- | --------------- | ------------------------------------------ |
| GET/HEAD | `/`             | Health check ("Ollama is running")         |
| POST     | `/api/chat`     | Chat completions (streaming/non-streaming) |
| POST     | `/api/generate` | Text generation                            |
| POST     | `/api/show`     | Model details                              |
| GET      | `/api/tags`     | List all configured models                 |
| GET      | `/api/ps`       | List currently loaded models               |
| GET      | `/api/version`  | Server version                             |

**OpenAI-compatible endpoints:**

| Method | Endpoint               | Description      |
| ------ | ---------------------- | ---------------- |
| POST   | `/v1/chat/completions` | Chat completions |
| GET    | `/v1/models`           | List models      |

> **Note:** Ollama endpoints (`/api/chat`, `/api/generate`) default to `stream: true`. OpenAI endpoints (`/v1/chat/completions`) default to `stream: false`. Pass `"stream": true` or `"stream": false` explicitly to override.

**Example -- curl with the Ollama API:**

```bash
curl http://localhost:9000/api/chat -d '{
  "model": "baseball",
  "messages": [{"role": "user", "content": "How is Julio Rodriguez doing this season?"}],
  "stream": false
}'
```

**Example -- curl with the OpenAI API:**

```bash
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "assistant",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Multi-Model Management

The server can serve multiple models simultaneously. Models are loaded into memory on demand and managed with LRU (least recently used) eviction.

### How It Works

- **On-demand loading** -- models are loaded when a request arrives for them, not at startup. Only GGUF metadata is read at startup for memory estimation.
- **LRU eviction** -- when a new model needs to be loaded and the cap is reached (default: 3 loaded models), the least recently used model with no active requests is unloaded.
- **Memory-aware** -- before loading, the server estimates VRAM requirements using `GgufInsights` and checks available VRAM via `getVramState()`. If there isn't enough memory, models are evicted until there is.
- **Active context protection** -- models with in-flight requests cannot be evicted.

### Request Scheduling

When multiple requests arrive for different models, the scheduler uses a fair batching algorithm:

1. **Prefer loaded models** -- requests for models already in memory are served first to avoid expensive load/unload cycles.
2. **Batch same-model requests** -- once a model is being served, all queued requests for that model are drained before switching.
3. **FIFO tie-breaking** -- among candidates with equal priority, the earliest queued request wins.
4. **Streaming heartbeats** -- clients waiting in the queue receive empty NDJSON chunks every 3 seconds so their connections don't timeout.
5. **Disconnect pruning** -- if a client disconnects while waiting, their request is removed from the queue.

### Tool Call Resilience

The server includes safeguards to prevent models from getting stuck in tool-calling loops:

- **Loop detection** -- if the model makes the same tool call (same name and arguments) 3 times in a row, the server breaks out and returns a user-friendly message.
- **Parameter guidance** -- when a tool call fails or returns empty results, the server injects the tool's parameter schema into the context so the model can self-correct.
- **Iteration limit** -- each request is capped at 10 tool call iterations. If the limit is reached, the server stops and explains that the request was too complex.

### Operational Limits

| Limit               | Value  | Description                                        |
| ------------------- | ------ | -------------------------------------------------- |
| Max loaded models   | 3      | Maximum models held in memory simultaneously       |
| Max tool iterations | 10     | Maximum tool call rounds per request               |
| VRAM safety reserve | 512 MB | Memory buffer kept free when estimating model fit  |
| Heartbeat interval  | 3s     | Frequency of keep-alive chunks for queued requests |

## Bearer Token Authentication

The server supports optional bearer token authentication to control which clients can access which models. This is compatible with clients that support Ollama bearer tokens (e.g. [Enchanted](https://github.com/AugustDev/enchanted)).

### Setting Up Tokens

Use the token CLI tool to manage tokens:

```bash
# Create a token that can access the "baseball" and "assistant" models
npm run tokens -- create --note "Jerry's iPad" --models baseball,assistant

# Create a token with access to only one model
npm run tokens -- create --note "Living room Mac" --models baseball

# List all tokens
npm run tokens -- list

# Update a token's allowed models
npm run tokens -- update <token> --models baseball,assistant

# Update a token's note
npm run tokens -- update <token> --note "Kitchen Mac"

# Revoke a token
npm run tokens -- revoke <token>
```

Tokens are stored in `tokens.json` alongside your `config.json`. Each token is a random 64-character hex string. The file format is:

```json
{
  "tokens": {
    "a1b2c3...64chars": {
      "note": "Jerry's iPad",
      "models": ["baseball", "assistant"],
      "created_at": "2026-02-12T00:00:00.000Z"
    }
  }
}
```

### Starting the Server with Auth

```bash
node src/server.js --require-token
```

When `--require-token` is enabled:

- All endpoints except health check (`GET /`, `HEAD /`), version (`GET /api/version`), and CORS preflight (`OPTIONS`) require a valid `Authorization: Bearer <token>` header.
- Model list endpoints (`/api/tags`, `/api/ps`, `/v1/models`) only show models the token is authorized to access.
- Request endpoints (`/api/chat`, `/api/generate`, `/api/show`, `/v1/chat/completions`) return 403 if the requested model is not in the token's allowed list.
- Missing or invalid tokens receive a 401 response.

Without `--require-token` (the default), the server operates with no authentication -- all endpoints are open and all models are visible.

### Client Configuration

In Enchanted (or any Ollama-compatible client that supports bearer tokens), set the bearer token in the connection settings. The client will then only see the models assigned to that token.

## Project Structure

```
llama-mcp-host/
├── config.json                # Multi-model configuration
├── tokens.json                # Bearer token store (auto-created by CLI)
├── system_prompt.txt          # System prompt (referenced by model entries)
├── models/                    # GGUF model files (git-ignored)
├── src/
│   ├── index.js               # CLI entry point
│   ├── server.js              # HTTP server entry point
│   ├── server_core.js         # HTTP server class & utilities (testable, no side effects)
│   ├── config.js              # Configuration loader & validation
│   ├── model_manager.js       # Model lifecycle, LRU eviction, memory estimation
│   ├── request_scheduler.js   # Fair batching queue with streaming heartbeat
│   ├── token_manager.js       # Bearer token CRUD operations
│   ├── token_cli.js           # CLI tool for managing tokens
│   ├── mcp_client.js          # MCP server connection manager
│   ├── chat_controller.js     # CLI conversation loop & tool execution
│   └── model_handlers/
│       ├── index.js           # Handler factory
│       ├── qwen3.js           # Qwen3 tool format (Hermes-style)
│       ├── llama3.js          # Llama 3.2 tool format (Pythonic)
│       └── granite.js         # Granite 3.2 tool format
├── tests/                     # Vitest test suite
└── package.json
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              CLI (index.js) / HTTP Server (server.js)       │
│                                                             │
│  Bearer Token Auth (--require-token)                        │
│  - Validates Authorization: Bearer <token>                  │
│  - Filters model visibility per token                       │
├─────────────────────────────────────────────────────────────┤
│                    Request Scheduler                        │
│  - Fair batching queue                                      │
│  - Streaming heartbeat while queued                         │
│  - Prefers loaded models to minimize swaps                  │
├─────────────────────────────────────────────────────────────┤
│                     Model Manager                           │
│  - LRU eviction with VRAM estimation                        │
│  - Per-model MCP connections and tools                      │
│  - Active context tracking                                  │
├──────────────────────┬──────────────────┬───────────────────┤
│   Qwen3 Handler      │  Llama3 Handler  │  Granite Handler  │
│   <tool_call> tags   │  [func()] syntax │  <tool_call> tags │
├──────────────────────┴──────────────────┴───────────────────┤
│                      MCP Client Manager                     │
│  - Per-model server connections (stdio & HTTP)              │
│  - Tool schema conversion per model format                  │
│  - Tool call execution and result formatting                │
└─────────────────────────────────────────────────────────────┘
```

## npm Scripts

| Script                  | Command                 | Description                    |
| ----------------------- | ----------------------- | ------------------------------ |
| `npm start`             | `node src/index.js`     | Start the interactive CLI      |
| `npm run server`        | `node src/server.js`    | Start the HTTP server          |
| `npm run tokens`        | `node src/token_cli.js` | Manage bearer tokens           |
| `npm test`              | `vitest run`            | Run the test suite             |
| `npm run test:coverage` | `vitest run --coverage` | Run tests with coverage report |

## Development

### Running Tests

The project uses [Vitest](https://vitest.dev/) for testing. All source modules have corresponding test files in the `tests/` directory.

```bash
# Run all tests
npm test

# Run tests with V8 coverage report
npm run test:coverage

# Run a specific test file
npx vitest run tests/server_core.test.js

# Run in watch mode during development
npx vitest
```

Tests mock `node-llama-cpp` and MCP SDK modules so they run without GPU hardware or model files.

## Dependencies

| Package                     | Purpose                         |
| --------------------------- | ------------------------------- |
| `node-llama-cpp`            | llama.cpp Node.js bindings      |
| `@modelcontextprotocol/sdk` | MCP client SDK                  |
| `zod`                       | Configuration schema validation |

### Dev Dependencies

| Package               | Purpose                   |
| --------------------- | ------------------------- |
| `vitest`              | Test runner               |
| `@vitest/coverage-v8` | V8 code coverage provider |

## License

MIT
