import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIngestBody,
  inferKind,
  mapSaaSFeatureserviceToIngress,
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
