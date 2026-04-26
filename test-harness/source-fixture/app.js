// Argus C1 test fixture — intentional env var issues for harness tests [51] and [52]

// C1.1: env_var_missing — MISSING_VAR is referenced but absent from .env.fixture
const apiKey = process.env.MISSING_VAR;
const dbUrl  = process.env.ALSO_MISSING;

// C1.1: this one IS declared in .env.fixture — should NOT be flagged
const apiBase = process.env.PRESENT_VAR;

// C1.2: feature_flag_leakage — FEATURE_DISABLED used in a conditional but is unset/falsy
if (process.env.FEATURE_DISABLED === 'true') {
  console.log('feature enabled');
}

// C1.2: FEATURE_ENABLED is set to 'true' in .env.fixture — should NOT be flagged
if (process.env.FEATURE_ENABLED === 'true') {
  console.log('enabled feature works');
}

export { apiKey, dbUrl, apiBase };
