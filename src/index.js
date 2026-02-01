#!/usr/bin/env node

/**
 * MCP Host Interface for llama.cpp
 * CLI entry point
 */

import { createInterface } from 'readline';
import { getLlama } from 'node-llama-cpp';
import { load_config, detect_model_type } from './config.js';
import { McpClientManager } from './mcp_client.js';
import { ChatController } from './chat_controller.js';

const DEFAULT_CONFIG_PATH = './config.json';
const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_INTERVAL_MS = 100;

/**
 * Create a spinner that displays next to a prefix
 * @param {string} prefix - Text to display before the spinner
 * @returns {object} Spinner controller with start() and stop() methods
 */
function create_spinner(prefix) {
  let frame_index = 0;
  let interval = null;

  return {
    start() {
      process.stdout.write(`\n${prefix} ${SPINNER_FRAMES[0]}`);
      interval = setInterval(() => {
        frame_index = (frame_index + 1) % SPINNER_FRAMES.length;
        process.stdout.write(`\b${SPINNER_FRAMES[frame_index]}`);
      }, SPINNER_INTERVAL_MS);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // Clear spinner character and move cursor back
      process.stdout.write('\b \b');
    }
  };
}

async function main() {
  const config_path = process.argv[2] || DEFAULT_CONFIG_PATH;

  console.log('='.repeat(50));
  console.log('  MCP Host Interface for llama.cpp');
  console.log('='.repeat(50));
  console.log('');

  // Load configuration
  console.log(`Loading configuration from: ${config_path}`);
  let config;
  try {
    config = load_config(config_path);
  } catch (error) {
    console.error(`Failed to load configuration: ${error.message}`);
    process.exit(1);
  }

  // Detect model type
  const model_type = detect_model_type(config.model);
  console.log(`Detected model type: ${model_type}`);

  // Initialize MCP clients
  const mcp_manager = new McpClientManager();

  if (config.mcp_servers.length > 0) {
    console.log('\nConnecting to MCP servers...');
    await mcp_manager.connect_all(config.mcp_servers);
  }

  // Initialize llama.cpp
  console.log('\nLoading model...');

  if (!config.model_path) {
    console.error('Error: model_path is required in configuration');
    await mcp_manager.disconnect_all();
    process.exit(1);
  }

  let llama, model, context, chat_controller;

  try {
    llama = await getLlama();

    model = await llama.loadModel({
      modelPath: config.model_path
    });

    context = await model.createContext({
      contextSize: config.context_size
    });

    console.log(`Model loaded: ${config.model}`);

    // Initialize chat controller
    chat_controller = new ChatController({
      llama,
      model,
      context,
      model_type,
      mcp_manager,
      system_prompt: config.system_prompt || ''
    });

    await chat_controller.initialize();
  } catch (error) {
    console.error(`Failed to load model: ${error.message}`);
    await mcp_manager.disconnect_all();
    process.exit(1);
  }

  // Set up readline interface
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Handle graceful shutdown
  let is_shutting_down = false;
  const shutdown = async () => {
    if (is_shutting_down) return;
    is_shutting_down = true;

    console.log('\n\nShutting down...');
    rl.close();

    // Dispose llama resources in correct order before MCP disconnect
    try {
      if (context) {
        await context.dispose();
      }
      if (model) {
        await model.dispose();
      }
      if (llama) {
        await llama.dispose();
      }
    } catch (error) {
      // Ignore disposal errors during shutdown
    }

    await mcp_manager.disconnect_all();
    console.log('Goodbye!');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Main chat loop
  const prompt_user = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt_user();
        return;
      }

      if (
        trimmed.toLowerCase() === '/quit' ||
        trimmed.toLowerCase() === '/exit'
      ) {
        await shutdown();
        return;
      }

      if (trimmed.toLowerCase() === '/help') {
        console.log('\nCommands:');
        console.log('  /quit, /exit - Exit the chat');
        console.log('  /tools       - List available tools');
        console.log('  /help        - Show this help message');
        console.log('');
        prompt_user();
        return;
      }

      if (trimmed.toLowerCase() === '/tools') {
        const tools = mcp_manager.get_all_tools();
        console.log(`\nAvailable tools (${tools.length}):`);
        for (const tool of tools) {
          console.log(
            `  - ${tool.name}: ${tool.description || '(no description)'}`
          );
        }
        console.log('');
        prompt_user();
        return;
      }

      const spinner = create_spinner(`${config.assistant_name}:`);
      try {
        spinner.start();
        const response = await chat_controller.chat(trimmed);
        spinner.stop();
        console.log(response);
        console.log('');
      } catch (error) {
        spinner.stop();
        console.error(`Error: ${error.message}`);
        console.log('');
      }

      prompt_user();
    });
  };

  console.log('Type /help for available commands, /quit to exit.\n');
  prompt_user();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
