/**
 * Safe Brand Tokens Specification, Validator, and Applicator.
 * Canonical specification: docs/SCENE-SPEC.md, docs/SECURITY.md, docs/API.md.
 */

import {
  CompositionSpec,
  ImageLayerContent,
  LayerSpec,
  ShapeLayerContent,
  TextLayerContent,
} from '@creativanta/contracts';

export const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const ASSET_ID_REGEX = /^ast_[a-z0-9_-]{1,64}$/;
export const FONT_ID_REGEX = /^[a-z0-9_-]{1,64}$/;

export interface BrandTokens {
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  headingFontId?: string;
  bodyFontId?: string;
  logoAssetId?: string;
  borderRadius?: number;
}

export interface BrandTokenValidationError {
  field: string;
  code: string;
  message: string;
  value: unknown;
}

export interface BrandTokensValidationResult {
  valid: boolean;
  errors: BrandTokenValidationError[];
  sanitizedTokens?: BrandTokens;
}

export class BrandTokenError extends Error {
  public readonly errors: BrandTokenValidationError[];

  constructor(message: string, errors: BrandTokenValidationError[]) {
    super(message);
    this.name = 'BrandTokenError';
    this.errors = errors;
  }
}

/**
 * Validates brand tokens to guarantee safe parameterization:
 * 1. Strict hex color checking (#RGB, #RRGGBB, #RRGGBBAA).
 * 2. Rejection of arbitrary CSS expressions, url() schemes, HTML tags, or quotes.
 * 3. Enforces that font IDs match allowed pinned fonts in the composition.
 * 4. Enforces valid asset ID format (ast_*).
 * 5. Bounded numeric tokens (e.g. borderRadius within [0, 100]).
 */
export function validateBrandTokens(
  tokens: unknown,
  allowedFontIds?: string[],
): BrandTokensValidationResult {
  const errors: BrandTokenValidationError[] = [];

  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return {
      valid: false,
      errors: [
        {
          field: 'tokens',
          code: 'TYPE_MISMATCH',
          message: 'Brand tokens must be an object',
          value: tokens,
        },
      ],
    };
  }

  const t = tokens as Record<string, unknown>;
  const sanitized: BrandTokens = {};

  const colorFields = [
    'primaryColor',
    'secondaryColor',
    'accentColor',
    'backgroundColor',
    'textColor',
  ] as const;

  for (const field of colorFields) {
    const val = t[field];
    if (val !== undefined && val !== null) {
      if (typeof val !== 'string') {
        errors.push({
          field,
          code: 'INVALID_TYPE',
          message: `Brand token '${field}' must be a string`,
          value: val,
        });
      } else {
        const trimmed = val.trim();
        // Check for potential CSS/HTML injection traps
        if (
          trimmed.includes(';') ||
          trimmed.includes('url(') ||
          trimmed.includes('<') ||
          trimmed.includes('>') ||
          trimmed.includes('expression(') ||
          trimmed.includes('javascript:')
        ) {
          errors.push({
            field,
            code: 'DANGEROUS_TOKEN_VALUE',
            message: `Brand token '${field}' contains forbidden injection characters or expressions`,
            value: trimmed,
          });
        } else if (!HEX_COLOR_REGEX.test(trimmed)) {
          errors.push({
            field,
            code: 'INVALID_HEX_COLOR',
            message: `Brand token '${field}' must be a valid hex color (#RGB, #RRGGBB, #RRGGBBAA)`,
            value: trimmed,
          });
        } else {
          sanitized[field] = trimmed.toUpperCase();
        }
      }
    }
  }

  const fontFields = ['headingFontId', 'bodyFontId'] as const;
  for (const field of fontFields) {
    const val = t[field];
    if (val !== undefined && val !== null) {
      if (typeof val !== 'string') {
        errors.push({
          field,
          code: 'INVALID_TYPE',
          message: `Font token '${field}' must be a string`,
          value: val,
        });
      } else {
        const trimmed = val.trim();
        if (!FONT_ID_REGEX.test(trimmed)) {
          errors.push({
            field,
            code: 'INVALID_FONT_ID_FORMAT',
            message: `Font token '${field}' has invalid identifier format`,
            value: trimmed,
          });
        } else if (allowedFontIds && !allowedFontIds.includes(trimmed)) {
          errors.push({
            field,
            code: 'UNKNOWN_FONT_ID',
            message: `Font token '${field}' references unpinned font '${trimmed}'. Allowed: ${allowedFontIds.join(', ')}`,
            value: trimmed,
          });
        } else {
          sanitized[field] = trimmed;
        }
      }
    }
  }

  if (t.logoAssetId !== undefined && t.logoAssetId !== null) {
    if (typeof t.logoAssetId !== 'string') {
      errors.push({
        field: 'logoAssetId',
        code: 'INVALID_TYPE',
        message: "Brand token 'logoAssetId' must be a string",
        value: t.logoAssetId,
      });
    } else {
      const trimmed = t.logoAssetId.trim();
      if (!ASSET_ID_REGEX.test(trimmed)) {
        errors.push({
          field: 'logoAssetId',
          code: 'INVALID_ASSET_ID',
          message: "Brand token 'logoAssetId' must match pattern ast_*",
          value: trimmed,
        });
      } else {
        sanitized.logoAssetId = trimmed;
      }
    }
  }

  if (t.borderRadius !== undefined && t.borderRadius !== null) {
    if (typeof t.borderRadius !== 'number' || !Number.isFinite(t.borderRadius)) {
      errors.push({
        field: 'borderRadius',
        code: 'INVALID_TYPE',
        message: "Brand token 'borderRadius' must be a finite number",
        value: t.borderRadius,
      });
    } else if (t.borderRadius < 0 || t.borderRadius > 100) {
      errors.push({
        field: 'borderRadius',
        code: 'OUT_OF_BOUNDS',
        message: "Brand token 'borderRadius' must be between 0 and 100",
        value: t.borderRadius,
      });
    } else {
      sanitized.borderRadius = t.borderRadius;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedTokens: errors.length === 0 ? sanitized : undefined,
  };
}

/**
 * Asserts that brand tokens are valid, throwing BrandTokenError on failure.
 */
export function assertValidBrandTokens(
  tokens: unknown,
  allowedFontIds?: string[],
): asserts tokens is BrandTokens {
  const result = validateBrandTokens(tokens, allowedFontIds);
  if (!result.valid) {
    const errorMsgs = result.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new BrandTokenError(`Brand tokens validation failed: ${errorMsgs}`, result.errors);
  }
}

/**
 * Pure transformation applying validated brand tokens to a CompositionSpec.
 * Clones the composition and updates canvas background, layer colors, fills, and logos.
 */
export function applyBrandTokens(
  spec: CompositionSpec,
  tokens: BrandTokens,
): CompositionSpec {
  const cloned: CompositionSpec = JSON.parse(JSON.stringify(spec));

  // 1. Update canvas background if backgroundColor is provided
  if (tokens.backgroundColor) {
    cloned.canvas.background = tokens.backgroundColor;
  }

  // 2. Walk scenes and layers to update styles and brand assets
  for (const scene of cloned.scenes) {
    if (!('layers' in scene) || !Array.isArray(scene.layers)) {
      continue;
    }

    for (const layer of scene.layers) {
      applyBrandTokensToLayer(layer, tokens);
    }
  }

  return cloned;
}

function applyBrandTokensToLayer(layer: LayerSpec, tokens: BrandTokens): void {
  switch (layer.type) {
    case 'text': {
      const content = layer.content as TextLayerContent;
      // Primary accent headlines
      if (layer.id.includes('headline') || layer.id.includes('title')) {
        if (tokens.primaryColor) {
          content.color = tokens.primaryColor;
        }
        if (tokens.headingFontId) {
          content.font_id = tokens.headingFontId;
        }
      } else if (layer.id.includes('price') || layer.id.includes('discount') || layer.id.includes('badge')) {
        if (tokens.accentColor) {
          content.color = tokens.accentColor;
        }
      } else if (layer.id.includes('cta') || layer.id.includes('button')) {
        if (tokens.secondaryColor) {
          content.color = tokens.secondaryColor;
        }
      } else {
        if (tokens.textColor) {
          content.color = tokens.textColor;
        }
        if (tokens.bodyFontId) {
          content.font_id = tokens.bodyFontId;
        }
      }
      break;
    }

    case 'shape': {
      const content = layer.content as ShapeLayerContent;
      if (layer.id.includes('accent') || layer.id.includes('cta') || layer.id.includes('button')) {
        if (tokens.accentColor) {
          content.fill = tokens.accentColor;
        }
      } else if (layer.id.includes('card') || layer.id.includes('bg') || layer.id.includes('panel')) {
        if (tokens.secondaryColor) {
          content.fill = tokens.secondaryColor;
        }
      }
      if (tokens.borderRadius !== undefined && content.shape === 'rect') {
        content.radius = tokens.borderRadius;
      }
      break;
    }

    case 'image': {
      const content = layer.content as ImageLayerContent;
      if ((layer.id.includes('logo') || layer.id.includes('brand')) && tokens.logoAssetId) {
        content.asset_id = tokens.logoAssetId;
      }
      break;
    }
  }
}
