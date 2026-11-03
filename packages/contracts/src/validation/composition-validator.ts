/**
 * Native JSON Schema 2020-12 validator for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md and packages/contracts/schemas/scene.schema.json
 */

import { getSceneSchema } from '../schemas/index.js';
import { CompositionSpec } from '../types/scene.js';

export type ValidationErrorCode =
  | 'OUT_OF_RANGE'
  | 'TYPE_MISMATCH'
  | 'UNKNOWN_FIELD'
  | 'MISSING_REQUIRED_FIELD'
  | 'PATTERN_MISMATCH'
  | 'ENUM_MISMATCH'
  | 'ONE_OF_MISMATCH';

export interface ValidationError {
  pointer: string;
  code: ValidationErrorCode;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export class JsonSchemaValidator {
  private rootSchema: Record<string, unknown>;
  private defs: Record<string, Record<string, unknown>>;

  constructor(schema?: Record<string, unknown>) {
    this.rootSchema = schema || getSceneSchema();
    this.defs = (this.rootSchema['$defs'] || {}) as Record<string, Record<string, unknown>>;
  }

  public validate(data: unknown): ValidationResult {
    const errors: ValidationError[] = [];
    this.validateNode(data, this.rootSchema, '', errors);
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private resolveSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (typeof schema['$ref'] === 'string' && schema['$ref'].startsWith('#/$defs/')) {
      const defKey = schema['$ref'].replace('#/$defs/', '');
      const def = this.defs[defKey];
      if (def) {
        return def;
      }
    }
    return schema;
  }

  private validateNode(
    data: unknown,
    schemaNode: Record<string, unknown>,
    pointer: string,
    errors: ValidationError[]
  ): void {
    const schema = this.resolveSchema(schemaNode);

    // 1. Check oneOf
    if (Array.isArray(schema['oneOf'])) {
      const subSchemas = schema['oneOf'] as Record<string, unknown>[];
      const matchResults: { idx: number; errors: ValidationError[] }[] = [];

      for (let i = 0; i < subSchemas.length; i++) {
        const subSchema = subSchemas[i]!;
        const subErrors: ValidationError[] = [];
        this.validateNode(data, subSchema, pointer, subErrors);
        matchResults.push({ idx: i, errors: subErrors });
      }

      const passed = matchResults.filter((r) => r.errors.length === 0);
      if (passed.length === 1) {
        return; // Valid oneOf match
      } else if (passed.length === 0) {
        const minErrorsBranch = matchResults.reduce((prev, curr) =>
          curr.errors.length < prev.errors.length ? curr : prev
        );
        if (minErrorsBranch && minErrorsBranch.errors.length > 0) {
          for (const err of minErrorsBranch.errors) {
            errors.push(err);
          }
        } else {
          errors.push({
            pointer: pointer || '/',
            code: 'ONE_OF_MISMATCH',
            message: 'Value does not match any valid schema variant',
          });
        }
        return;
      } else {
        errors.push({
          pointer: pointer || '/',
          code: 'ONE_OF_MISMATCH',
          message: `Value matches ${passed.length} schema variants (exactly 1 required)`,
        });
        return;
      }
    }

    // 2. Check anyOf
    if (Array.isArray(schema['anyOf'])) {
      const subSchemas = schema['anyOf'] as Record<string, unknown>[];
      const matchResults: ValidationError[][] = [];
      let anyPassed = false;

      for (const sub of subSchemas) {
        const subErrors: ValidationError[] = [];
        this.validateNode(data, sub, pointer, subErrors);
        if (subErrors.length === 0) {
          anyPassed = true;
          break;
        }
        matchResults.push(subErrors);
      }

      if (!anyPassed) {
        const closest = matchResults.reduce((prev, curr) =>
          curr.length < prev.length ? curr : prev
        );
        for (const err of closest) {
          errors.push(err);
        }
        return;
      }
    }

    // 3. Check allOf
    if (Array.isArray(schema['allOf'])) {
      for (const sub of schema['allOf'] as Record<string, unknown>[]) {
        this.validateNode(data, sub, pointer, errors);
      }
    }

    // 4. Check if / then / else
    if (schema['if'] && typeof schema['if'] === 'object') {
      const ifErrors: ValidationError[] = [];
      this.validateNode(data, schema['if'] as Record<string, unknown>, pointer, ifErrors);
      if (ifErrors.length === 0) {
        if (schema['then'] && typeof schema['then'] === 'object') {
          this.validateNode(data, schema['then'] as Record<string, unknown>, pointer, errors);
        }
      } else if (schema['else'] && typeof schema['else'] === 'object') {
        this.validateNode(data, schema['else'] as Record<string, unknown>, pointer, errors);
      }
    }

    // 5. Check const
    if ('const' in schema) {
      if (data !== schema['const']) {
        errors.push({
          pointer: pointer || '/',
          code: 'ENUM_MISMATCH',
          message: `Expected constant value ${JSON.stringify(schema['const'])}, received ${JSON.stringify(data)}`,
        });
        return;
      }
    }

    // 6. Check enum
    if (Array.isArray(schema['enum'])) {
      if (!schema['enum'].includes(data)) {
        errors.push({
          pointer: pointer || '/',
          code: 'ENUM_MISMATCH',
          message: `Value ${JSON.stringify(data)} not in allowlist [${schema['enum'].map((x) => JSON.stringify(x)).join(', ')}]`,
        });
        return;
      }
    }

    // 7. Check type
    if (schema['type']) {
      const type = schema['type'] as string | string[];
      const actualType = this.getTypeOf(data);
      const allowed = Array.isArray(type) ? type : [type];

      let typeMatches = false;
      for (const t of allowed) {
        if (t === 'integer' && typeof data === 'number' && Number.isInteger(data)) {
          typeMatches = true;
          break;
        } else if (t === actualType) {
          typeMatches = true;
          break;
        }
      }

      if (!typeMatches) {
        errors.push({
          pointer: pointer || '/',
          code: 'TYPE_MISMATCH',
          message: `Expected type ${Array.isArray(type) ? type.join(' | ') : type}, received ${actualType}`,
        });
        return;
      }
    }

    // 8. String validations
    if (typeof data === 'string') {
      if (typeof schema['minLength'] === 'number' && data.length < schema['minLength']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `String length ${data.length} is shorter than minimum length ${schema['minLength']}`,
        });
      }
      if (typeof schema['maxLength'] === 'number' && data.length > schema['maxLength']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `String length ${data.length} exceeds maximum length ${schema['maxLength']}`,
        });
      }
      if (typeof schema['pattern'] === 'string') {
        const regex = new RegExp(schema['pattern']);
        if (!regex.test(data)) {
          errors.push({
            pointer: pointer || '/',
            code: 'PATTERN_MISMATCH',
            message: `String does not match pattern ${schema['pattern']}`,
          });
        }
      }
    }

    // 9. Number validations
    if (typeof data === 'number') {
      if (typeof schema['minimum'] === 'number' && data < schema['minimum']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Value ${data} is less than minimum ${schema['minimum']}`,
        });
      }
      if (typeof schema['maximum'] === 'number' && data > schema['maximum']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Value ${data} exceeds maximum ${schema['maximum']}`,
        });
      }
      if (typeof schema['exclusiveMinimum'] === 'number' && data <= schema['exclusiveMinimum']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Value ${data} must be strictly greater than ${schema['exclusiveMinimum']}`,
        });
      }
      if (typeof schema['exclusiveMaximum'] === 'number' && data >= schema['exclusiveMaximum']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Value ${data} must be strictly less than ${schema['exclusiveMaximum']}`,
        });
      }
      if (typeof schema['multipleOf'] === 'number' && schema['multipleOf'] > 0) {
        if (data % schema['multipleOf'] !== 0) {
          errors.push({
            pointer: pointer || '/',
            code: 'OUT_OF_RANGE',
            message: `Value ${data} is not a multiple of ${schema['multipleOf']}`,
          });
        }
      }
    }

    // 10. Array validations
    if (Array.isArray(data)) {
      if (typeof schema['minItems'] === 'number' && data.length < schema['minItems']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Array length ${data.length} is less than minItems ${schema['minItems']}`,
        });
      }
      if (typeof schema['maxItems'] === 'number' && data.length > schema['maxItems']) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Array length ${data.length} exceeds maxItems ${schema['maxItems']}`,
        });
      }
      if (schema['items'] && typeof schema['items'] === 'object') {
        const itemSchema = schema['items'] as Record<string, unknown>;
        for (let i = 0; i < data.length; i++) {
          this.validateNode(data[i], itemSchema, `${pointer}/${i}`, errors);
        }
      }
    }

    // 11. Object validations
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const properties = (schema['properties'] || {}) as Record<string, Record<string, unknown>>;
      const required = (schema['required'] || []) as string[];

      // Check required fields
      for (const reqKey of required) {
        if (!(reqKey in record) || record[reqKey] === undefined) {
          errors.push({
            pointer: `${pointer}/${reqKey}`,
            code: 'MISSING_REQUIRED_FIELD',
            message: `Missing required field: ${reqKey}`,
          });
        }
      }

      // Check additionalProperties: false
      if (schema['additionalProperties'] === false) {
        for (const actualKey of Object.keys(record)) {
          if (!(actualKey in properties)) {
            errors.push({
              pointer: `${pointer}/${actualKey}`,
              code: 'UNKNOWN_FIELD',
              message: `Unknown field '${actualKey}' not allowed by closed schema`,
            });
          }
        }
      } else if (
        typeof schema['additionalProperties'] === 'object' &&
        schema['additionalProperties'] !== null
      ) {
        const addPropSchema = schema['additionalProperties'] as Record<string, unknown>;
        for (const actualKey of Object.keys(record)) {
          if (!(actualKey in properties)) {
            this.validateNode(record[actualKey], addPropSchema, `${pointer}/${actualKey}`, errors);
          }
        }
      }

      // Check propertyNames
      if (typeof schema['propertyNames'] === 'object' && schema['propertyNames'] !== null) {
        const nameSchema = schema['propertyNames'] as Record<string, unknown>;
        for (const actualKey of Object.keys(record)) {
          this.validateNode(actualKey, nameSchema, `${pointer}/[key:${actualKey}]`, errors);
        }
      }

      // Check maxProperties
      if (
        typeof schema['maxProperties'] === 'number' &&
        Object.keys(record).length > schema['maxProperties']
      ) {
        errors.push({
          pointer: pointer || '/',
          code: 'OUT_OF_RANGE',
          message: `Object has ${Object.keys(record).length} keys, exceeding maxProperties ${schema['maxProperties']}`,
        });
      }

      // Validate defined properties
      for (const [propKey, propVal] of Object.entries(record)) {
        if (propKey in properties && propVal !== undefined) {
          this.validateNode(propVal, properties[propKey]!, `${pointer}/${propKey}`, errors);
        }
      }
    }
  }

  private getTypeOf(val: unknown): string {
    if (val === null) return 'null';
    if (Array.isArray(val)) return 'array';
    return typeof val;
  }
}

/**
 * Validates composition data against the canonical JSON Schema 2020-12.
 */
export function validateCompositionSchema(data: unknown): ValidationResult {
  const validator = new JsonSchemaValidator();
  return validator.validate(data);
}

/**
 * Asserts that data conforms to CompositionSpec schema, throwing an error with details if invalid.
 */
export function assertValidComposition(data: unknown): asserts data is CompositionSpec {
  const result = validateCompositionSchema(data);
  if (!result.valid) {
    const first = result.errors[0];
    const err = new Error(
      `Composition schema validation failed: [${first?.code}] ${first?.pointer}: ${first?.message} (total ${result.errors.length} errors)`
    );
    (err as unknown as { validationErrors: ValidationError[] }).validationErrors = result.errors;
    throw err;
  }
}
