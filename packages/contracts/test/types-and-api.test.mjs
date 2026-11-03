import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidComposition,
  validateCompositionSchema,
  getSceneSchema,
  getOpenApiSpec,
  getExpandedSceneSchema,
} from '../dist/index.js';

describe('Contracts API and Assertion Helpers', () => {
  it('exports canonical schemas via getter functions', () => {
    const sceneSchema = getSceneSchema();
    assert.strictEqual(typeof sceneSchema, 'object');
    assert.strictEqual(sceneSchema.schema_version, undefined); // Root schema properties
    assert.ok(sceneSchema.properties?.schema_version);

    const openapi = getOpenApiSpec();
    assert.strictEqual(typeof openapi, 'object');
    assert.strictEqual(openapi.openapi, '3.1.0');

    const expanded = getExpandedSceneSchema();
    assert.strictEqual(typeof expanded, 'object');
    assert.strictEqual(expanded.$schema, 'https://json-schema.org/draft/2020-12/schema');
  });

  it('assertValidComposition throws informative error on invalid payload', () => {
    const invalid = { schema_version: '99.0' };
    assert.throws(
      () => {
        assertValidComposition(invalid);
      },
      (err) => {
        return (
          err instanceof Error &&
          err.message.includes('Composition schema validation failed') &&
          Array.isArray(err.validationErrors) &&
          err.validationErrors.length > 0
        );
      }
    );
  });

  it('validateCompositionSchema returns false and details on empty object', () => {
    const result = validateCompositionSchema({});
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.code === 'MISSING_REQUIRED_FIELD'));
  });
});
