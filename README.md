# llama-mcp-host

A CLI and HTTP server that connects local LLM models (via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)) with [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers, giving your locally-running models the ability to use tools.

Supports **Qwen3**, **Llama 3.2**, and **Granite 3.2** models out of the box with automatic model detection and the correct tool-calling format for each family.

## Features

- **Interactive CLI chat** with tool use
- **Ollama-compatible HTTP server** (`/api/chat`, `/api/generate`) and **OpenAI-compatible endpoint** (`/v1/chat/completions`)
- **MCP tool integration** -- connect any MCP server and the model can call its tools automatically
- **Multi-model support** -- auto-detects Qwen3 (Hermes-style), Llama 3.2 (Pythonic), and Granite 3.2 tool-calling formats
- Hardware-accelerated inference via Metal (macOS), CUDA, and Vulkan

## Prerequisites

- **Node.js** >= 18
- A **GGUF model file** (see [Downloading Models](#downloading-models) below)

## Installation

```bash
git clone <repo-url>
cd llama
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

Create a `config.json` in the project root (one is included as an example):

```json
{
  "model": "qwen3:8b",
  "model_path": "./models/qwen3-8b-q4_k_m.gguf",
  "system_prompt_file": "./system_prompt.txt",
  "assistant_name": "Assistant",
  "context_size": 8192,
  "mcp_servers": []
}
```

### Configuration Options

| Field                | Type   | Required | Default       | Description                                      |
| -------------------- | ------ | -------- | ------------- | ------------------------------------------------ |
| `model`              | string | yes      |               | Model name (used for detection and display)      |
| `model_path`         | string | yes      |               | Path to the GGUF model file                      |
| `system_prompt_file` | string | no       |               | Path to a text file containing the system prompt |
| `system_prompt`      | string | no       |               | Inline system prompt (overridden by file)        |
| `assistant_name`     | string | no       | `"Assistant"` | Display name for the assistant                   |
| `context_size`       | number | no       | `8192`        | Context window size in tokens                    |
| `gpu_layers`         | number | no       |               | Number of layers to offload to GPU               |
| `mcp_servers`        | array  | no       | `[]`          | MCP servers to connect to (see below)            |

### Adding MCP Servers

Each entry in `mcp_servers` defines an MCP server to connect to. Tools from all connected servers are made available to the model.

**stdio transport** (local process):

```json
{
  "name": "my-server",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/mcp-server/index.js"],
  "cwd": "/path/to/mcp-server",
  "env": {}
}
```

**HTTP transport** (remote server):

```json
{
  "name": "remote-server",
  "transport": "http",
  "url": "http://localhost:3000/mcp"
}
```

### Model Detection

The model type is auto-detected from the `model` field:

| Keyword in model name | Detected type | Tool format                     |
| --------------------- | ------------- | ------------------------------- |
| `qwen`                | qwen3         | Hermes-style `<tool_call>` tags |
| `llama`               | llama3        | Pythonic `[func(arg=val)]`      |
| `granite`             | granite       | Hermes-style `<tool_call>` tags |

If no keyword matches, it defaults to `qwen3`.

## Usage

### Interactive CLI

```bash
npm start
```

Or with a custom config path:

```bash
node src/index.js /path/to/config.json
```

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
node src/server.js --config ./config.json --port 9000 --host 0.0.0.0
```

**Ollama-compatible endpoints:**

| Method | Endpoint        | Description      |
| ------ | --------------- | ---------------- |
| POST   | `/api/chat`     | Chat completions |
| POST   | `/api/generate` | Text generation  |
| GET    | `/api/tags`     | List models      |
| GET    | `/api/version`  | Server version   |

**OpenAI-compatible endpoints:**

| Method | Endpoint               | Description      |
| ------ | ---------------------- | ---------------- |
| POST   | `/v1/chat/completions` | Chat completions |
| GET    | `/v1/models`           | List models      |

**Example -- curl with the Ollama API:**

```bash
curl http://localhost:9000/api/chat -d '{
  "model": "qwen3:8b",
  "messages": [{"role": "user", "content": "Hello!"}],
  "stream": false
}'
```

**Example -- curl with the OpenAI API:**

```bash
curl http://localhost:9000/v1/chat/completions -d '{
  "model": "qwen3:8b",
  "messages": [{"role": "user", "content": "Hello!"}]
}'
```

## Project Structure

```
llama-mcp-host/
├── config.json              # Configuration file
├── system_prompt.txt        # Default system prompt
├── models/                  # GGUF model files (git-ignored)
├── src/
│   ├── index.js             # CLI entry point
│   ├── server.js            # HTTP server (Ollama/OpenAI compatible)
│   ├── config.js            # Configuration loader & validation
│   ├── mcp_client.js        # MCP server connection manager
│   ├── chat_controller.js   # Conversation loop & tool execution
│   └── model_handlers/
│       ├── index.js         # Handler factory
│       ├── qwen3.js         # Qwen3 tool format (Hermes-style)
│       ├── llama3.js        # Llama 3.2 tool format (Pythonic)
│       └── granite.js       # Granite 3.2 tool format
└── package.json
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              CLI (index.js) / HTTP Server (server.js)        │
├─────────────────────────────────────────────────────────────┤
│                      Chat Controller                         │
│  - Manages conversation loop                                 │
│  - Detects and routes tool calls                             │
├─────────────────────────────────────────────────────────────┤
│                     Model Interface                          │
│  - node-llama-cpp bindings                                   │
│  - Model-specific chat templates                             │
├──────────────────────┬──────────────────┬───────────────────┤
│   Qwen3 Handler      │  Llama3 Handler  │  Granite Handler  │
│   <tool_call> tags   │  [func()] syntax │  <tool_call> tags │
├──────────────────────┴──────────────────┴───────────────────┤
│                      MCP Client Manager                      │
│  - Connects to configured MCP servers (stdio & HTTP)         │
│  - Converts tool schemas per model format                    │
│  - Executes tool calls and returns results                   │
└─────────────────────────────────────────────────────────────┘
```

## Dependencies

| Package                     | Purpose                         |
| --------------------------- | ------------------------------- |
| `node-llama-cpp`            | llama.cpp Node.js bindings      |
| `@modelcontextprotocol/sdk` | MCP client SDK                  |
| `zod`                       | Configuration schema validation |

## License

MIT
