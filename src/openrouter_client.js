/**
 * OpenRouter API Client
 * Makes OpenAI-compatible API calls to OpenRouter with native tool calling support.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_RETRIES = 15;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;
const FETCH_TIMEOUT_MS = 30000;

/**
 * Shared retry tracker that persists across multiple API calls within a request.
 * Create one per incoming user request so the retry count accumulates across
 * tool-call iterations rather than resetting each time.
 */
export class RetryTracker {
  constructor() {
    this.total_attempts = 0;
  }
}

/**
 * Fetch with a timeout and keepalives sent to the client while waiting.
 * Aborts if the request takes longer than FETCH_TIMEOUT_MS.
 * @param {string} url
 * @param {object} options - fetch options
 * @param {Function|null} on_waiting - called every ~2s while fetch is in-flight
 * @returns {Promise<Response>}
 * @throws {Error} with name 'AbortError' on timeout
 */
async function timed_fetch(url, options, on_waiting = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let keepalive_iv = null;
  if (on_waiting) {
    keepalive_iv = setInterval(on_waiting, 2000);
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (keepalive_iv) clearInterval(keepalive_iv);
  }
}

/**
 * Sleep for the given duration while sending keepalives to the client.
 * @param {number} delay_ms - Duration to sleep
 * @param {Function|null} on_waiting - Called every ~2s during sleep (for keepalives)
 * @returns {Promise<void>}
 */
async function sleep_with_keepalive(delay_ms, on_waiting) {
  return new Promise(resolve => {
    let keepalive_iv = null;
    if (on_waiting) {
      on_waiting();
      keepalive_iv = setInterval(on_waiting, 2000);
    }
    setTimeout(() => {
      if (keepalive_iv) clearInterval(keepalive_iv);
      resolve();
    }, delay_ms);
  });
}

/**
 * Calculate retry delay with exponential backoff, jitter, and Retry-After support.
 * @param {number} attempt - Current attempt number (1-based)
 * @param {object|null} response - HTTP response (to check Retry-After header)
 * @returns {number} Delay in milliseconds
 */
function calculate_retry_delay(attempt, response) {
  let delay_ms;
  const retry_after = response?.headers?.get?.('retry-after');
  if (retry_after) {
    const seconds = parseFloat(retry_after);
    delay_ms = isNaN(seconds) ? INITIAL_RETRY_DELAY_MS : Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  } else {
    delay_ms = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
  }
  // Add jitter (±25%)
  return delay_ms * (0.75 + Math.random() * 0.5);
}

/**
 * Convert MCP tool definitions to OpenAI function tool format.
 * @param {Array} mcp_tools - Array of MCP tool definitions
 * @returns {Array} OpenAI-format tool definitions
 */
export function mcp_tools_to_openai(mcp_tools) {
  if (!mcp_tools || mcp_tools.length === 0) return undefined;

  return mcp_tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  }));
}

/**
 * Parse tool calls from an OpenAI-format assistant message.
 * @param {object} message - The assistant message from the API response
 * @returns {Array<{name: string, arguments: object, id: string}>} Parsed tool calls
 */
export function parse_openai_tool_calls(message) {
  if (!message.tool_calls || message.tool_calls.length === 0) return [];

  return message.tool_calls.map(tc => {
    let args = {};
    try {
      args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments || {};
    } catch (e) {
      console.error('Failed to parse tool call arguments:', tc.function.arguments, e.message);
    }

    return {
      id: tc.id,
      name: tc.function.name,
      arguments: args
    };
  });
}

/**
 * Build tool result messages in OpenAI format for feeding back to the API.
 * @param {Array<{id: string, name: string, result: string, success: boolean}>} results
 * @returns {Array} Messages to append to conversation
 */
export function build_tool_result_messages(results) {
  return results.map(r => ({
    role: 'tool',
    tool_call_id: r.id,
    content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
  }));
}

/**
 * Make a chat completion request to OpenRouter.
 * @param {object} options
 * @param {string} options.api_key - OpenRouter API key
 * @param {string} options.model - OpenRouter model ID (e.g. "qwen/qwen3-235b-a22b")
 * @param {Array} options.messages - Chat messages in OpenAI format
 * @param {Array|undefined} options.tools - OpenAI-format tool definitions
 * @param {number} [options.temperature] - Sampling temperature
 * @param {number} [options.top_p] - Top-p sampling
 * @param {number} [options.max_tokens] - Max tokens to generate
 * @param {Function} [options.debug_log] - Debug logging function
 * @param {RetryTracker} [options.retry_tracker] - Shared retry counter across calls
 * @param {Function} [options.on_waiting] - Called every ~2s during retry waits (for keepalives)
 * @returns {Promise<object>} The API response parsed as JSON
 */
export async function chat_completion({
  api_key,
  model,
  messages,
  tools,
  temperature,
  top_p,
  max_tokens,
  debug_log = () => {},
  retry_tracker = null,
  on_waiting = null
}) {
  const body = {
    model,
    messages
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (top_p !== undefined) body.top_p = top_p;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  debug_log('openrouter request:', JSON.stringify({
    model,
    message_count: messages.length,
    tool_count: tools ? tools.length : 0
  }));

  const fetch_options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/user/llama-mcp-host',
      'X-Title': 'Llama MCP Host'
    },
    body: JSON.stringify(body)
  };

  const retry = retry_tracker || new RetryTracker();
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;

  let data;
  while (true) {
    let response;

    try {
      response = await timed_fetch(url, fetch_options, on_waiting);
    } catch (err) {
      // Timeout or network error — retryable
      if (retry.total_attempts < MAX_RETRIES) {
        retry.total_attempts++;
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        const delay_ms = calculate_retry_delay(retry.total_attempts, null);

        console.log(
          `  OpenRouter ${reason} — retrying in ${Math.round(delay_ms / 1000)}s (attempt #${retry.total_attempts}/${MAX_RETRIES})`
        );
        debug_log(`openrouter: ${reason}, retry #${retry.total_attempts}/${MAX_RETRIES}`);

        await sleep_with_keepalive(delay_ms, on_waiting);
        continue;
      }
      throw err;
    }

    // HTTP-level retryable errors (429, 502, 503)
    if (!response.ok) {
      const is_http_retryable = response.status === 429 || response.status === 502 || response.status === 503;

      if (is_http_retryable && retry.total_attempts < MAX_RETRIES) {
        retry.total_attempts++;
        const delay_ms = calculate_retry_delay(retry.total_attempts, response);

        try { await response.text(); } catch { /* drain body */ }

        console.log(
          `  OpenRouter ${response.status} — retrying in ${Math.round(delay_ms / 1000)}s (attempt #${retry.total_attempts}/${MAX_RETRIES})`
        );
        debug_log(`openrouter: HTTP ${response.status}, retry #${retry.total_attempts}/${MAX_RETRIES}`);

        await sleep_with_keepalive(delay_ms, on_waiting);
        continue;
      }

      const error_text = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${error_text}`);
    }

    data = await response.json();

    // Body-level retryable errors (200 response wrapping upstream error)
    if (data.error) {
      const code = data.error.code;
      const is_body_retryable = code === 429 || code === 502 || code === 503;

      if (is_body_retryable && retry.total_attempts < MAX_RETRIES) {
        retry.total_attempts++;
        const delay_ms = calculate_retry_delay(retry.total_attempts, null);

        console.log(
          `  OpenRouter body error (${code}) — retrying in ${Math.round(delay_ms / 1000)}s (attempt #${retry.total_attempts}/${MAX_RETRIES})`
        );
        debug_log(`openrouter: body error ${code}, retry #${retry.total_attempts}/${MAX_RETRIES}`);

        await sleep_with_keepalive(delay_ms, on_waiting);
        continue;
      }

      throw new Error(`OpenRouter API error: ${JSON.stringify(data.error)}`);
    }

    break;
  }

  // Always log if the response has no choices (likely an error)
  if (!data.choices || data.choices.length === 0) {
    console.error('OpenRouter returned no choices:', JSON.stringify(data, null, 2));
  }

  debug_log('openrouter response:', JSON.stringify({
    id: data.id,
    model: data.model,
    finish_reason: data.choices?.[0]?.finish_reason,
    has_tool_calls: !!data.choices?.[0]?.message?.tool_calls,
    content_length: data.choices?.[0]?.message?.content?.length,
    usage: data.usage
  }));

  return data;
}

/**
 * Stream a chat completion from OpenRouter using SSE.
 * @param {object} options - Same as chat_completion options
 * @param {Function} options.on_token - Called with each content token string
 * @param {Function} [options.on_tool_calls] - Called with assembled tool_calls array when stream ends
 * @param {Function} [options.debug_log] - Debug logging function
 * @returns {Promise<{content: string, tool_calls: Array|null, usage: object|null}>}
 */
export async function chat_completion_stream({
  api_key,
  model,
  messages,
  tools,
  temperature,
  top_p,
  max_tokens,
  on_token,
  debug_log = () => {},
  retry_tracker = null,
  on_waiting = null
}) {
  const body = {
    model,
    messages,
    stream: true
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (top_p !== undefined) body.top_p = top_p;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  debug_log('openrouter stream request:', JSON.stringify({
    model,
    message_count: messages.length,
    tool_count: tools ? tools.length : 0
  }));

  const stream_fetch_options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/user/llama-mcp-host',
      'X-Title': 'Llama MCP Host'
    },
    body: JSON.stringify(body)
  };

  const retry = retry_tracker || new RetryTracker();
  const stream_url = `${OPENROUTER_BASE_URL}/chat/completions`;
  let response;

  while (true) {
    try {
      response = await timed_fetch(stream_url, stream_fetch_options, on_waiting);
    } catch (err) {
      if (retry.total_attempts < MAX_RETRIES) {
        retry.total_attempts++;
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        const delay_ms = calculate_retry_delay(retry.total_attempts, null);
        console.log(
          `  OpenRouter ${reason} — retrying in ${Math.round(delay_ms / 1000)}s (attempt #${retry.total_attempts}/${MAX_RETRIES})`
        );
        await sleep_with_keepalive(delay_ms, on_waiting);
        continue;
      }
      throw err;
    }

    if (!response.ok) {
      const is_retryable = response.status === 429 || response.status === 502 || response.status === 503;
      if (is_retryable && retry.total_attempts < MAX_RETRIES) {
        retry.total_attempts++;
        const delay_ms = calculate_retry_delay(retry.total_attempts, response);
        try { await response.text(); } catch { /* drain */ }
        console.log(
          `  OpenRouter ${response.status} — retrying in ${Math.round(delay_ms / 1000)}s (attempt #${retry.total_attempts}/${MAX_RETRIES})`
        );
        await sleep_with_keepalive(delay_ms, on_waiting);
        continue;
      }
      const error_text = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${error_text}`);
    }

    break;
  }

  let full_content = '';
  const tool_call_deltas = new Map(); // index -> {id, name, arguments_str}

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data_str = trimmed.slice(6);
      if (data_str === '[DONE]') continue;

      try {
        const chunk = JSON.parse(data_str);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Accumulate content tokens
        if (delta.content) {
          full_content += delta.content;
          if (on_token) on_token(delta.content);
        }

        // Accumulate tool call deltas
        if (delta.tool_calls) {
          for (const tc_delta of delta.tool_calls) {
            const idx = tc_delta.index ?? 0;
            if (!tool_call_deltas.has(idx)) {
              tool_call_deltas.set(idx, {
                id: tc_delta.id || '',
                name: tc_delta.function?.name || '',
                arguments_str: ''
              });
            }
            const existing = tool_call_deltas.get(idx);
            if (tc_delta.id) existing.id = tc_delta.id;
            if (tc_delta.function?.name) existing.name = tc_delta.function.name;
            if (tc_delta.function?.arguments) {
              existing.arguments_str += tc_delta.function.arguments;
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  // Assemble final tool calls
  let tool_calls = null;
  if (tool_call_deltas.size > 0) {
    tool_calls = [];
    for (const [, tc] of [...tool_call_deltas.entries()].sort((a, b) => a[0] - b[0])) {
      let args = {};
      try {
        if (tc.arguments_str) {
          args = JSON.parse(tc.arguments_str);
        }
      } catch (e) {
        debug_log('failed to parse streamed tool call args:', tc.arguments_str, e.message);
      }
      tool_calls.push({
        id: tc.id,
        name: tc.name,
        arguments: args
      });
    }
  }

  return { content: full_content, tool_calls, usage: null };
}

export default {
  mcp_tools_to_openai,
  parse_openai_tool_calls,
  build_tool_result_messages,
  chat_completion,
  chat_completion_stream
};
