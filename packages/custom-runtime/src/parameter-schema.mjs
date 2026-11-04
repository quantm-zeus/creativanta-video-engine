// @ts-check
/**
 * Parameter Schema Definition and Validation for Scene Bundles (Task P7-02).
 * Conforms to JSON Schema 2020-12 / OpenAPI 3.1 schema semantics,
 * enforcing bounds, type safety, default value verification, and prototype pollution defenses.
 */

import { CustomRuntimeError } from './adr-policy.mjs';

/**
 * Maximum parameters allowed in a scene bundle parameter schema.
 * Aligns with template variables limit in docs/API.md (max 64 variables).
 */
export const MAX_BUNDLE_PARAMETERS = 64;

/**
 * Maximum string length for parameter string values.
 */
export const MAX_PARAMETER_STRING_LENGTH = 10_000;

/**
 * Maximum array items for array parameters.
 */
export const MAX_PARAMETER_ARRAY_ITEMS = 1_000;

/**
 * Supported primitive and composite parameter types.
 */
export const SUPPORTED_PARAMETER_TYPES = Object.freeze([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);

/**
 * Permitted UI component hints for authoring tools and client UI.
 */
export const PERMITTED_UI_COMPONENTS = Object.freeze([
  'text',
  'textarea',
  'color',
  'number-slider',
  'number-input',
  'toggle',
  'select',
  'asset-picker',
  'font-picker',
  'json-editor',
]);

/**
 * Parameter property name regex: alphanumeric and underscores, length 1..64.
 */
const PARAMETER_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * Dangerous keys to block to prevent prototype pollution.
 */
const FORBIDDEN_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Hex color regex (#RGB, #RGBA, #RRGGBB, #RRGGBBAA).
 */
const COLOR_HEX_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Check if a regex string possesses known catastrophic backtracking (ReDoS) patterns.
 * @param {string} pattern
 * @returns {boolean}
 */
export function hasCatastrophicBacktrackingRisk(pattern) {
  if (typeof pattern !== 'string') return true;
  // Detect nested quantifiers such as (a+)+, (.*a)*, (a|b+)+, ([a-z]+)*
  const nestedQuantifierRegex = /\([^)]*([+*]|\{\d+,?\d*\})[^)]*\)([+*]|\{\d+,?\d*\})/;
  if (nestedQuantifierRegex.test(pattern)) return true;
  // Detect overlapping repetitions like (a|a)+
  if (/\(([^|)]+)\|\1\)[+*]/.test(pattern)) return true;
  return false;
}

/**
 * Validate that a parameter schema definition is structurally valid and secure.
 * @param {unknown} schema
 * @param {object} [options]
 * @param {boolean} [options.strict=true]
 * @returns {{ valid: boolean; errors: string[] }}
 */
export function validateParameterSchemaDefinition(schema, options = {}) {
  const { strict = true } = options;
  const errors = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push('Parameter schema must be a non-null JSON object');
    if (strict) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Invalid parameter schema definition: ${errors.join('; ')}`,
        false,
        { errors },
      );
    }
    return { valid: false, errors };
  }

  const s = /** @type {Record<string, unknown>} */ (schema);

  // Check prototype pollution attempt
  for (const key of Object.keys(s)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      errors.push(`Forbidden prototype key in schema: "${key}"`);
    }
  }

  // Schema type must be object
  if (s.type !== 'object') {
    errors.push(`Root parameter schema type must be 'object', received: '${String(s.type)}'`);
  }

  // Properties mapping
  const properties = s.properties;
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      errors.push("'properties' must be a JSON object mapping property names to schema definitions");
    } else {
      const propEntries = Object.entries(properties);
      if (propEntries.length > MAX_BUNDLE_PARAMETERS) {
        errors.push(
          `Too many parameters: ${propEntries.length} exceeds maximum limit of ${MAX_BUNDLE_PARAMETERS}`,
        );
      }

      for (const [propName, propDef] of propEntries) {
        if (FORBIDDEN_OBJECT_KEYS.has(propName)) {
          errors.push(`Forbidden property name: "${propName}"`);
          continue;
        }

        if (!PARAMETER_NAME_REGEX.test(propName)) {
          errors.push(
            `Invalid parameter name "${propName}": must match pattern ^[a-zA-Z][a-zA-Z0-9_]{0,63}$`,
          );
        }

        validatePropertyDefinition(propName, propDef, errors);
      }
    }
  }

  // Required properties check
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) {
      errors.push("'required' must be an array of parameter names");
    } else {
      const propMap = typeof s.properties === 'object' && s.properties !== null ? s.properties : {};
      for (const reqKey of s.required) {
        if (typeof reqKey !== 'string') {
          errors.push(`Required entry must be a string, got ${typeof reqKey}`);
        } else if (!Object.prototype.hasOwnProperty.call(propMap, reqKey)) {
          errors.push(`Required parameter "${reqKey}" is not declared in 'properties'`);
        }
      }
    }
  }

  // Disallow remote $ref
  if (s.$ref !== undefined) {
    if (typeof s.$ref === 'string' && /^(https?|ftp|file):/i.test(s.$ref)) {
      errors.push(`Remote or external $ref URIs are strictly forbidden: "${s.$ref}"`);
    }
  }

  const valid = errors.length === 0;
  if (!valid && strict) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Invalid parameter schema definition: ${errors.join('; ')}`,
      false,
      { errors },
    );
  }

  return { valid, errors };
}

/**
 * Validate an individual property schema definition.
 * @param {string} propName
 * @param {unknown} def
 * @param {string[]} errors
 */
function validatePropertyDefinition(propName, def, errors) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    errors.push(`Property "${propName}" schema must be a non-null JSON object`);
    return;
  }

  const p = /** @type {Record<string, unknown>} */ (def);

  for (const key of Object.keys(p)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      errors.push(`Forbidden prototype key in property "${propName}": "${key}"`);
    }
  }

  // Type verification
  if (!p.type || typeof p.type !== 'string' || !SUPPORTED_PARAMETER_TYPES.includes(p.type)) {
    errors.push(
      `Property "${propName}" has invalid or missing type: '${String(p.type)}'. Supported types: ${SUPPORTED_PARAMETER_TYPES.join(', ')}`,
    );
    return;
  }

  // UI component verification
  if (p.ui_component !== undefined) {
    if (typeof p.ui_component !== 'string' || !PERMITTED_UI_COMPONENTS.includes(p.ui_component)) {
      errors.push(
        `Property "${propName}" has invalid ui_component: '${String(p.ui_component)}'. Permitted: ${PERMITTED_UI_COMPONENTS.join(', ')}`,
      );
    }
  }

  // Type specific validations
  if (p.type === 'string') {
    if (p.maxLength !== undefined) {
      if (typeof p.maxLength !== 'number' || !Number.isInteger(p.maxLength) || p.maxLength < 0 || p.maxLength > MAX_PARAMETER_STRING_LENGTH) {
        errors.push(
          `Property "${propName}" maxLength must be an integer between 0 and ${MAX_PARAMETER_STRING_LENGTH}`,
        );
      }
    }
    if (p.minLength !== undefined) {
      if (typeof p.minLength !== 'number' || !Number.isInteger(p.minLength) || p.minLength < 0) {
        errors.push(`Property "${propName}" minLength must be a non-negative integer`);
      }
    }
    if (p.pattern !== undefined) {
      if (typeof p.pattern !== 'string') {
        errors.push(`Property "${propName}" pattern must be a string`);
      } else {
        if (hasCatastrophicBacktrackingRisk(p.pattern)) {
          errors.push(`Property "${propName}" pattern has unsafe backtracking/ReDoS pattern`);
        }
        try {
          new RegExp(p.pattern);
        } catch (e) {
          errors.push(`Property "${propName}" invalid regular expression pattern: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (p.enum !== undefined) {
      if (!Array.isArray(p.enum) || p.enum.some((item) => typeof item !== 'string')) {
        errors.push(`Property "${propName}" string enum must be an array of strings`);
      }
    }
    if (p.format !== undefined) {
      if (typeof p.format !== 'string') {
        errors.push(`Property "${propName}" format must be a string`);
      }
    }
  } else if (p.type === 'number' || p.type === 'integer') {
    if (p.minimum !== undefined && (typeof p.minimum !== 'number' || !Number.isFinite(p.minimum))) {
      errors.push(`Property "${propName}" minimum must be a finite number`);
    }
    if (p.maximum !== undefined && (typeof p.maximum !== 'number' || !Number.isFinite(p.maximum))) {
      errors.push(`Property "${propName}" maximum must be a finite number`);
    }
    if (p.multipleOf !== undefined && (typeof p.multipleOf !== 'number' || p.multipleOf <= 0 || !Number.isFinite(p.multipleOf))) {
      errors.push(`Property "${propName}" multipleOf must be a positive finite number`);
    }
    if (p.minimum !== undefined && p.maximum !== undefined && Number(p.minimum) > Number(p.maximum)) {
      errors.push(`Property "${propName}" minimum (${p.minimum}) cannot exceed maximum (${p.maximum})`);
    }
  } else if (p.type === 'array') {
    if (p.items !== undefined) {
      validatePropertyDefinition(`${propName}[]`, p.items, errors);
    }
    if (p.maxItems !== undefined && (typeof p.maxItems !== 'number' || !Number.isInteger(p.maxItems) || p.maxItems < 0 || p.maxItems > MAX_PARAMETER_ARRAY_ITEMS)) {
      errors.push(`Property "${propName}" maxItems must be an integer between 0 and ${MAX_PARAMETER_ARRAY_ITEMS}`);
    }
  } else if (p.type === 'object') {
    if (p.properties !== undefined && typeof p.properties === 'object' && p.properties !== null) {
      for (const [subName, subDef] of Object.entries(p.properties)) {
        validatePropertyDefinition(`${propName}.${subName}`, subDef, errors);
      }
    }
  }

  // Validate default value against its own schema constraints
  if (p.default !== undefined) {
    const defaultValidation = validateSingleValue(p, p.default, propName);
    if (!defaultValidation.valid) {
      for (const err of defaultValidation.errors) {
        errors.push(`Property "${propName}" declared default value is invalid: ${err.message}`);
      }
    }
  }
}

/**
 * Structured validation error item.
 * @typedef {{ pointer: string; message: string; code: string }} ValidationErrorItem
 */

/**
 * Validate a single value against a property definition.
 * @param {Record<string, unknown>} propDef
 * @param {unknown} value
 * @param {string} path
 * @returns {{ valid: boolean; errors: ValidationErrorItem[] }}
 */
function validateSingleValue(propDef, value, path) {
  const errors = [];
  const pointer = `/${path.replace(/\./g, '/')}`;

  const type = /** @type {string} */ (propDef.type);

  if (value === null || value === undefined) {
    errors.push({
      pointer,
      message: `Value at ${pointer} cannot be null or undefined`,
      code: 'TYPE_MISMATCH',
    });
    return { valid: false, errors };
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push({
        pointer,
        message: `Expected string at ${pointer}, received ${typeof value}`,
        code: 'TYPE_MISMATCH',
      });
      return { valid: false, errors };
    }
    if (value.length > MAX_PARAMETER_STRING_LENGTH) {
      errors.push({
        pointer,
        message: `String at ${pointer} exceeds maximum length of ${MAX_PARAMETER_STRING_LENGTH}`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.minLength !== undefined && value.length < Number(propDef.minLength)) {
      errors.push({
        pointer,
        message: `String at ${pointer} length (${value.length}) is below minLength (${propDef.minLength})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.maxLength !== undefined && value.length > Number(propDef.maxLength)) {
      errors.push({
        pointer,
        message: `String at ${pointer} length (${value.length}) exceeds maxLength (${propDef.maxLength})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.pattern !== undefined && typeof propDef.pattern === 'string') {
      try {
        const reg = new RegExp(propDef.pattern);
        if (!reg.test(value)) {
          errors.push({
            pointer,
            message: `String at ${pointer} does not match required pattern "${propDef.pattern}"`,
            code: 'PATTERN_MISMATCH',
          });
        }
      } catch {
        // pattern validity is checked at schema compile time
      }
    }
    if (Array.isArray(propDef.enum)) {
      if (!propDef.enum.includes(value)) {
        errors.push({
          pointer,
          message: `String at ${pointer} must be one of: ${propDef.enum.join(', ')}`,
          code: 'ENUM_MISMATCH',
        });
      }
    }
    if (propDef.format === 'color') {
      if (!COLOR_HEX_REGEX.test(value)) {
        errors.push({
          pointer,
          message: `String at ${pointer} is not a valid hex color format (#RGB, #RRGGBB, #RRGGBBAA)`,
          code: 'PATTERN_MISMATCH',
        });
      }
    }
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({
        pointer,
        message: `Expected finite number at ${pointer}, received ${String(value)}`,
        code: 'TYPE_MISMATCH',
      });
      return { valid: false, errors };
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      errors.push({
        pointer,
        message: `Expected integer at ${pointer}, received non-integer number ${value}`,
        code: 'TYPE_MISMATCH',
      });
    }
    if (propDef.minimum !== undefined && value < Number(propDef.minimum)) {
      errors.push({
        pointer,
        message: `Number at ${pointer} (${value}) is less than minimum (${propDef.minimum})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.maximum !== undefined && value > Number(propDef.maximum)) {
      errors.push({
        pointer,
        message: `Number at ${pointer} (${value}) exceeds maximum (${propDef.maximum})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.multipleOf !== undefined) {
      const mult = Number(propDef.multipleOf);
      const rem = Math.abs(value % mult);
      if (rem > 1e-9 && Math.abs(rem - mult) > 1e-9) {
        errors.push({
          pointer,
          message: `Number at ${pointer} (${value}) is not a multiple of ${mult}`,
          code: 'OUT_OF_RANGE',
        });
      }
    }
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({
        pointer,
        message: `Expected boolean at ${pointer}, received ${typeof value}`,
        code: 'TYPE_MISMATCH',
      });
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({
        pointer,
        message: `Expected array at ${pointer}, received ${typeof value}`,
        code: 'TYPE_MISMATCH',
      });
      return { valid: false, errors };
    }
    if (value.length > MAX_PARAMETER_ARRAY_ITEMS) {
      errors.push({
        pointer,
        message: `Array at ${pointer} exceeds maximum items (${MAX_PARAMETER_ARRAY_ITEMS})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.minItems !== undefined && value.length < Number(propDef.minItems)) {
      errors.push({
        pointer,
        message: `Array at ${pointer} items (${value.length}) below minItems (${propDef.minItems})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.maxItems !== undefined && value.length > Number(propDef.maxItems)) {
      errors.push({
        pointer,
        message: `Array at ${pointer} items (${value.length}) exceeds maxItems (${propDef.maxItems})`,
        code: 'OUT_OF_RANGE',
      });
    }
    if (propDef.items && typeof propDef.items === 'object') {
      const itemDef = /** @type {Record<string, unknown>} */ (propDef.items);
      for (let i = 0; i < value.length; i++) {
        const itemResult = validateSingleValue(itemDef, value[i], `${path}[${i}]`);
        errors.push(...itemResult.errors);
      }
    }
  } else if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({
        pointer,
        message: `Expected object at ${pointer}, received ${typeof value}`,
        code: 'TYPE_MISMATCH',
      });
      return { valid: false, errors };
    }
    const valObj = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(valObj)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        errors.push({
          pointer: `${pointer}/${key}`,
          message: `Forbidden prototype pollution key "${key}" detected at ${pointer}`,
          code: 'SECURITY_VIOLATION',
        });
      }
    }
    if (propDef.properties && typeof propDef.properties === 'object') {
      const childProps = /** @type {Record<string, unknown>} */ (propDef.properties);
      for (const [k, v] of Object.entries(childProps)) {
        if (Object.prototype.hasOwnProperty.call(valObj, k)) {
          const childResult = validateSingleValue(/** @type {Record<string, unknown>} */ (v), valObj[k], `${path}.${k}`);
          errors.push(...childResult.errors);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate input parameters against a compiled/validated parameter schema.
 * Automatically injects declared default values for omitted properties.
 *
 * @param {Record<string, unknown>} schema - The parameter schema definition
 * @param {Record<string, unknown> | null | undefined} rawParameters - The parameter values supplied by caller
 * @param {object} [options]
 * @param {boolean} [options.allowAdditionalProperties=false]
 * @returns {{
 *   valid: boolean;
 *   errors: ValidationErrorItem[];
 *   validatedParameters: Record<string, unknown>;
 * }}
 */
export function validateBundleParameters(schema, rawParameters, options = {}) {
  const { allowAdditionalProperties = false } = options;
  const errors = /** @type {ValidationErrorItem[]} */ ([]);

  // Validate the schema first
  validateParameterSchemaDefinition(schema, { strict: true });

  const input = rawParameters && typeof rawParameters === 'object' && !Array.isArray(rawParameters)
    ? { ...rawParameters }
    : {};

  // Check for prototype pollution in input
  if (rawParameters && typeof rawParameters === 'object') {
    const ownNames = Object.getOwnPropertyNames(rawParameters);
    for (const key of ownNames) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        errors.push({
          pointer: `/${key}`,
          message: `Forbidden prototype pollution key "${key}" in parameter input`,
          code: 'SECURITY_VIOLATION',
        });
      }
    }
    const proto = Object.getPrototypeOf(rawParameters);
    if (proto !== Object.prototype && proto !== null) {
      errors.push({
        pointer: '/__proto__',
        message: 'Object with modified prototype detected in parameter input',
        code: 'SECURITY_VIOLATION',
      });
    }
  }

  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? /** @type {Record<string, Record<string, unknown>>} */ (schema.properties)
    : {};

  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  const validatedParameters = /** @type {Record<string, unknown>} */ ({});

  // Check unknown parameters
  if (!allowAdditionalProperties && schema.additionalProperties !== true) {
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push({
          pointer: `/${key}`,
          message: `Unknown parameter "${key}" not declared in parameter schema`,
          code: 'UNKNOWN_PARAMETER',
        });
      }
    }
  }

  // Iterate over declared schema properties
  for (const [propName, propDef] of Object.entries(properties)) {
    const isProvided = Object.prototype.hasOwnProperty.call(input, propName);
    let val = isProvided ? input[propName] : undefined;

    if (val === undefined) {
      if (propDef.default !== undefined) {
        // Deep copy default value if composite
        val = typeof propDef.default === 'object' && propDef.default !== null
          ? JSON.parse(JSON.stringify(propDef.default))
          : propDef.default;
      } else if (requiredList.includes(propName)) {
        errors.push({
          pointer: `/${propName}`,
          message: `Missing required parameter "${propName}"`,
          code: 'REQUIRED_FIELD_MISSING',
        });
        continue;
      } else {
        // Optional property without default, skip
        continue;
      }
    }

    const check = validateSingleValue(propDef, val, propName);
    if (!check.valid) {
      errors.push(...check.errors);
    } else {
      validatedParameters[propName] = val;
    }
  }

  // If additional properties are allowed, pass through other keys
  if (allowAdditionalProperties || schema.additionalProperties === true) {
    for (const [key, value] of Object.entries(input)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        validatedParameters[key] = value;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    validatedParameters: errors.length === 0 ? validatedParameters : {},
  };
}

/**
 * Extract resolved default parameter values from a parameter schema.
 * @param {Record<string, unknown>} schema
 * @returns {Record<string, unknown>}
 */
export function extractParameterSchemaDefaults(schema) {
  validateParameterSchemaDefinition(schema, { strict: true });
  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? /** @type {Record<string, Record<string, unknown>>} */ (schema.properties)
    : {};

  const defaults = /** @type {Record<string, unknown>} */ ({});
  for (const [name, propDef] of Object.entries(properties)) {
    if (propDef.default !== undefined) {
      defaults[name] = typeof propDef.default === 'object' && propDef.default !== null
        ? JSON.parse(JSON.stringify(propDef.default))
        : propDef.default;
    }
  }
  return defaults;
}
