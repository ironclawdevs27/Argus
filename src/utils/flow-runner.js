/**
 * Argus v3 Phase B5 — User Flow Runner
 *
 * Executes reusable multi-step interaction sequences defined in targets.js flows[].
 * Each flow is a named sequence of steps that exercises a user journey end-to-end.
 *
 * Supported step actions:
 *   navigate, fill, click, press_key, waitFor, sleep, handle_dialog, assert
 *
 * Assert types:
 *   no_console_errors  — list_console_messages must return zero errors
 *   no_network_errors  — list_network_requests must return zero 4xx/5xx
 *   element_visible    — wait_for(selector) must succeed within timeout
 *   element_not_visible — selector must not exist in DOM
 *   url_contains       — window.location.href must include value
 *   no_js_errors       — window.__argusErrors must be empty
 */

const DEFAULT_TIMEOUT = 10_000;

async function runAssert(step, mcp, flowName, baseUrl) {
  const findings = [];

  switch (step.type) {
    case 'no_console_errors': {
      const msgs = await mcp.list_console_messages();
      const errors = (msgs ?? []).filter(m => (m.level ?? '').toLowerCase() === 'error');
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
      const reqs = await mcp.list_network_requests();
      const failures = (reqs ?? []).filter(r => (r.status ?? 0) >= 400);
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
      try {
        await mcp.wait_for({ selector: step.selector, timeout: step.timeout ?? 5000 });
      } catch {
        findings.push({
          type: 'flow_assert_failed',
          flowName,
          assertType: step.type,
          selector: step.selector,
          message: `[${flowName}] assert element_visible: "${step.selector}" not found in DOM`,
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
      const absent = raw?.result ?? raw;
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
      const matches = raw?.result ?? raw;
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
        const val = raw?.result ?? raw;
        errors = JSON.parse(typeof val === 'string' ? val : '[]');
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

  for (const step of flow.steps) {
    try {
      switch (step.action) {
        case 'navigate':
          await mcp.navigate_page({ url: baseUrl + step.path });
          break;

        case 'fill':
          await mcp.fill({ selector: step.selector, value: step.value ?? '' });
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

        case 'handle_dialog':
          await mcp.handle_dialog({ accept: step.accept ?? true, promptText: step.text ?? '' });
          break;

        case 'assert': {
          const assertFindings = await runAssert(step, mcp, flow.name, baseUrl);
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
