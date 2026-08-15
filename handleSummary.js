/**
 * k6 handleSummary reporter for TestChimp.
 *
 * Usage (k6 script):
 *   import { handleSummary } from 'https://cdn.jsdelivr.net/npm/@testchimp/k6@0.2.2/handleSummary.js';
 *   export { handleSummary };
 *
 * Auth: TESTCHIMP_API_KEY + TESTCHIMP_PROJECT_ID
 * Host: TESTCHIMP_INGRESS_URL (or TESTCHIMP_BACKEND_URL with SaaS featureservice→ingress rewrite)
 * Branch: TESTCHIMP_BRANCH_NAME (or GITHUB_REF_NAME / CI_COMMIT_REF_NAME)
 *
 * k6 cannot read sibling `export const testchimp` — pass metadata via env
 * (k6/scripts/run-journey.sh) or TESTCHIMP_PERF_META JSON.
 *
 * This file must stay k6-compatible ESM (k6/http, __ENV). Do not import Node modules.
 */
import http from 'k6/http';
import { buildIngestBody, ingestUrl } from './ingest.js';

function readMeta() {
  try {
    const raw = __ENV.TESTCHIMP_PERF_META;
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    // ignore malformed meta
  }
  return {
    id: __ENV.TESTCHIMP_PERF_ID,
    kind: __ENV.TESTCHIMP_PERF_KIND,
    folderPath: __ENV.TESTCHIMP_FOLDER_PATH,
    fileName: __ENV.TESTCHIMP_FILE_NAME,
    testTypes: (__ENV.TESTCHIMP_PERF_TEST_TYPES || '').split(',').filter(Boolean),
    scenarios: (__ENV.TESTCHIMP_PERF_SCENARIOS || '').split(',').filter(Boolean),
    members: (__ENV.TESTCHIMP_PERF_MEMBERS || '').split(',').filter(Boolean),
  };
}

function metricValue(metric, key) {
  if (!metric) return undefined;
  if (metric.values && metric.values[key] != null) return metric.values[key];
  if (metric[key] != null) return metric[key];
  return undefined;
}

function formatTextSummary(data) {
  const metrics = (data && data.metrics) || {};
  const p95 = metricValue(metrics.http_req_duration, 'p(95)');
  const fail = metricValue(metrics.http_req_failed, 'rate');
  const duration = data && data.state && data.state.testRunDurationMs;
  const parts = [];
  if (duration != null) parts.push(`duration=${duration}ms`);
  if (p95 != null) parts.push(`http_req_duration p95=${p95}`);
  if (fail != null) parts.push(`http_req_failed rate=${fail}`);
  return parts.length ? `k6 summary: ${parts.join('  ')}\n` : '';
}

export function handleSummary(data) {
  const env = typeof __ENV === 'undefined' ? {} : __ENV;
  const text = formatTextSummary(data);
  const apiKey = env.TESTCHIMP_API_KEY || '';
  const projectId = env.TESTCHIMP_PROJECT_ID || '';
  if (!apiKey || !projectId) {
    return {
      stdout: `${text}TestChimp k6 reporter skipped: TESTCHIMP_API_KEY and TESTCHIMP_PROJECT_ID are required.\n`,
    };
  }
  const body = buildIngestBody(data, env, readMeta());
  if (!body.report.testchimpId) {
    return {
      stdout: `${text}TestChimp k6 reporter skipped: testchimp.id / TESTCHIMP_PERF_ID is required.\n`,
    };
  }
  if (!body.report.folderPath || !body.report.fileName) {
    return {
      stdout: `${text}TestChimp k6 reporter skipped: TESTCHIMP_FOLDER_PATH and TESTCHIMP_FILE_NAME are required (use k6/scripts/run-journey.sh).\n`,
    };
  }
  const url = ingestUrl(env);
  const res = http.post(url, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'testchimp-api-key': apiKey,
      'Project-Id': projectId,
    },
    timeout: '30s',
  });
  const ok = res && res.status >= 200 && res.status < 300;
  let runId = '';
  if (ok && res.body) {
    try {
      const parsed = JSON.parse(res.body);
      if (parsed && parsed.runId) {
        runId = String(parsed.runId);
      }
    } catch (e) {
      // ignore non-JSON bodies
    }
  }
  const line = ok
      ? `TestChimp perf ingest ok (${res.status}) ${url}${runId ? ` runId=${runId}` : ''}\n`
      : `TestChimp perf ingest failed (${res ? res.status : 'no-response'}) ${url} ${res && res.body ? res.body : ''}\n`;
  const out = { stdout: text + line };
  const runIdFile = env.TESTCHIMP_PERF_RUN_ID_FILE;
  if (ok && runId && runIdFile) {
    out[runIdFile] = runId;
  }
  return out;
}
