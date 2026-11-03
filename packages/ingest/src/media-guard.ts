/**
 * Media ingestion guard & SVG security validator.
 * Canonical specification: docs/SECURITY.md (lines 57-58)
 */

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_IMAGE_DIMENSION_PX = 8192;
export const MAX_IMAGE_PIXELS = 40_000_000; // 40 MP
export const MAX_SVG_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface ImageDimensionValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateImageDimensions(width: number, height: number): ImageDimensionValidationResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { valid: false, reason: 'Dimensions must be positive integers' };
  }
  if (width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX) {
    return {
      valid: false,
      reason: `Dimension exceeds maximum allowed limit of ${MAX_IMAGE_DIMENSION_PX}px (${width}x${height})`,
    };
  }
  const totalPixels = width * height;
  if (totalPixels > MAX_IMAGE_PIXELS) {
    return {
      valid: false,
      reason: `Total pixels (${totalPixels}) exceeds maximum allowed 40MP (${MAX_IMAGE_PIXELS})`,
    };
  }
  return { valid: true };
}

export interface SvgValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates SVG markup against malicious payloads per docs/SECURITY.md:
 * - cấm <!DOCTYPE> / <!ENTITY> XXE
 * - cấm <script>, <foreignObject>, <iframe>, <embed>, <object>
 * - cấm on* event attributes
 * - cấm external href / xlink:href
 * - cấm CSS url() / @import
 */
export function validateSvgContent(svgText: string): SvgValidationResult {
  if (Buffer.byteLength(svgText, 'utf-8') > MAX_SVG_BYTES) {
    return { valid: false, reason: `SVG byte size exceeds ${MAX_SVG_BYTES} bytes` };
  }

  // Check XXE entity injection
  if (/<!DOCTYPE/i.test(svgText) || /<!ENTITY/i.test(svgText)) {
    return { valid: false, reason: 'SVG contains forbidden DOCTYPE or ENTITY declaration (XXE hazard)' };
  }

  // Check dangerous tags
  const dangerousTags = ['script', 'foreignobject', 'iframe', 'embed', 'object'];
  for (const tag of dangerousTags) {
    const regex = new RegExp(`<\\s*${tag}[\\s>/]`, 'i');
    if (regex.test(svgText)) {
      return { valid: false, reason: `SVG contains forbidden dangerous tag <${tag}>` };
    }
  }

  // Check inline event handlers (onload, onclick, onerror, etc.)
  if (/\son[a-z]+\s*=/i.test(svgText)) {
    return { valid: false, reason: 'SVG contains forbidden inline event handler (on* attribute)' };
  }

  // Check external href / xlink:href references (non-fragment)
  if (/(?:href|xlink:href)\s*=\s*["'](?!(?:#|data:image\/[a-z+]+;base64,))(?:https?:|\/\/|\/)/i.test(svgText)) {
    return { valid: false, reason: 'SVG contains forbidden external resource reference in href' };
  }

  // Check CSS url() or @import
  if (/url\s*\(\s*["']?(?!#|data:)[^"')]+/i.test(svgText) || /@import/i.test(svgText)) {
    return { valid: false, reason: 'SVG contains forbidden CSS external url() or @import' };
  }

  return { valid: true };
}
