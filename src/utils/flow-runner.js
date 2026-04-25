/**
 * Argus v3 Phase B5 / D8.3–D8.5 — User Flow Runner
 *
 * Executes reusable multi-step interaction sequences defined in targets.js flows[].
 * Each flow is a named sequence of steps that exercises a user journey end-to-end.
 *
 * Supported step actions:
 *   navigate        — navigate_page to step.url or baseUrl + step.path
 *   fill            — mcp.fill (sets .value directly, no keyboard events)
 *                     Add typing: true to use mcp.type_text instead, which
 *                     dispatches real keydown/keyup/input events (D8.3)
 *   click           — mcp.click on step.selector
 *   press_key       — mcp.press_key with step.key
 *   drag            — mcp.drag from step.selector to step.target (D8.4)
 *   upload_file     — mcp.upload_file via uid from page snapshot; finds the
 *                     file input by its [Upload] accessibility role (D8.5)
 *                     DSL: { action: 'upload_file', selector: 'input[type=file]',
 *                            filePath: '/path/to/file' }
 *                     Pass uid directly to skip snapshot lookup:
 *                            { action: 'upload_file', uid: 'e4', filePath: '...' }
 *   waitFor         — mcp.wait_for until step.selector appears
 *   sleep           — pause step.ms milliseconds
 *   handle_dialog   — mcp.handle_dialog (accept/dismiss + optional promptText)
 *   assert          — run an inline assertion (see assert types below)
 *
 * Assert types:
 *   no_console_errors   — list_console_messages must return zero errors
 *   no_network_errors   — list_network_requests must return zero 4xx/5xx
 *   element_visible     — selector must appear in DOM within timeout
 *   element_not_visible — selector must not exist in DOM
 *   url_contains        — window.location.href must include value
 *   no_js_errors        — window.__argusErrors must be empty
 */

import { unwrapEval } from './mcp-client.js';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Extract the uid of the first file input from a take_snapshot response.
 *
 * chrome-devtools-mcp snapshot format uses "[Upload]" as the accessibility role
 * for <input type="file"> elements, followed by the element uid (e.g. "e4").
 * Multiple fallback patterns handle JSON tree formats and general uid placement.
 */
function extractFileInputUid(snapResponse) {
  let text = typeof snapResponse === 'string'
    ? snapResponse
    : JSON.stringify(snapResponse ?? '');

  // Strip markdown code fence if present (mirrors evaluate_script wrapping)
  const fence = text.match(/```(?:json|text)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];

  // Pattern 1: text-tree format — "- input [Upload] e4"
  const uploadRole = text.match(/\[Upload\]\s+([A-Za-z0-9_-]+)/);
  if (uploadRole) return uploadRole[1];

  // Pattern 2: JSON tree — uid near inputType:"file" marker
  const jsonA = text.match(/"inputType"\s*:\s*"file"[^}]{0,200}"uid"\s*:\s*"([^"]+)"/);
  if (jsonA) return jsonA[1];
  const jsonB = text.match(/"uid"\s*:\s*"([^"]+)"[^}]{0,200}"inputType"\s*:\s*"file"/);
  if (jsonB) return jsonB[1];

  // Pattern 3: line-scan — uid value on a line near upload/file keywords
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/upload|file.input/i.test(lines[i])) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) {
        const m = lines[j].match(/\buid\b[:\s='"]+([A-Za-z0-9_-]+)/i);
        if (m) return m[1];
      }
    }
  }

  return null;
}

export function normalizeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (Array.isArray(val.messages)) return val.messages;
  if (Array.isArray(val.requests)) return val.requests;
  if (Array.isArray(val.result))   return val.result;
  return [];
}

async function runAssert(step, mcp, flowName, baseUrl, baselines) {
  const findings = [];

  switch (step.type) {
    case 'no_console_errors': {
      const msgs = normalizeArray(await mcp.list_console_messages());
      // Only consider messages produced during this flow — filter out pre-existing session noise.
      const recent = msgs.slice(baselines?.consoleMsgCount ?? 0);
      const errors = recent.filter(m => (m.level ?? '').toLowerCase() === 'error');
      if (errors.length > 0) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          message: `[${flowName}] assert no_console_errors: ${errors.length} error(s) — ${errors.slice(0, 2).map(e => e.text ?? String(e)).join('; ')}`,
          severity: step.severity ?? 'warning',
          url: baseUrl,
        });
      }
      break;
    }

    case 'no_network_errors': {
      const reqs = normalizeArray(await mcp.list_network_requests());
      const recent = reqs.slice(baselines?.networkReqCount ?? 0);
      const failures = recent.filter(r => (r.status ?? 0) >= 400);
      if (failures.length > 0) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          message: `[${flowName}] assert no_network_errors: ${failures.length} failed request(s) — ${failures.slice(0, 2).map(r => `HTTP ${r.status} ${r.url}`).join('; ')}`,
          severity: step.severity ?? 'warning',
          url: baseUrl,
        });
      }
      break;
    }

    case 'element_visible': {
      // Poll via evaluate_script — wait_for doesn't reliably throw on timeout in headless MCP mode.
      const timeout = step.timeout ?? 5000;
      const start = Date.now();
      let present = false;
      do {
        const raw = await mcp.evaluate_script({
          function: `() => !!document.querySelector(${JSON.stringify(step.selector)})`,
        });
        present = !!unwrapEval(raw);
        if (present) break;
        await new Promise(r => setTimeout(r, 200));
      } while (Date.now() - start < timeout);

      if (!present) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          selector: step.selector,
          message: `[${flowName}] assert element_visible: "${step.selector}" not found in DOM within ${timeout}ms`,
          severity: step.severity ?? 'critical',
          url: baseUrl,
        });
      }
      break;
    }

    case 'element_not_visible': {
      const raw = await mcp.evaluate_script({
        function: `() => !document.querySelector(${JSON.stringify(step.selector)})`,
      });
      const absent = unwrapEval(raw);
      if (!absent) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          selector: step.selector,
          message: `[${flowName}] assert element_not_visible: "${step.selector}" unexpectedly present in DOM`,
          severity: step.severity ?? 'warning',
          url: baseUrl,
        });
      }
      break;
    }

    case 'url_contains': {
      const raw = await mcp.evaluate_script({
        function: `() => window.location.href.includes(${JSON.stringify(step.value)})`,
      });
      const matches = unwrapEval(raw);
      if (!matches) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          expected: step.value,
          message: `[${flowName}] assert url_contains: URL does not contain "${step.value}"`,
          severity: step.severity ?? 'warning',
          url: baseUrl,
        });
      }
      break;
    }

    case 'no_js_errors': {
      const raw = await mcp.evaluate_script({
        function: `() => JSON.stringify(window.__argusErrors ?? [])`,
      });
      let errors = [];
      try {
        const val = unwrapEval(raw);
        errors = Array.isArray(val) ? val
          : JSON.parse(typeof val === 'string' ? val : '[]');
      } catch {}
      if (errors.length > 0) {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          message: `[${flowName}] assert no_js_errors: ${errors.length} uncaught JS error(s) — ${errors.slice(0, 2).map(e => e.message).join('; ')}`,
          severity: step.severity ?? 'critical',
          url: baseUrl,
        });
      }
      break;
    }

    default:
      console.warn(`[ARGUS] Flow "${flowName}": unknown assert type "${step.type}" — skipped`);
  }

  return findings;
}

/**
 * Execute a single user flow and return the result.
 * Stops on the first step that throws (page state is unknown after a hard failure).
 * Critical assert failures also stop execution immediately unless step.failFast is false.
 */
export async function runFlow(flow, baseUrl, mcp) {
  const result = {
    flowName: flow.name,
    ranAt: new Date().toISOString(),
    status: 'pass',
    findings: [],
    stepsCompleted: 0,
    totalSteps: flow.steps?.length ?? 0,
  };

  if (!flow.steps?.length) return result;

  // Snapshot console/network buffer lengths before the flow runs so assertions
  // in this flow don't flag noise carried over from earlier work.
  const baselines = {
    consoleMsgCount: normalizeArray(await mcp.list_console_messages().catch(() => [])).length,
    networkReqCount: normalizeArray(await mcp.list_network_requests().catch(() => [])).length,
  };

  for (const step of flow.steps) {
    try {
      switch (step.action) {
        case 'navigate':
          // step.url = absolute URL override; step.path = relative to baseUrl
          await mcp.navigate_page({ url: step.url ?? (baseUrl + (step.path ?? '')) });
          break;

        case 'fill':
          // typing: true uses mcp.type_text (dispatches real keyboard events) instead of
          // mcp.fill (which sets .value directly and does not fire keydown/input events).
          // Use typing: true when the target input has input-event-driven validation (D8.3).
          if (step.typing) {
            await mcp.type_text({ selector: step.selector, text: step.value ?? '' });
          } else {
            await mcp.fill({ selector: step.selector, value: step.value ?? '' });
          }
          break;

        case 'click':
          await mcp.click({ selector: step.selector });
          break;

        case 'press_key':
          await mcp.press_key({ key: step.key });
          break;

        case 'waitFor':
          await mcp.wait_for({ selector: step.selector, timeout: step.timeout ?? DEFAULT_TIMEOUT });
          break;

        case 'sleep':
          await new Promise(r => setTimeout(r, step.ms ?? 1000));
          break;

        case 'drag':
          // Drag from step.selector to step.target. Fires dragstart → dragover → drop
          // on the target. The drop only lands if the target's dragover handler calls
          // event.preventDefault() — broken drop zones won't fire drop (D8.4).
          await mcp.drag({ selector: step.selector, targetSelector: step.target });
          break;

        case 'upload_file': {
          // upload_file requires a uid from the page accessibility snapshot.
          // If step.uid is provided directly, use it. Otherwise take a snapshot
          // and locate the file input via its [Upload] accessibility role (D8.5).
          let uploadUid = step.uid;
          if (!uploadUid) {
            const snap = await mcp.take_snapshot();
            uploadUid = extractFileInputUid(snap);
            if (!uploadUid) {
              throw new Error(
                `upload_file: no file-input uid found in page snapshot` +
                (step.selector ? ` for "${step.selector}"` : '') +
                `. Ensure the page has a visible <input type="file"> element, ` +
                `or pass uid directly: { action: 'upload_file', uid: 'e4', filePath: '...' }`
              );
            }
          }
          await mcp.upload_file({ uid: uploadUid, filePath: step.filePath });
          break;
        }

        case 'handle_dialog':
          await mcp.handle_dialog({ accept: step.accept ?? true, promptText: step.text ?? '' });
          break;

        case 'assert': {
          const assertFindings = await runAssert(step, mcp, flow.name, baseUrl, baselines);
          result.findings.push(...assertFindings);
          // Stop on critical assert failure — page state may be invalid for further steps
          if (assertFindings.some(f => f.severity === 'critical') && step.failFast !== false) {
            result.status = 'fail';
            result.stepsCompleted++;
            return result;
          }
          break;
        }

        default:
          console.warn(`[ARGUS] Flow "${flow.name}": unknown step action "${step.action}" — skipped`);
      }
      result.stepsCompleted++;
    } catch (err) {
      result.findings.push({
        type: 'flow_step_failed',
        flowName: flow.name,
        action: step.action,
        selector: step.selector ?? null,
        message: `[${flow.name}] step "${step.action}"${step.selector ? ` on "${step.selector}"` : ''} failed: ${err.message}`,
        severity: 'critical',
        url: baseUrl,
      });
      result.status = 'fail';
      result.stepsCompleted++;
      break;
    }
  }

  if (result.findings.some(f => f.severity === 'critical' || f.severity === 'warning')) {
    result.status = 'fail';
  }

  return result;
}

/**
 * Run all flows defined in targets.js and return aggregated results.
 */
export async function runAllFlows(flows, baseUrl, mcp) {
  if (!flows?.length) return { results: [], findings: [] };

  const results = [];
  const allFindings = [];

  for (const flow of flows) {
    console.log(`[ARGUS] Running flow: ${flow.name}`);
    const result = await runFlow(flow, baseUrl, mcp);
    results.push(result);
    allFindings.push(...result.findings);
    console.log(`[ARGUS] Flow "${flow.name}": ${result.status} (${result.stepsCompleted}/${result.totalSteps} steps, ${result.findings.length} finding(s))`);
  }

  return { results, findings: allFindings };
}
