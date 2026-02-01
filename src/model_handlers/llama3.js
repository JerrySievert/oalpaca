/**
 * Llama 3.2 model handler for tool calling
 * Uses Pythonic format: [function_name(param='value')]
 */

/**
 * Format tools for Llama3.2 system prompt
 * @param {Array} tools - Array of MCP tool definitions
 * @returns {string} Formatted tools section for system prompt
 */
export function format_tools_for_prompt(tools) {
  if (!tools || tools.length === 0) {
    return '';
  }

  const formatted_tools = tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.inputSchema || { type: 'object', properties: {} }
  }));

  const tools_json = formatted_tools.map(t => JSON.stringify(t, null, 2)).join('\n\n');

  return `

# Tools

You have access to the following functions. To call a function, respond with a function call in this exact format:

[function_name(param1="value1", param2="value2")]

You may call multiple functions by separating them with commas:
[func1(arg="val"), func2(arg="val")]

Available functions:

${tools_json}

When you need to call a function, output ONLY the function call in the format above.
After receiving function results, continue your response.`;
}

/**
 * Parse tool calls from model output
 * Handles Pythonic format: [func_name(param='value', param2='value')]
 * @param {string} output - Raw model output
 * @returns {Array<{name: string, arguments: object}>} Parsed tool calls
 */
export function parse_tool_calls(output) {
  const tool_calls = [];

  // Match the bracket-enclosed function calls
  // Pattern: [func_name(args...)] or [func1(...), func2(...)]
  const bracket_match = output.match(/\[([^\]]+)\]/);

  if (!bracket_match) {
    return tool_calls;
  }

  const calls_str = bracket_match[1];

  // Split by ), but be careful with nested structures
  // Simple approach: match each function call pattern
  const func_regex = /(\w+)\s*\(([^)]*)\)/g;

  let match;
  while ((match = func_regex.exec(calls_str)) !== null) {
    const func_name = match[1];
    const args_str = match[2];

    const args = parse_pythonic_args(args_str);

    tool_calls.push({
      name: func_name,
      arguments: args
    });
  }

  return tool_calls;
}

/**
 * Parse Pythonic-style arguments: param='value', param2=123
 * @param {string} args_str - Arguments string
 * @returns {object} Parsed arguments object
 */
function parse_pythonic_args(args_str) {
  const args = {};

  if (!args_str.trim()) {
    return args;
  }

  // Match: name=value patterns
  // Values can be: 'string', "string", number, True, False, None
  const arg_regex = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?)|(\w+))/g;

  let match;
  while ((match = arg_regex.exec(args_str)) !== null) {
    const name = match[1];

    if (match[2] !== undefined) {
      // Single-quoted string
      args[name] = match[2];
    } else if (match[3] !== undefined) {
      // Double-quoted string
      args[name] = match[3];
    } else if (match[4] !== undefined) {
      // Number
      args[name] = parseFloat(match[4]);
    } else if (match[5] !== undefined) {
      // Keyword: True, False, None, or other identifier
      const val = match[5];
      if (val === 'True') {
        args[name] = true;
      } else if (val === 'False') {
        args[name] = false;
      } else if (val === 'None') {
        args[name] = null;
      } else {
        args[name] = val;
      }
    }
  }

  return args;
}

/**
 * Check if output contains tool calls
 * @param {string} output - Raw model output
 * @returns {boolean} True if output contains tool calls
 */
export function has_tool_calls(output) {
  // Check for [function_name()] pattern
  return /\[\s*\w+\s*\([^\]]*\)\s*\]/.test(output);
}

/**
 * Format tool result for model consumption
 * Uses ipython-style format for Llama 3.2
 * @param {string} tool_name - Name of the tool that was called
 * @param {any} result - Result from the tool
 * @returns {string} Formatted tool result
 */
export function format_tool_result(tool_name, result) {
  const result_str = typeof result === 'string' ? result : JSON.stringify(result);
  return `Function ${tool_name} returned: ${result_str}`;
}

/**
 * Get text content from output, excluding tool calls
 * @param {string} output - Raw model output
 * @returns {string} Text content without tool calls
 */
export function get_text_content(output) {
  return output.replace(/\[[^\]]*\w+\s*\([^\]]*\)[^\]]*\]/g, '').trim();
}

/**
 * Build a chat message for the model
 * @param {string} role - Message role (system, user, assistant, ipython)
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
