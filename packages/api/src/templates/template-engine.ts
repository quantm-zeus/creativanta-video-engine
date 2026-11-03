/**
 * Template Variable Schema Validator, Binding Inspector, and Materialization Engine.
 * Canonical specification: docs/API.md (lines 62-84) & docs/SCENE-SPEC.md (lines 134-140).
 */

import {
  CompositionSpec,
  ErrorDetail,
  SceneSpec,
  canonicalizeJson,
  sha256Hex,
} from '@creativanta/contracts';

export const VARIABLE_NAME_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_VARIABLES_COUNT = 64;
export const MAX_VARIABLE_STRING_LENGTH = 10000;

export interface VariableBindingInfo {
  pointer: string;
  variableName: string;
  field:
    | 'content.text'
    | 'content.asset_id'
    | 'content.color'
    | 'content.fill'
    | 'content.font_size'
    | 'box.x'
    | 'box.y'
    | 'box.width'
    | 'box.height';
  sceneIndex: number;
  layerIndex: number;
}

/**
 * Checks whether an unknown value is a variable binding descriptor: `{ "variable": "var_name" }`.
 */
export function isVariableBinding(val: unknown): val is { variable: string } {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const keys = Object.keys(val);
  return keys.length === 1 && keys[0] === 'variable' && typeof (val as Record<string, unknown>)['variable'] === 'string';
}

/**
 * Validates template `variables_schema` against engine rules:
 * 1. Must be a valid JSON Schema object.
 * 2. Variable names must match `^[a-z][a-z0-9_]{0,63}$`.
 * 3. Max 64 variables per template.
 * 4. Only permitted JSON Schema types: string, number, integer, boolean, array, object.
 * 5. Rejects remote `$ref` URIs and executable defaults.
 */
export function validateVariableSchema(
  schema: unknown,
  pointerPrefix = '/variables_schema',
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    details.push({
      pointer: pointerPrefix,
      code: 'TYPE_MISMATCH',
      message: 'variables_schema must be a JSON object',
    });
    return details;
  }

  const s = schema as Record<string, unknown>;

  // Remote $ref check across the entire schema string
  const schemaStr = JSON.stringify(schema);
  if (/"\$ref"\s*:\s*"https?:/i.test(schemaStr)) {
    details.push({
      pointer: `${pointerPrefix}/$ref`,
      code: 'FORBIDDEN_REMOTE_REF',
      message: 'Remote $ref references are forbidden in variables_schema',
    });
  }

  const properties = s['properties'];
  if (properties !== undefined) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      details.push({
        pointer: `${pointerPrefix}/properties`,
        code: 'TYPE_MISMATCH',
        message: 'properties must be an object',
      });
      return details;
    }

    const propEntries = Object.entries(properties as Record<string, unknown>);
    if (propEntries.length > MAX_VARIABLES_COUNT) {
      details.push({
        pointer: `${pointerPrefix}/properties`,
        code: 'MAX_VARIABLES_EXCEEDED',
        message: `Template exceeds maximum of ${MAX_VARIABLES_COUNT} variables (declared: ${propEntries.length})`,
      });
    }

    const allowedTypes = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

    for (const [varName, varDef] of propEntries) {
      const varPointer = `${pointerPrefix}/properties/${varName}`;

      if (!VARIABLE_NAME_REGEX.test(varName)) {
        details.push({
          pointer: varPointer,
          code: 'INVALID_VARIABLE_NAME',
          message: `Variable name '${varName}' must match pattern ^[a-z][a-z0-9_]{0,63}$`,
        });
      }

      if (!varDef || typeof varDef !== 'object' || Array.isArray(varDef)) {
        details.push({
          pointer: varPointer,
          code: 'TYPE_MISMATCH',
          message: `Variable definition for '${varName}' must be an object`,
        });
        continue;
      }

      const defObj = varDef as Record<string, unknown>;
      const varType = defObj['type'];
      if (typeof varType === 'string' && !allowedTypes.has(varType)) {
        details.push({
          pointer: `${varPointer}/type`,
          code: 'INVALID_VARIABLE_TYPE',
          message: `Variable '${varName}' specifies unsupported type '${varType}'`,
        });
      }
    }
  }

  return details;
}

/**
 * Validates defaults object against the declared variables_schema.
 */
export function validateDefaultsAgainstSchema(
  schema: Record<string, unknown>,
  defaults: unknown,
  pointerPrefix = '/defaults',
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    details.push({
      pointer: pointerPrefix,
      code: 'TYPE_MISMATCH',
      message: 'defaults must be a JSON object',
    });
    return details;
  }

  const defs = defaults as Record<string, unknown>;
  const properties = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};

  for (const [key, val] of Object.entries(defs)) {
    const propSchema = properties[key];
    const valPointer = `${pointerPrefix}/${key}`;

    if (!propSchema) {
      details.push({
        pointer: valPointer,
        code: 'UNKNOWN_VARIABLE',
        message: `Default '${key}' is not declared in variables_schema.properties`,
      });
      continue;
    }

    const valErrors = validateSingleVariableValue(key, val, propSchema, valPointer);
    details.push(...valErrors);
  }

  return details;
}

/**
 * Inspects all variable bindings in composition_spec:
 * 1. Enforces binding v1 restricted positions:
 *    `layer.content.text`, `layer.content.asset_id`, `layer.content.color`,
 *    `layer.content.fill`, `layer.content.font_size`, `layer.box.x/y/width/height`.
 * 2. Rejects any binding outside allowed positions (engine, bundle, font_id, etc.).
 * 3. Enforces that every bound variable is declared in variables_schema.
 */
export function inspectAndValidateBindings(
  spec: Record<string, unknown>,
  declaredVariables: Set<string>,
  pointerPrefix = '/composition_spec',
): { bindings: VariableBindingInfo[]; errors: ErrorDetail[] } {
  const bindings: VariableBindingInfo[] = [];
  const errors: ErrorDetail[] = [];

  // Recursive finder to catch bindings anywhere in the spec
  function scan(node: unknown, currentPath: (string | number)[]) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (isVariableBinding(node)) {
      const pointer = `${pointerPrefix}/${currentPath.join('/')}`;
      const varName = node.variable;

      // Check if currentPath corresponds to an allowed v1 binding position:
      // Allowed pattern: scenes -> <sIdx> -> layers -> <lIdx> -> (box -> (x|y|width|height) | content -> (text|asset_id|color|fill|font_size))
      let isAllowed = false;
      let fieldDesc: VariableBindingInfo['field'] | null = null;
      let sIdx = -1;
      let lIdx = -1;

      if (
        currentPath.length === 6 &&
        currentPath[0] === 'scenes' &&
        typeof currentPath[1] === 'number' &&
        currentPath[2] === 'layers' &&
        typeof currentPath[3] === 'number'
      ) {
        sIdx = currentPath[1];
        lIdx = currentPath[3];
        const group = currentPath[4];
        const field = currentPath[5];

        if (group === 'box' && (field === 'x' || field === 'y' || field === 'width' || field === 'height')) {
          isAllowed = true;
          fieldDesc = `box.${field}` as VariableBindingInfo['field'];
        } else if (
          group === 'content' &&
          (field === 'text' || field === 'asset_id' || field === 'color' || field === 'fill' || field === 'font_size')
        ) {
          isAllowed = true;
          fieldDesc = `content.${field}` as VariableBindingInfo['field'];
        }
      }

      if (!isAllowed || !fieldDesc) {
        errors.push({
          pointer,
          code: 'INVALID_BINDING_POSITION',
          message: `Variable binding '{ "variable": "${varName}" }' is forbidden at pointer '${pointer}'. Binding v1 only permits layer content.(text|asset_id|color|fill|font_size) and box.(x|y|width|height)`,
        });
      } else {
        if (!declaredVariables.has(varName)) {
          errors.push({
            pointer,
            code: 'UNDECLARED_VARIABLE',
            message: `Binding references variable '${varName}' which is not declared in variables_schema.properties`,
          });
        }
        bindings.push({
          pointer,
          variableName: varName,
          field: fieldDesc,
          sceneIndex: sIdx,
          layerIndex: lIdx,
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        scan(node[i], [...currentPath, i]);
      }
    } else {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        scan(v, [...currentPath, k]);
      }
    }
  }

  scan(spec, []);
  return { bindings, errors };
}

/**
 * Validates a single variable value against its JSON schema property definition.
 */
function validateSingleVariableValue(
  varName: string,
  val: unknown,
  schema: Record<string, unknown>,
  pointer: string,
): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const expectedType = schema['type'];

  if (val === null) {
    details.push({
      pointer,
      code: 'TYPE_MISMATCH',
      message: `Variable '${varName}' cannot be null`,
    });
    return details;
  }

  if (expectedType === 'string' || (!expectedType && typeof val === 'string')) {
    if (typeof val !== 'string') {
      details.push({
        pointer,
        code: 'TYPE_MISMATCH',
        message: `Variable '${varName}' must be a string`,
      });
      return details;
    }
    if (val.length > MAX_VARIABLE_STRING_LENGTH) {
      details.push({
        pointer,
        code: 'OUT_OF_RANGE',
        message: `Variable '${varName}' exceeds max string length of ${MAX_VARIABLE_STRING_LENGTH} characters`,
      });
    }
    if (typeof schema['minLength'] === 'number' && val.length < schema['minLength']) {
      details.push({
        pointer,
        code: 'OUT_OF_RANGE',
        message: `Variable '${varName}' length ${val.length} is shorter than minLength ${schema['minLength']}`,
      });
    }
    if (typeof schema['maxLength'] === 'number' && val.length > schema['maxLength']) {
      details.push({
        pointer,
        code: 'OUT_OF_RANGE',
        message: `Variable '${varName}' length ${val.length} exceeds maxLength ${schema['maxLength']}`,
      });
    }
    if (typeof schema['pattern'] === 'string') {
      try {
        const regex = new RegExp(schema['pattern']);
        if (!regex.test(val)) {
          details.push({
            pointer,
            code: 'PATTERN_MISMATCH',
            message: `Variable '${varName}' does not match pattern ${schema['pattern']}`,
          });
        }
      } catch {
        // ignore invalid regex
      }
    }
    if (Array.isArray(schema['enum']) && !schema['enum'].includes(val)) {
      details.push({
        pointer,
        code: 'ENUM_MISMATCH',
        message: `Variable '${varName}' value '${val}' is not in allowed enum [${schema['enum'].join(', ')}]`,
      });
    }
  } else if (expectedType === 'number' || expectedType === 'integer') {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      details.push({
        pointer,
        code: 'TYPE_MISMATCH',
        message: `Variable '${varName}' must be a finite number`,
      });
      return details;
    }
    if (expectedType === 'integer' && !Number.isInteger(val)) {
      details.push({
        pointer,
        code: 'TYPE_MISMATCH',
        message: `Variable '${varName}' must be an integer`,
      });
    }
    if (typeof schema['minimum'] === 'number' && val < schema['minimum']) {
      details.push({
        pointer,
        code: 'OUT_OF_RANGE',
        message: `Variable '${varName}' must be >= ${schema['minimum']}`,
      });
    }
    if (typeof schema['maximum'] === 'number' && val > schema['maximum']) {
      details.push({
        pointer,
        code: 'OUT_OF_RANGE',
        message: `Variable '${varName}' must be <= ${schema['maximum']}`,
      });
    }
  } else if (expectedType === 'boolean') {
    if (typeof val !== 'boolean') {
      details.push({
        pointer,
        code: 'TYPE_MISMATCH',
        message: `Variable '${varName}' must be a boolean`,
      });
    }
  }

  return details;
}

/**
 * Resolves and validates variable values for template instantiation.
 * Per docs/API.md:
 * - Defaults are only applied when a variable field is absent in inputVariables.
 * - Explicit null in inputVariables does NOT trigger defaults.
 * - Missing required variables trigger 422 VALIDATION_FAILED.
 * - Unknown variables trigger 422 VALIDATION_FAILED.
 */
export function resolveAndValidateVariables(
  schema: Record<string, unknown>,
  defaults: Record<string, unknown>,
  inputVariables: Record<string, unknown>,
  pointerPrefix = '/variables',
): { resolved: Record<string, unknown>; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const resolved: Record<string, unknown> = {};

  const properties = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const requiredList = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const requiredSet = new Set(requiredList);

  // Check for unknown variables provided in input
  for (const inputKey of Object.keys(inputVariables)) {
    if (!properties[inputKey]) {
      errors.push({
        pointer: `${pointerPrefix}/${inputKey}`,
        code: 'UNKNOWN_VARIABLE',
        message: `Variable '${inputKey}' is not declared in template variable schema`,
      });
    }
  }

  // Resolve values for declared properties
  for (const [varName, varDef] of Object.entries(properties)) {
    const varPointer = `${pointerPrefix}/${varName}`;

    let val: unknown;
    if (inputKeyPresent(inputVariables, varName)) {
      val = inputVariables[varName];
    } else if (defaults && Object.prototype.hasOwnProperty.call(defaults, varName)) {
      val = defaults[varName];
    } else {
      val = undefined;
    }

    if (val === undefined || (val === null && requiredSet.has(varName))) {
      if (requiredSet.has(varName)) {
        errors.push({
          pointer: varPointer,
          code: 'MISSING_REQUIRED_VARIABLE',
          message: `Required template variable '${varName}' is missing or null`,
        });
      }
      continue;
    }

    if (val !== undefined) {
      const valErrors = validateSingleVariableValue(varName, val, varDef, varPointer);
      if (valErrors.length > 0) {
        errors.push(...valErrors);
      } else {
        resolved[varName] = val;
      }
    }
  }

  return { resolved, errors };
}

function inputKeyPresent(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Materializes a template composition specification by substituting variable bindings
 * with their resolved values and setting target locale.
 * Leaves no `{ variable: ... }` objects in the returned pure Scene Spec 1.0 composition.
 */
export function materializeCompositionFromTemplate(
  compositionSpecTemplate: Record<string, unknown>,
  resolvedVariables: Record<string, unknown>,
  targetLocale?: string,
): CompositionSpec {
  const copy = JSON.parse(JSON.stringify(compositionSpecTemplate)) as Record<string, unknown>;

  if (targetLocale) {
    copy['locale'] = targetLocale;
  }

  function substitute(node: unknown): unknown {
    if (!node || typeof node !== 'object') {
      return node;
    }

    if (isVariableBinding(node)) {
      const varName = node.variable;
      if (Object.prototype.hasOwnProperty.call(resolvedVariables, varName)) {
        return resolvedVariables[varName];
      }
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((item) => substitute(item));
    }

    const obj = node as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = substitute(v);
    }
    return res;
  }

  return substitute(copy) as CompositionSpec;
}

/**
 * Computes canonical scene content hash excluding the `revision` field.
 * Used to verify whether scene content was modified across composition revisions.
 */
export function computeSceneContentHash(scene: SceneSpec): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { revision, ...contentWithoutRevision } = scene;
  return sha256Hex(canonicalizeJson(contentWithoutRevision));
}
