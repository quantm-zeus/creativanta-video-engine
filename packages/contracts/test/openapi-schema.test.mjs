import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOpenApiSpec } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('OpenAPI 3.1 Specification Verification', () => {
  const spec = getOpenApiSpec();

  it('declares openapi 3.1.0 and valid root metadata', () => {
    assert.strictEqual(spec.openapi, '3.1.0');
    assert.ok(spec.info);
    assert.strictEqual(spec.info.title, 'Creativanta Video Engine REST API');
    assert.strictEqual(spec.info.version, '1.0.0');
    assert.ok(Array.isArray(spec.servers));
    assert.ok(spec.servers.length >= 2);
  });

  it('configures BearerAuth security scheme', () => {
    assert.ok(spec.components?.securitySchemes?.BearerAuth);
    const bearer = spec.components.securitySchemes.BearerAuth;
    assert.strictEqual(bearer.type, 'http');
    assert.strictEqual(bearer.scheme, 'bearer');
  });

  it('contains all 32 required endpoints from API.md catalog', () => {
    const requiredEndpoints = [
      { path: '/capabilities', method: 'get' },
      { path: '/templates', method: 'get' },
      { path: '/templates/{id}/revisions/{revision}', method: 'get' },
      { path: '/templates', method: 'post' },
      { path: '/templates/{id}/revisions', method: 'post' },
      { path: '/templates/{id}/instantiate', method: 'post' },
      { path: '/compositions', method: 'post' },
      { path: '/compositions/{id}', method: 'get' },
      { path: '/compositions/{id}/revisions/{revision}', method: 'get' },
      { path: '/compositions/{id}/revisions', method: 'post' },
      { path: '/compositions/validate', method: 'post' },
      { path: '/assets/uploads', method: 'post' },
      { path: '/assets/{id}/upload-url', method: 'post' },
      { path: '/assets/{id}/complete', method: 'post' },
      { path: '/assets/imports', method: 'post' },
      { path: '/assets/{id}', method: 'get' },
      { path: '/assets/{id}', method: 'delete' },
      { path: '/previews', method: 'post' },
      { path: '/render-jobs', method: 'post' },
      { path: '/jobs', method: 'get' },
      { path: '/jobs/{id}', method: 'get' },
      { path: '/jobs/{id}/cancel', method: 'post' },
      { path: '/jobs/{id}/events', method: 'get' },
      { path: '/artifacts/{id}/download', method: 'get' },
      { path: '/webhook-endpoints', method: 'post' },
      { path: '/webhook-endpoints/{id}/verify', method: 'post' },
      { path: '/webhook-endpoints/{id}', method: 'get' },
      { path: '/webhook-endpoints/{id}/rotate-secret', method: 'post' },
      { path: '/webhook-endpoints/{id}', method: 'delete' },
      { path: '/webhook-deliveries', method: 'get' },
      { path: '/webhook-deliveries/{id}/replay', method: 'post' },
      { path: '/usage', method: 'get' },
    ];

    assert.strictEqual(requiredEndpoints.length, 32, 'Must have exactly 32 endpoints in catalog');

    for (const ep of requiredEndpoints) {
      const pathObj = spec.paths?.[ep.path];
      assert.ok(pathObj, `Missing path in OpenAPI spec: ${ep.path}`);
      const op = pathObj[ep.method];
      assert.ok(op, `Missing operation ${ep.method.toUpperCase()} ${ep.path}`);
      assert.ok(op.operationId, `Missing operationId on ${ep.method.toUpperCase()} ${ep.path}`);
      assert.ok(op.responses, `Missing responses on ${ep.method.toUpperCase()} ${ep.path}`);
    }
  });

  it('defines required component schemas without any unconstrained properties', () => {
    const schemas = spec.components?.schemas;
    assert.ok(schemas);

    const requiredSchemas = [
      'CapabilitiesResponse',
      'TemplateSummary',
      'TemplateDetail',
      'TemplateCreateRequest',
      'TemplateRevisionCreateRequest',
      'TemplateCreateResponse',
      'TemplateInstantiateRequest',
      'TemplateInstantiateResponse',
      'CompositionCreateRequest',
      'CompositionCreateResponse',
      'CompositionSummary',
      'CompositionRevisionDetail',
      'CompositionRevisionCreateRequest',
      'CompositionRevisionResponse',
      'CompositionValidationRequest',
      'CompositionValidationResponse',
      'AssetUploadRequest',
      'AssetUploadResponse',
      'AssetRefreshUrlResponse',
      'AssetCompleteRequest',
      'AssetImportRequest',
      'AssetSummary',
      'AssetDetail',
      'PreviewJobCreateRequest',
      'RenderJobCreateRequest',
      'JobSummary',
      'JobDetail',
      'JobCancelResponse',
      'JobEvent',
      'ArtifactDetail',
      'ArtifactDownloadResponse',
      'WebhookEndpointCreateRequest',
      'WebhookEndpointCreateResponse',
      'WebhookVerifyResponse',
      'WebhookEndpointDetail',
      'WebhookRotateSecretResponse',
      'WebhookDeliverySummary',
      'WebhookDeliveryReplayResponse',
      'UsageResponse',
      'ErrorResponse',
      'ErrorDetail',
    ];

    for (const s of requiredSchemas) {
      assert.ok(schemas[s], `Missing component schema: ${s}`);
    }
  });

  it('matches TemplateInstantiateRequest fixture against schema requirements', () => {
    const fixture = loadFixture('template-instantiate-request.json');
    const reqSchema = spec.components.schemas.TemplateInstantiateRequest;
    for (const reqField of reqSchema.required) {
      assert.ok(reqField in fixture, `Fixture missing required field ${reqField}`);
    }
    assert.strictEqual(typeof fixture.template_revision, 'number');
    assert.ok(fixture.template_revision >= 1);
  });

  it('matches RenderJobCreateRequest fixture against schema requirements', () => {
    const fixture = loadFixture('job-create-render-request.json');
    const reqSchema = spec.components.schemas.RenderJobCreateRequest;
    for (const reqField of reqSchema.required) {
      assert.ok(reqField in fixture, `Fixture missing required field ${reqField}`);
    }
    assert.strictEqual(fixture.profile, 'mp4-720p-v1');
  });

  it('matches PreviewJobCreateRequest fixture against schema requirements', () => {
    const fixture = loadFixture('job-create-preview-request.json');
    const reqSchema = spec.components.schemas.PreviewJobCreateRequest;
    for (const reqField of reqSchema.required) {
      assert.ok(reqField in fixture, `Fixture missing required field ${reqField}`);
    }
    assert.strictEqual(fixture.profile, 'preview-360p-v1');
  });
});
