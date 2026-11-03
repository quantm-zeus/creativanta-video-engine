/**
 * Canonical JSON Schema and OpenAPI 3.1 accessors.
 * Canonical specifications: packages/contracts/schemas/
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate schema directory whether running from src/ or dist/
function resolveSchemaPath(filename: string): string {
  const directPath = path.resolve(__dirname, '../../schemas', filename);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  const altPath = path.resolve(__dirname, '../schemas', filename);
  if (fs.existsSync(altPath)) {
    return altPath;
  }
  return directPath;
}

export function getSceneSchema(): Record<string, unknown> {
  const filePath = resolveSchemaPath('scene.schema.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function getOpenApiSpec(): Record<string, unknown> {
  const filePath = resolveSchemaPath('openapi.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Returns a fully dereferenced and expanded JSON Schema where all local
 * #/$defs/... fragments are substituted inline.
 */
export function getExpandedSceneSchema(): Record<string, unknown> {
  const schema = getSceneSchema();
  const defs = (schema['$defs'] || {}) as Record<string, Record<string, unknown>>;

  function expand(obj: unknown, depth = 0): unknown {
    if (depth > 20 || obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => expand(item, depth + 1));
    }
    const record = obj as Record<string, unknown>;
    if (typeof record['$ref'] === 'string' && record['$ref'].startsWith('#/$defs/')) {
      const defKey = record['$ref'].replace('#/$defs/', '');
      const targetDef = defs[defKey];
      if (targetDef) {
        // Expand target definition recursively
        const expandedTarget = expand(targetDef, depth + 1) as Record<string, unknown>;
        const merged = { ...expandedTarget };
        for (const [k, v] of Object.entries(record)) {
          if (k !== '$ref') {
            merged[k] = expand(v, depth + 1);
          }
        }
        return merged;
      }
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = expand(v, depth + 1);
    }
    return result;
  }

  const expanded = expand(schema) as Record<string, unknown>;
  return expanded;
}
