/**
 * Pure helpers for the k6 handleSummary reporter (no k6 runtime imports).
 * Safe to unit-test in Node.
 */

export const DEFAULT_INGRESS_URL = 'https://ingress.testchimp.io';

const SAAS_FEATURESERVICE_TO_INGRESS = {
  'https://featureservice.testchimp.io': 'https://ingress.testchimp.io',
  'https://featureservice-staging.testchimp.io': 'https://ingress-staging.testchimp.io',
};

function stripTrailingSlashes(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function mapSaaSFeatureserviceToIngress(url) {
  const normalized = stripTrailingSlashes(url);
  if (!normalized) return normalized;
  return SAAS_FEATURESERVICE_TO_INGRESS[normalized] || normalized;
}

export function resolveIngestBaseUrl(env) {
  const e = env || {};
  const ingressExplicit = stripTrailingSlashes(e.TESTCHIMP_INGRESS_URL || '');
  if (ingressExplicit) {
    return ingressExplicit;
  }
  const backend = stripTrailingSlashes(e.TESTCHIMP_BACKEND_URL || '');
  if (backend) {
    return mapSaaSFeatureserviceToIngress(backend);
  }
  return DEFAULT_INGRESS_URL;
}

function envStr(env, key) {
  const v = env && env[key];
  return v == null ? '' : String(v).trim();
}

/** k6- and Node-safe UUID v4 (same shape as the Playwright reporter). */
export function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Prefer TESTCHIMP_BATCH_INVOCATION_ID; never return empty. */
export function resolveBatchInvocationId(env) {
  return envStr(env, 'TESTCHIMP_BATCH_INVOCATION_ID') || generateUuid();
}

export function inferKind(folderPath, fileName, explicitKind) {
  if (explicitKind === 'journey' || explicitKind === 'JOURNEY') return 'JOURNEY';
  if (explicitKind === 'composite' || explicitKind === 'COMPOSITE') return 'COMPOSITE';
  const combined = `${folderPath || ''}/${fileName || ''}`.replace(/\\/g, '/');
  if (combined.includes('/k6/composites/') || combined.startsWith('k6/composites/')
      || combined.includes('k6/composites/')) {
    return 'COMPOSITE';
  }
  return 'JOURNEY';
}

function mapTestTypes(testTypes) {
  if (!Array.isArray(testTypes) || testTypes.length === 0) {
    return [];
  }
  return testTypes.map((t) => String(t).toUpperCase()).filter((t) => t === 'VOLUME' || t === 'LOAD');
}

/**
 * Build the JSON body for POST /api/ingest_perf_run_report.
 * `meta` comes from the k6 script's `export const testchimp = { ... }`.
 */
export function buildIngestBody(summaryData, env, meta) {
  const e = env || {};
  const m = meta || {};
  const folderPath = envStr(e, 'TESTCHIMP_FOLDER_PATH') || m.folderPath || '';
  const fileName = envStr(e, 'TESTCHIMP_FILE_NAME') || m.fileName || '';
  return {
    report: {
      folderPath,
      fileName,
      testchimpId: m.id || envStr(e, 'TESTCHIMP_PERF_ID'),
      kind: inferKind(folderPath, fileName, m.kind),
      testTypes: mapTestTypes(m.testTypes),
      scenarios: Array.isArray(m.scenarios) ? m.scenarios : [],
      memberTestchimpIds: Array.isArray(m.members) ? m.members : [],
      branchName: envStr(e, 'TESTCHIMP_BRANCH_NAME') || envStr(e, 'GITHUB_REF_NAME') || envStr(e, 'CI_COMMIT_REF_NAME'),
      batchInvocationId: resolveBatchInvocationId(e),
      environment: envStr(e, 'TESTCHIMP_ENV') || envStr(e, 'TESTCHIMP_ENVIRONMENT'),
      release: envStr(e, 'TESTCHIMP_RELEASE'),
      profile: envStr(e, 'TESTCHIMP_PERF_PROFILE') || m.profile || '',
      dataset: envStr(e, 'TESTCHIMP_PERF_DATASET') || m.dataset || '',
      llmMode: envStr(e, 'TESTCHIMP_LLM_MODE') || m.llmMode || '',
      gitCommitSha: envStr(e, 'TESTCHIMP_GIT_COMMIT_SHA') || envStr(e, 'GITHUB_SHA') || envStr(e, 'CI_COMMIT_SHA'),
      summaryJson: JSON.stringify(summaryData == null ? {} : summaryData),
    },
  };
}

export function ingestUrl(env) {
  return `${resolveIngestBaseUrl(env)}/api/ingest_perf_run_report`;
}

export function attachTimeseriesUrl(env) {
  return `${resolveIngestBaseUrl(env)}/api/ingest_perf_run_timeseries`;
}
