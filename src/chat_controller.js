/**
 * Chat Controller
 * Manages conversation loop with tool execution
 */

import { get_handler } from './model_handlers/index.js';

const MAX_TOOL_ITERATIONS = 10;

/**
 * Chat controller that manages the conversation loop
 */
export class ChatController {
  /**
   * @param {object} options
   * @param {object} options.llama - node-llama-cpp Llama instance
   * @param {object} options.model - Loaded model
   * @param {object} options.context - Chat context
   * @param {string} options.model_type - Model type ('qwen3' or 'llama3')
   * @param {object} options.mcp_manager - MCP client manager
   * @param {string} options.system_prompt - Base system prompt
   */
  constructor({
    llama,
    model,
    context,
    model_type,
    mcp_manager,
    system_prompt
  }) {
    this.llama = llama;
    this.model = model;
    this.context = context;
    this.model_type = model_type;
    this.mcp_manager = mcp_manager;
    this.handler = get_handler(model_type);
    this.system_prompt = system_prompt || '';
    this.messages = [];
    this.session = null;
  }

  /**
   * Initialize the chat session with tools
   */
  async initialize() {
    const { LlamaChatSession } = await import('node-llama-cpp');

    // Get available tools and format them for the model
    const tools = this.mcp_manager.get_all_tools();
    const tools_prompt = this.handler.format_tools_for_prompt(tools);

    // Append current date and time so the model has a concept of time
    const now = new Date();
    const date_time_str = `\n\nCurrent date and time: ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}`;

    const full_system_prompt =
      this.system_prompt + date_time_str + tools_prompt;

    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: full_system_prompt
    });

    console.log(`\nChat initialized with ${tools.length} tools available.`);
    if (tools.length > 0) {
      console.log('Available tools:', tools.map((t) => t.name).join(', '));
    }
    console.log('');
  }

  /**
   * Send a message and get a response, handling tool calls
   * @param {string} user_message - User's input message
   * @returns {string} Final assistant response
   */
  async chat(user_message) {
    let iteration = 0;
    let current_input = user_message;
    let final_response = '';
    let is_tool_result = false;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      // Generate response from model
      let response;

      if (is_tool_result) {
        // For tool results, we append to the conversation
        response = await this.session.prompt(current_input);
      } else {
        response = await this.session.prompt(current_input);
      }

      // Debug: log raw model output
      console.log('\n[DEBUG] Raw model output:');
      console.log('---START---');
      console.log(response);
      console.log('---END---');
      console.log(
        `[DEBUG] has_tool_calls: ${this.handler.has_tool_calls(response)}`
      );

      // Check for tool calls
      if (this.handler.has_tool_calls(response)) {
        const tool_calls = this.handler.parse_tool_calls(response);

        if (tool_calls.length === 0) {
          // Failed to parse, treat as regular response
          final_response = response;
          break;
        }

        // Get any text before tool calls
        const text_before = this.handler.get_text_content(response);
        if (text_before) {
          process.stdout.write(text_before + '\n');
        }

        // Execute tool calls
        const results = [];
        for (const call of tool_calls) {
          console.log(`\n[Calling tool: ${call.name}]`);
          console.log(`[Arguments: ${JSON.stringify(call.arguments)}]`);

          try {
            const result = await this.mcp_manager.call_tool(
              call.name,
              call.arguments
            );
            console.log(`[Tool result received]`);
            results.push({ name: call.name, result, success: true });
          } catch (error) {
            console.error(`[Tool error: ${error.message}]`);
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
        is_tool_result = true;
      } else {
        // No tool calls, this is the final response
        final_response = response;
        break;
      }
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      console.warn('\n[Warning: Maximum tool iterations reached]');
    }

    return final_response;
  }

  /**
   * Get conversation history
   * @returns {Array} Message history
   */
  get_history() {
    return this.session?.getChatHistory() || [];
  }
}

export default ChatController;
