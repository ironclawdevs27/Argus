/**
 * Argus D7.4 — API contract validation.
 * Validates captured network response bodies against JSON Schema-like schemas
 * defined in src/config/targets.js apiContracts[].
 *
 * Supported schema keywords: type, required, properties, items.
 * URL matching: exact pathname or pathname-prefix; full URL for http(s) contracts.
 */

import fs from 'fs';

/**
 * Lightweight JSON Schema validator.
 * Supports: type, required, properties (recursive), items (first element).
 *
 * @param {any}    value  - Value to validate
 * @param {object} schema - Schema object
 * @param {string} path   - JSONPath prefix for error messages (internal)
 * @returns {string[]} Array of human-readable violation strings (empty = valid)
 */
export function validateSchema(value, schema, path = '') {
  const violations = [];
  if (!schema || typeof schema !== 'object') return violations;
  const label = path || 'root';

  // Type check
  if (schema.type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) {
      violations.push(`${label}: expected type "${schema.type}", got "${actual}"`);
      return violations; // no point descending if the type is wrong
    }
  }

  // Required fields (objects only)
  if (schema.required && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const field of schema.required) {
      if (!(field in value)) {
        violations.push(`${label}: missing required field "${field}"`);
      }
    }
  }

  // Properties (recursive, objects only)
  if (schema.properties && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value) {
        violations.push(...validateSchema(value[key], propSchema, path ? `${path}.${key}` : key));
      }
    }
  }

  // Array items — validate first element as representative sample
  if (schema.items && Array.isArray(value) && value.length > 0) {
    violations.push(...validateSchema(value[0], schema.items, `${label}[0]`));
  }

  return violations;
}

/**
 * Decide whether a captured network request matches a contract definition.
 *
 * URL matching rules:
 *   - If contract.url starts with http(s)://  → exact full-URL match
 *   - Otherwise                               → pathname exact-match or prefix-match
 *
 * Method matching: case-insensitive; no constraint when contract.method is falsy.
 *
 * @param {string} reqUrl      - Full URL from list_network_requests
 * @param {string} reqMethod   - HTTP method from list_network_requests
 * @param {object} contract    - Entry from apiContracts[]
 * @returns {boolean}
 */
export function matchesContract(reqUrl, reqMethod, contract) {
  const method = (reqMethod ?? 'GET').toUpperCase();
  if (contract.method && contract.method.toUpperCase() !== method) return false;

  if (contract.url.startsWith('http://') || contract.url.startsWith('https://')) {
    return reqUrl === contract.url;
  }

  // Path-based match
  try {
    const { pathname } = new URL(reqUrl);
    return pathname === contract.url || pathname.startsWith(contract.url + '/');
  } catch {
    return reqUrl.includes(contract.url);
  }
}

/**
 * Load a schema from a contract definition.
 * Prefers contract.schema (inline); falls back to contract.schemaFile (JSON file).
 * Returns null if neither is present or the file cannot be parsed.
 */
function loadSchema(contract) {
  if (contract.schema) return contract.schema;
  if (contract.schemaFile) {
    try {
      return JSON.parse(fs.readFileSync(contract.schemaFile, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate captured network requests against apiContracts[].
 * For each request that matches a contract, fetches the response body via
 * mcp.get_network_request and validates the parsed JSON against the schema.
 *
 * Gracefully skips requests whose body cannot be fetched or parsed.
 *
 * @param {object[]} networkReqs - Route-sliced requests from list_network_requests()
 * @param {object}   mcp         - MCP client with get_network_request()
 * @param {object[]} contracts   - apiContracts[] from targets.js
 * @param {string}   pageUrl     - Current page URL (stored on each finding)
 * @returns {Promise<object[]>}  api_contract_violation findings
 */
export async function validateApiContracts(networkReqs, mcp, contracts, pageUrl) {
  if (!contracts?.length) return [];
  const findings = [];

  for (const req of networkReqs) {
    for (const contract of contracts) {
      if (!matchesContract(req.url, req.method, contract)) continue;

      const schema = loadSchema(contract);
      if (!schema) continue;

      // Fetch response body — graceful: skip if unavailable or not JSON
      let body = null;
      try {
        const raw = await mcp.get_network_request({ requestId: req.id ?? req.requestId });
        const text = raw?.responseBody ?? raw?.body ?? null;
        if (text) body = JSON.parse(text);
      } catch {
        continue; // body unavailable — skip validation for this request
      }

      if (body === null) continue;

      const violations = validateSchema(body, schema);
      for (const violation of violations) {
        findings.push({
          type:       'api_contract_violation',
          requestUrl: req.url,
          method:     req.method ?? 'GET',
          message:    `API contract violation for ${req.method ?? 'GET'} ${req.url}: ${violation}`,
          severity:   'warning',
          url:        pageUrl,
        });
      }
    }
  }

  return findings;
}
