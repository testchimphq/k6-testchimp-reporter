import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompletePerfBatchBody,
  buildIngestBody,
  completePerfBatchUrl,
  inferKind,
  mapSaaSFeatureserviceToIngress,
  postCompletePerfBatch,
  resolveBatchInvocationId,
  resolveIngestBaseUrl,
} from '../ingest.js';

describe('resolveIngestBaseUrl', () => {
  it('prefers TESTCHIMP_INGRESS_URL', () => {
    assert.equal(
      resolveIngestBaseUrl({
        TESTCHIMP_INGRESS_URL: 'https://ingress-staging.testchimp.io/',
        TESTCHIMP_BACKEND_URL: 'https://featureservice.testchimp.io',
      }),
      'https://ingress-staging.testchimp.io'
    );
  });

  it('rewrites SaaS featureservice to ingress', () => {
    assert.equal(
      mapSaaSFeatureserviceToIngress('https://featureservice.testchimp.io'),
      'https://ingress.testchimp.io'
    );
    assert.equal(
      resolveIngestBaseUrl({ TESTCHIMP_BACKEND_URL: 'https://featureservice-staging.testchimp.io' }),
      'https://ingress-staging.testchimp.io'
    );
  });

  it('defaults to prod ingress', () => {
    assert.equal(resolveIngestBaseUrl({}), 'https://ingress.testchimp.io');
  });
});

describe('buildIngestBody', () => {
  it('maps journey metadata and summary JSON', () => {
    const body = buildIngestBody(
      { metrics: { http_req_duration: { values: { 'p(95)': 12 } } } },
      {
        TESTCHIMP_FOLDER_PATH: 'k6/journeys',
        TESTCHIMP_FILE_NAME: 'checkout.js',
        TESTCHIMP_BRANCH_NAME: 'feat/perf',
      },
      { id: 'checkout-journey', kind: 'journey', testTypes: ['load'], scenarios: ['#TS-101'] }
    );
    assert.equal(body.report.testchimpId, 'checkout-journey');
    assert.equal(body.report.kind, 'JOURNEY');
    assert.deepEqual(body.report.testTypes, ['LOAD']);
    assert.deepEqual(body.report.scenarios, ['#TS-101']);
    assert.equal(body.report.branchName, 'feat/perf');
    assert.ok(body.report.summaryJson.includes('p(95)'));
  });

  it('uses TESTCHIMP_BATCH_INVOCATION_ID when set', () => {
    const body = buildIngestBody(
      {},
      {
        TESTCHIMP_FOLDER_PATH: 'k6/journeys',
        TESTCHIMP_FILE_NAME: 'checkout.js',
        TESTCHIMP_BATCH_INVOCATION_ID: '  suite-batch-1  ',
      },
      { id: 'checkout-journey' }
    );
    assert.equal(body.report.batchInvocationId, 'suite-batch-1');
    assert.equal(resolveBatchInvocationId({ TESTCHIMP_BATCH_INVOCATION_ID: 'suite-batch-1' }), 'suite-batch-1');
  });

  it('generates a UUID batch id when env is missing', () => {
    const body = buildIngestBody(
      {},
      { TESTCHIMP_FOLDER_PATH: 'k6/journeys', TESTCHIMP_FILE_NAME: 'checkout.js' },
      { id: 'checkout-journey' }
    );
    assert.match(body.report.batchInvocationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(
      resolveBatchInvocationId({}),
      resolveBatchInvocationId({})
    );
  });

  it('maps composite members from meta', () => {
    const body = buildIngestBody(
      {},
      { TESTCHIMP_FOLDER_PATH: 'k6/composites', TESTCHIMP_FILE_NAME: 'peak.js' },
      { id: 'peak-mix', kind: 'composite', members: ['checkout-journey'], testTypes: ['load'] }
    );
    assert.equal(body.report.kind, 'COMPOSITE');
    assert.deepEqual(body.report.memberTestchimpIds, ['checkout-journey']);
  });
});

describe('inferKind', () => {
  it('detects composites from path', () => {
    assert.equal(inferKind('k6/composites', 'peak.js'), 'COMPOSITE');
    assert.equal(inferKind('k6/journeys', 'checkout.js'), 'JOURNEY');
  });
});

describe('postCompletePerfBatch', () => {
  it('builds complete batch URL and body', () => {
    const env = {
      TESTCHIMP_INGRESS_URL: 'https://ingress-staging.testchimp.io',
      TESTCHIMP_BATCH_INVOCATION_ID: 'suite-42',
    };
    assert.equal(
      completePerfBatchUrl(env),
      'https://ingress-staging.testchimp.io/api/complete_perf_batch_invocation'
    );
    assert.deepEqual(buildCompletePerfBatchBody(env), { batchInvocationId: 'suite-42' });
  });

  it('skips when credentials missing', async () => {
    const result = await postCompletePerfBatch({ TESTCHIMP_BATCH_INVOCATION_ID: 'x' });
    assert.equal(result.skipped, true);
  });

  it('posts once with auth headers', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const result = await postCompletePerfBatch(
      {
        TESTCHIMP_INGRESS_URL: 'https://ingress.testchimp.io',
        TESTCHIMP_API_KEY: 'key-1',
        TESTCHIMP_PROJECT_ID: 'proj-1',
        TESTCHIMP_BATCH_INVOCATION_ID: 'batch-9',
      },
      fetchImpl
    );
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://ingress.testchimp.io/api/complete_perf_batch_invocation');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['testchimp-api-key'], 'key-1');
    assert.equal(captured.init.headers['Project-Id'], 'proj-1');
    assert.deepEqual(JSON.parse(captured.init.body), { batchInvocationId: 'batch-9' });
  });
});
