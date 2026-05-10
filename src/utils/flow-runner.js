/**
 * Argus v3 Phase B5 / D8.3–D8.5 — User Flow Runner
 *
 * Executes reusable multi-step interaction sequences defined in targets.js flows[].
 * Each flow is a named sequence of steps that exercises a user journey end-to-end.
 *
 * Supported step actions:
 *   navigate        — navigate_page to step.url or baseUrl + step.path
 *   fill            — mcp.fill (fires one consolidated input event with full value,
 *                     no per-keystroke keydown/keyup events)
 *                     Add typing: true to use mcp.type_text instead, which
 *                     dispatches real per-keystroke keydown/keyup/input events (D8.3)
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

import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { unwrapEval } from './mcp-client.js';

const INJECT_ERROR_LISTENER = `() => {
  if (window.__argusErrorsPatched) return;
  window.__argusErrorsPatched = true;
  window.__argusErrors = [];
  window.addEventListener('error', function(e) {
    window.__argusErrors.push({ message: e.message, source: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', function(e) {
    window.__argusErrors.push({ message: String(e.reason), source: 'unhandledrejection' });
  });
}`;

const DEFAULT_TIMEOUT = 10_000;

/**
 * Resolve a CSS selector to an MCP accessibility-tree uid.
 *
 * type_text and drag require uid (not CSS selectors) per the MCP API contract.
 * Strategy: evaluate the selector in the page to get a distinguishing attribute
 * (id, aria-label, name, placeholder), then scan the snapshot text for that
 * attribute adjacent to a uid token.
 *
 * Returns null if the element is not found or has no distinguishing attribute.
 *
 * Added to support type_text and drag which require uids.
 */
export async function resolveUidForSelector(mcp, selector) {
  // Collect multiple candidate identifiers — CDP snapshots use accessible names
  // (button text, label text), not HTML id attributes, so we try several sources.
  const rawAttr = await mcp.evaluate_script({
    function: `() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const idents = [];
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) idents.push(ariaLabel);
      if (el.id) {
        // Check for an associated <label> — its text is the accessible name in the snapshot
        const lbl = document.querySelector('label[for="' + el.id + '"]');
        if (lbl) idents.push(lbl.textContent.trim().slice(0, 50));
        idents.push(el.id);
      }
      // Button/link text content IS the accessible name in the CDP snapshot
      const txt = (el.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 50);
      if (txt) idents.push(txt);
      const name = el.getAttribute('name');
      if (name) idents.push(name);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) idents.push(placeholder);
      return [...new Set(idents)].filter(Boolean).join('\\n') || null;
    }`,
  });
  const combined = unwrapEval(rawAttr);
  if (!combined) return null;
  const identifiers = combined.split('\n').filter(Boolean);
  if (!identifiers.length) return null;

  const snap = await mcp.take_snapshot();
  let text = typeof snap === 'string' ? snap : JSON.stringify(snap ?? '');
  const fence = text.match(/```(?:json|text)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];

  for (const identifier of identifiers) {
    const esc = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Current snapshot format: "uid=N_M role "accessible name" [attrs]"
    // uid precedes the role and accessible name; MCP tools expect just the N_M part (no "uid=" prefix).
    // Prefer interactive element lines (combobox, button, etc.) over StaticText label
    // nodes — both may share the same accessible name (e.g. a <label> and its <select>).
    const m1 = text.match(new RegExp(`uid=([^\\s]+)\\s+(?!StaticText)[^\\n]*"[^"]*${esc}`, 'm'));
    if (m1) return m1[1];
    // Fallback: accept StaticText nodes (e.g. draggable divs whose only a11y node is text)
    const m1b = text.match(new RegExp(`uid=([^\\s]+)[^\\n]*"[^"]*${esc}`, 'm'));
    if (m1b) return m1b[1];
    // Legacy JSON tree: "uid":"e15" near identifier string
    const m2 = text.match(new RegExp(`"${esc}"[^}]{0,300}"uid"\\s*:\\s*"([^"]+)"`));
    if (m2) return m2[1];
    const m3 = text.match(new RegExp(`"uid"\\s*:\\s*"([^"]+)"[^}]{0,300}"${esc}"`));
    if (m3) return m3[1];
  }
  return null;
}

/**
 * Extract the uid of the first file input from a take_snapshot response.
 *
 * Current snapshot format: "uid=N_M button "Choose file:" value="No file chosen""
 * File inputs render as buttons with value="No file chosen" (Chrome's default label).
 */
function extractFileInputUid(snapResponse) {
  let text = typeof snapResponse === 'string'
    ? snapResponse
    : JSON.stringify(snapResponse ?? '');

  // Strip markdown code fence if present (mirrors evaluate_script wrapping)
  const fence = text.match(/```(?:json|text)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];

  // Pattern 1: current format — file inputs appear as button with "No file chosen" value
  // "uid=N_M button "Choose file:" value="No file chosen""
  // MCP tools expect the N_M part only (no "uid=" prefix).
  const p1 = text.match(/uid=([^\s]+)[^\n]*value="No file chosen"/);
  if (p1) return p1[1];

  // Pattern 2: any line containing "Choose file" (the default Chrome file-input label)
  const p2 = text.match(/uid=([^\s]+)[^\n]*[Cc]hoose file/);
  if (p2) return p2[1];

  // Pattern 3: legacy text-tree format — "- input [Upload] e4"
  const uploadRole = text.match(/\[Upload\]\s+([A-Za-z0-9_-]+)/);
  if (uploadRole) return uploadRole[1];

  // Pattern 4: legacy JSON tree — uid near inputType:"file" marker
  const jsonA = text.match(/"inputType"\s*:\s*"file"[^}]{0,200}"uid"\s*:\s*"([^"]+)"/);
  if (jsonA) return jsonA[1];
  const jsonB = text.match(/"uid"\s*:\s*"([^"]+)"[^}]{0,200}"inputType"\s*:\s*"file"/);
  if (jsonB) return jsonB[1];

  // Pattern 5: line-scan — any line with uid= near upload/file keywords
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/upload|file.input|Choose file/i.test(lines[i])) {
      const m = lines[i].match(/uid=([^\s]+)/);
      if (m) return m[1];
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
          message: `[${flowName}] assert no_js_errors: ${errors.length} uncaught JS error(s) — ${errors.slice(0, 2).map(e => e.message ?? String(e.reason ?? e)).join('; ')}`,
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
          await mcp.navigate_page({ url: step.url ?? (`${baseUrl.replace(/\/$/, '')}/${(step.path ?? '').replace(/^\//, '')}`) });
          // Re-inject error listener — navigation destroys the previous page context
          await mcp.evaluate_script({ function: INJECT_ERROR_LISTENER }).catch(err => console.warn('[ARGUS] flow-runner: INJECT_ERROR_LISTENER failed:', err.message));
          break;

        case 'fill': {
          // MCP fill/click require uid (not CSS selector) — resolve via snapshot.
          // typing: true uses mcp.type_text (dispatches real per-keystroke keyboard events)
          // instead of mcp.fill (which fires one consolidated input event with the full value,
          // but not keydown/keypress/keyup per character).
          // Use typing: true when the target input needs per-keystroke event handling (D8.3).
          const fillUid = await resolveUidForSelector(mcp, step.selector);
          if (!fillUid) throw new Error(`fill: no uid found for selector "${step.selector}"`);
          if (step.typing) {
            await mcp.click({ uid: fillUid });
            await mcp.type_text({ text: step.value ?? '' });
          } else {
            await mcp.fill({ uid: fillUid, value: step.value ?? '' });
          }
          break;
        }

        case 'click': {
          // MCP click requires uid — resolve CSS selector to uid via snapshot.
          const clickUid = await resolveUidForSelector(mcp, step.selector);
          if (!clickUid) throw new Error(`click: no uid found for selector "${step.selector}"`);
          await mcp.click({ uid: clickUid });
          break;
        }

        case 'press_key':
          if (!step.key) throw new Error('press_key: step.key is required');
          await mcp.press_key({ key: step.key });
          break;

        case 'waitFor': {
          // wait_for({ selector }) is unreliable in headless MCP mode — it can
          // early-exit without actually polling. Use evaluate_script polling instead.
          const wfFound = await waitForSelector(mcp, step.selector, step.timeout ?? DEFAULT_TIMEOUT);
          if (!wfFound) throw new Error(`waitFor: selector "${step.selector}" not found within ${step.timeout ?? DEFAULT_TIMEOUT}ms`);
          break;
        }

        case 'sleep':
          await new Promise(r => setTimeout(r, step.ms ?? 1000));
          break;

        case 'drag': {
          // drag MCP API requires { from_uid, to_uid } — CSS selectors are not
          // accepted. The DSL exposes sourceSelector/targetSelector (with selector/target
          // as backwards-compatible aliases) and resolves them to uids via snapshot.
          // Fires dragstart → dragover → drop on the target; drop only lands if the
          // target's dragover handler calls event.preventDefault() (D8.4).
          const srcSelector = step.sourceSelector ?? step.selector;
          const tgtSelector = step.targetSelector ?? step.target;
          const startUid = await resolveUidForSelector(mcp, srcSelector);
          const endUid   = await resolveUidForSelector(mcp, tgtSelector);
          if (!startUid) throw new Error(`drag: no uid found for source "${srcSelector}"`);
          if (!endUid)   throw new Error(`drag: no uid found for target "${tgtSelector}"`);
          await mcp.drag({ from_uid: startUid, to_uid: endUid });
          break;
        }

        case 'upload_file': {
          // upload_file requires a uid from the page accessibility snapshot.
          // Priority: explicit step.uid > step.selector resolution > first-upload fallback.
          let uploadUid = step.uid;
          if (!uploadUid) {
            if (step.selector) {
              // When a selector is provided, resolve it to the matching uid so
              // pages with multiple file inputs upload to the intended field, not just the first.
              uploadUid = await resolveUidForSelector(mcp, step.selector);
              if (!uploadUid) {
                // File inputs appear as [Upload] in the CDP snapshot, not by id — fall back.
                const snap = await mcp.take_snapshot();
                uploadUid = extractFileInputUid(snap);
              }
              if (!uploadUid) {
                throw new Error(
                  `upload_file: no uid found for selector "${step.selector}" — ` +
                  `ensure the element is visible and has id/aria-label/name/placeholder, ` +
                  `or pass uid directly: { action: 'upload_file', uid: 'e4', filePath: '...' }`
                );
              }
            } else {
              const snap = await mcp.take_snapshot();
              uploadUid = extractFileInputUid(snap);
              if (!uploadUid) {
                throw new Error(
                  `upload_file: no file-input uid found in page snapshot. ` +
                  `Ensure the page has a visible <input type="file"> element, ` +
                  `or pass uid directly: { action: 'upload_file', uid: 'e4', filePath: '...' }`
                );
              }
            }
          }
          if (!step.filePath) throw new Error('upload_file: step.filePath is required');
          if (!fs.existsSync(step.filePath))
            throw new Error(`upload_file: file not found: "${step.filePath}"`);
          await mcp.upload_file({ uid: uploadUid, filePath: step.filePath });
          break;
        }

        case 'handle_dialog':
          await mcp.handle_dialog({ accept: step.accept ?? true, promptText: step.text ?? '' });
          break;

        case 'select_option': {
          // select_option requires a uid from the page snapshot.
          // Accepts explicit step.uid or resolves from step.selector.
          let selectUid = step.uid;
          if (!selectUid) {
            if (!step.selector) {
              throw new Error('select_option: requires either uid or selector');
            }
            selectUid = await resolveUidForSelector(mcp, step.selector);
            if (!selectUid) {
              throw new Error(
                `select_option: no uid found for selector "${step.selector}" — ` +
                `ensure the <select> is visible and has id/aria-label/name, ` +
                `or pass uid directly: { action: 'select_option', uid: 'e5', value: '...' }`
              );
            }
          }
          // mcp.fill on a combobox requires the option LABEL text, not the HTML value
          // attribute. Resolve value → label via in-page evaluation when selector is known.
          let fillValue = step.value ?? '';
          if (step.selector && fillValue) {
            const rawLabel = await mcp.evaluate_script({
              function: `() => {
                const sel = document.querySelector(${JSON.stringify(step.selector)});
                if (!sel) return null;
                const opt = Array.from(sel.options || []).find(o => o.value === ${JSON.stringify(fillValue)});
                return opt ? opt.textContent.trim() : null;
              }`,
            });
            const label = unwrapEval(rawLabel);
            if (label) fillValue = label;
          }
          await mcp.fill({ uid: selectUid, value: fillValue });
          break;
        }

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
      // Capture a screenshot of the failure state for debugging before the page changes.
      let screenshotPath = null;
      try {
        const ts = Date.now();
        screenshotPath = path.join(os.tmpdir(), `argus-flow-fail-${flow.name.replace(/[^a-z0-9]/gi, '_')}-${ts}.png`);
        await mcp.take_screenshot({ filePath: screenshotPath });
      } catch { screenshotPath = null; }

      result.findings.push({
        type: 'flow_step_failed',
        flowName: flow.name,
        action: step.action,
        selector: step.selector ?? null,
        message: `[${flow.name}] step "${step.action}"${step.selector ? ` on "${step.selector}"` : ''} failed: ${err.message}`,
        screenshotPath,
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
 * Poll for a CSS selector to appear in the DOM using evaluate_script.
 * More reliable than mcp.wait_for({ selector }) which can early-exit in headless mode.
 *
 * @param {object} mcp
 * @param {string} selector - CSS selector to wait for
 * @param {number} timeoutMs - Total wait budget in ms (default 10 000)
 * @returns {Promise<boolean>} true if found within budget, false on timeout
 */
export async function waitForSelector(mcp, selector, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const raw = await mcp.evaluate_script({
      function: `() => !!document.querySelector(${JSON.stringify(selector)})`,
    }).catch(() => null);
    const found = unwrapEval(raw);
    if (found === true || String(found) === 'true') return true;
    if (Date.now() < end) await new Promise(r => setTimeout(r, 300));
  }
  return false;
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
