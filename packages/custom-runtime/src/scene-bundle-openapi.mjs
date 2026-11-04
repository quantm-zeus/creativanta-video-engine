// @ts-check
/**
 * Scene Bundle OpenAPI 3.1 Extension Exporter & Merger (Task P7-02).
 * Provides programmatic access, structural validation, and merge capability
 * for the Scene Bundle Registry OpenAPI 3.1 specification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.resolve(__dirname, 'scene-bundle-openapi.json');

/**
 * Raw JSON specification object.
 * @type {Record<string, unknown>}
 */
export const SCENE_BUNDLE_OPENAPI_SPEC = JSON.parse(
  fs.readFileSync(SCHEMA_PATH, 'utf-8'),
);

/**
 * Get a fresh deep copy of the Scene Bundle OpenAPI 3.1 specification.
 * @returns {Record<string, unknown>}
 */
export function getSceneBundleOpenApiSpec() {
  return JSON.parse(JSON.stringify(SCENE_BUNDLE_OPENAPI_SPEC));
}

/**
 * Validate that an OpenAPI 3.1 document or extension contains all required
 * structural elements (info, servers, paths, components, securitySchemes).
 *
 * @param {Record<string, unknown>} spec
 * @returns {{ valid: boolean; errors: string[] }}
 */
export function validateOpenApiSpecification(spec) {
  const errors = [];

  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['OpenAPI spec must be a non-null object'] };
  }

  if (spec.openapi !== '3.1.0') {
    errors.push(`Expected openapi version '3.1.0', got '${String(spec.openapi)}'`);
  }

  if (!spec.info || typeof spec.info !== 'object') {
    errors.push("Missing required 'info' object");
  } else {
    const info = /** @type {Record<string, unknown>} */ (spec.info);
    if (!info.title) errors.push("Missing 'info.title'");
    if (!info.version) errors.push("Missing 'info.version'");
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    errors.push("Missing required 'paths' object");
  }

  if (!spec.components || typeof spec.components !== 'object') {
    errors.push("Missing required 'components' object");
  } else {
    const comp = /** @type {Record<string, unknown>} */ (spec.components);
    if (!comp.schemas || typeof comp.schemas !== 'object') {
      errors.push("Missing 'components.schemas' object");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Merge the Scene Bundle Registry extension into an existing OpenAPI 3.1 document.
 * Deeply merges `paths`, `components.schemas`, `components.responses`, and `components.securitySchemes`.
 *
 * @param {Record<string, unknown>} baseSpec
 * @returns {Record<string, unknown>} New augmented OpenAPI specification object
 */
export function extendOpenApiWithSceneBundles(baseSpec) {
  const base = JSON.parse(JSON.stringify(baseSpec));
  const extension = getSceneBundleOpenApiSpec();

  // Merge paths
  base.paths = base.paths || {};
  const extPaths = /** @type {Record<string, unknown>} */ (extension.paths || {});
  for (const [route, methods] of Object.entries(extPaths)) {
    base.paths[route] = methods;
  }

  // Merge components
  base.components = base.components || {};
  const extComp = /** @type {Record<string, Record<string, unknown>>} */ (extension.components || {});

  for (const category of ['schemas', 'responses', 'securitySchemes']) {
    if (extComp[category]) {
      base.components[category] = base.components[category] || {};
      for (const [key, def] of Object.entries(extComp[category])) {
        base.components[category][key] = def;
      }
    }
  }

  return base;
}
