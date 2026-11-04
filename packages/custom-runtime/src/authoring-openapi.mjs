// @ts-check
/**
 * Authoring OpenAPI 3.1 Extension Specification Module (Task P7-03).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.resolve(__dirname, 'authoring-openapi.json');

/**
 * Raw Authoring OpenAPI 3.1 specification.
 * @type {Record<string, unknown>}
 */
export const AUTHORING_OPENAPI_SPEC = JSON.parse(
  fs.readFileSync(SCHEMA_PATH, 'utf-8'),
);

/**
 * Deep copy of the Authoring OpenAPI 3.1 specification.
 * @returns {Record<string, unknown>}
 */
export function getAuthoringOpenApiSpec() {
  return JSON.parse(JSON.stringify(AUTHORING_OPENAPI_SPEC));
}

/**
 * Validate Authoring OpenAPI specification structure.
 * @param {Record<string, unknown>} spec
 */
export function validateAuthoringOpenApiSpecification(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['Authoring OpenAPI spec must be a non-null object'] };
  }
  if (spec.openapi !== '3.1.0') {
    errors.push(`Expected openapi version '3.1.0', got '${String(spec.openapi)}'`);
  }
  if (!spec.paths || typeof spec.paths !== 'object') {
    errors.push('Missing paths object');
  } else {
    const paths = /** @type {Record<string, unknown>} */ (spec.paths);
    const requiredPaths = ['/authoring-jobs', '/authoring-jobs/{id}', '/authoring-jobs/{id}/cancel', '/authoring-providers'];
    for (const p of requiredPaths) {
      if (!paths[p]) {
        errors.push(`Missing required authoring path '${p}'`);
      }
    }
  }
  if (!spec.components || typeof spec.components !== 'object') {
    errors.push('Missing components object');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Merge the Authoring OpenAPI specification into an existing OpenAPI spec.
 * @param {Record<string, any>} baseSpec
 * @returns {Record<string, any>}
 */
export function extendOpenApiWithAuthoring(baseSpec) {
  const authoringSpec = /** @type {Record<string, any>} */ (getAuthoringOpenApiSpec());
  const merged = JSON.parse(JSON.stringify(baseSpec || {}));

  // Merge paths
  merged.paths = merged.paths || {};
  for (const [pathKey, pathItem] of Object.entries(authoringSpec.paths || {})) {
    merged.paths[pathKey] = pathItem;
  }

  // Merge components
  merged.components = merged.components || {};
  merged.components.schemas = merged.components.schemas || {};
  for (const [schemaName, schemaObj] of Object.entries(authoringSpec.components?.schemas || {})) {
    merged.components.schemas[schemaName] = schemaObj;
  }

  merged.components.securitySchemes = merged.components.securitySchemes || {};
  for (const [secKey, secObj] of Object.entries(authoringSpec.components?.securitySchemes || {})) {
    merged.components.securitySchemes[secKey] = secObj;
  }

  return merged;
}
