/**
 * Qwen3 model handler for tool calling
 * Uses Hermes-style format with <tool_call> tags
 */

/**
 * Format tools for Qwen3 system prompt
 * @param {Array} tools - Array of MCP tool definitions
 * @returns {string} Formatted tools section for system prompt
 */
export function format_tools_for_prompt(tools) {
  if (!tools || tools.length === 0) {
    return '';
  }

  const formatted_tools = tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  }));

  return `

# Tools

You have access to the following tools. To use a tool, respond with a tool call in this exact format:

<tool_call>
{"name": "tool_name", "arguments": {"arg1": "value1"}}
</tool_call>

Available tools:
<tools>
${JSON.stringify(formatted_tools, null, 2)}
</tools>

When you need to use a tool, output the tool call and wait for the result. You may call multiple tools if needed.
After receiving tool results, continue your response.`;
}

/**
 * Parse tool calls from model output
 * @param {string} output - Raw model output
 * @returns {Array<{name: string, arguments: object}>} Parsed tool calls
 */
export function parse_tool_calls(output) {
  const tool_calls = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        tool_calls.push({
          name: parsed.name,
          arguments: parsed.arguments || {}
        });
      }
    } catch (e) {
      console.error('Failed to parse tool call:', match[1], e.message);
    }
  }

  return tool_calls;
}

/**
 * Check if output contains tool calls
 * @param {string} output - Raw model output
 * @returns {boolean} True if output contains tool calls
 */
export function has_tool_calls(output) {
  return /<tool_call>/.test(output);
}

/**
 * Format tool result for model consumption
 * @param {string} tool_name - Name of the tool that was called
 * @param {any} result - Result from the tool
 * @returns {string} Formatted tool result
 */
export function format_tool_result(tool_name, result) {
  const result_str = typeof result === 'string' ? result : JSON.stringify(result);
  return `<tool_response>
{"name": "${tool_name}", "result": ${JSON.stringify(result_str)}}
</tool_response>`;
}

/**
 * Get text content from output, excluding tool calls
 * @param {string} output - Raw model output
 * @returns {string} Text content without tool calls
 */
export function get_text_content(output) {
  return output.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

/**
 * Build a chat message for the model
 * @param {string} role - Message role (system, user, assistant)
 * @param {string} content - Message content
 * @returns {object} Chat message object
 */
export function build_message(role, content) {
  return { role, content };
}

export default {
  format_tools_for_prompt,
  parse_tool_calls,
  has_tool_calls,
  format_tool_result,
  get_text_content,
  build_message
};
