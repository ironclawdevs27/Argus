/**
 * ARGUS MCP Client — Headless CI Mode
 *
 * In Claude Code (interactive), MCP tools are called natively by the agent.
 * In CI (GitHub Actions, headless), this module spawns the chrome-devtools-mcp
 * process and communicates via JSON-RPC over stdio, wrapping each tool as an
 * async function with the same signature our orchestration scripts expect.
 *
 * Usage:
 *   const mcp = await createMcpClient();
 *   await mcp.navigate_page({ url: 'http://localhost:3000' });
 *   const msgs = await mcp.list_console_messages();
 */

import { spawn } from 'child_process';

const BROWSER_URL = process.env.MCP_BROWSER_URL ?? 'http://127.0.0.1:9222';
const TOOL_TIMEOUT_MS = 30_000;

/**
 * Create an MCP client that wraps chrome-devtools-mcp via JSON-RPC over stdio.
 * @returns {Promise<object>} Object with all MCP tool methods
 */
export async function createMcpClient() {
  // On Windows, npx is npx.cmd — shell:true resolves this cross-platform.
  const proc = spawn('npx', [
    '-y', 'chrome-devtools-mcp@latest',
    `--browser-url=${BROWSER_URL}`,
    '--headless=true',
    '--viewport=1920x1080',
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true,
  });

  let messageId = 1;
  const pending = new Map(); // id → { resolve, reject }
  let buffer = '';

  // Parse newline-delimited JSON-RPC responses from stdout
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // non-JSON line from process — ignore
      }
    }
  });

  proc.on('exit', (code) => {
    if (code !== 0) {
      for (const { reject } of pending.values()) {
        reject(new Error(`MCP process exited with code ${code}`));
      }
      pending.clear();
    }
  });

  // Send JSON-RPC initialize handshake
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'argus', version: '1.0.0' },
  });

  /**
   * Call an MCP tool by name with params.
   * @param {string} method - JSON-RPC method name
   * @param {object} params
   * @returns {Promise<any>}
   */
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = messageId++;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      pending.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP tool timeout: ${method} (${TOOL_TIMEOUT_MS}ms)`));
        }
      }, TOOL_TIMEOUT_MS);

      // Clear timer on resolution
      const { resolve: origResolve, reject: origReject } = pending.get(id);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });

      proc.stdin.write(request);
    });
  }

  /**
   * Call an MCP tool (tools/call JSON-RPC method).
   */
  function tool(name, args = {}) {
    return call('tools/call', { name, arguments: args })
      .then(result => {
        // MCP returns { content: [{ type, text }] } — extract the value
        const content = result?.content;
        if (Array.isArray(content) && content.length > 0) {
          const item = content[0];
          if (item.type === 'text') {
            const text = item.text;
            // chrome-devtools-mcp wraps evaluate_script results in a markdown code block:
            // "Script ran on page and returned:\n```json\n<value>\n```"
            const mdMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
            if (mdMatch) {
              try { return JSON.parse(mdMatch[1]); } catch { return mdMatch[1]; }
            }
            try { return JSON.parse(text); } catch { return text; }
          }
        }
        return result;
      });
  }

  // Graceful shutdown
  function close() {
    proc.stdin.end();
    proc.kill('SIGTERM');
  }

  // Build the mcp interface object matching what orchestration scripts expect
  return {
    navigate_page: (args) => tool('navigate_page', args),
    list_pages: (args) => tool('list_pages', args),
    new_page: (args) => tool('new_page', args),
    select_page: (args) => tool('select_page', args),
    close_page: (args) => tool('close_page', args),
    take_screenshot: (args) => tool('take_screenshot', args),
    take_snapshot: (args) => tool('take_snapshot', args),
    list_console_messages: (args) => tool('list_console_messages', args),
    get_console_message: (args) => tool('get_console_message', args),
    list_network_requests: (args) => tool('list_network_requests', args),
    get_network_request: (args) => tool('get_network_request', args),
    evaluate_script: (args) => tool('evaluate_script', args),
    wait_for: (args) => tool('wait_for', args),
    click: (args) => tool('click', args),
    fill: (args) => tool('fill', args),
    fill_form: (args) => tool('fill_form', args),
    hover: (args) => tool('hover', args),
    type_text: (args) => tool('type_text', args),
    press_key: (args) => tool('press_key', args),
    resize_page: (args) => tool('resize_page', args),
    emulate: (args) => tool('emulate', args),
    performance_start_trace: (args) => tool('performance_start_trace', args),
    performance_stop_trace: (args) => tool('performance_stop_trace', args),
    performance_analyze_insight: (args) => tool('performance_analyze_insight', args),
    take_memory_snapshot: (args) => tool('take_memory_snapshot', args),
    lighthouse_audit: (args) => tool('lighthouse_audit', args),
    handle_dialog: (args) => tool('handle_dialog', args),
    drag: (args) => tool('drag', args),
    upload_file: (args) => tool('upload_file', args),
    close,
  };
}
