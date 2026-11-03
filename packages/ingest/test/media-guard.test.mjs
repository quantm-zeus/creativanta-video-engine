import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateImageDimensions,
  validateSvgContent,
  MAX_IMAGE_DIMENSION_PX,
} from '../dist/media-guard.js';

describe('Media Ingest Bounds & Security Sanitization', () => {
  it('accepts safe SVG content', () => {
    const safeSvg = `
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="40" fill="green" />
        <path d="M 10 10 H 90 V 90 H 10 Z" fill="none" stroke="black" />
      </svg>
    `;
    const res = validateSvgContent(safeSvg);
    assert.strictEqual(res.valid, true);
  });

  it('rejects SVG with XXE entity injection', () => {
    const maliciousSvg = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <svg><text>&xxe;</text></svg>`;
    const res = validateSvgContent(maliciousSvg);
    assert.strictEqual(res.valid, false);
    assert.match(res.reason || '', /DOCTYPE or ENTITY/);
  });

  it('rejects SVG with embedded <script> tags', () => {
    const maliciousSvg = '<svg><script>alert("pwned")</script></svg>';
    const res = validateSvgContent(maliciousSvg);
    assert.strictEqual(res.valid, false);
    assert.match(res.reason || '', /dangerous tag <script>/);
  });

  it('rejects SVG with inline event handlers', () => {
    const maliciousSvg = '<svg><circle cx="10" cy="10" r="5" onload="alert(1)" /></svg>';
    const res = validateSvgContent(maliciousSvg);
    assert.strictEqual(res.valid, false);
    assert.match(res.reason || '', /inline event handler/);
  });

  it('rejects SVG with external href references', () => {
    const maliciousSvg = '<svg><image href="https://evil.example.com/payload.png" /></svg>';
    const res = validateSvgContent(maliciousSvg);
    assert.strictEqual(res.valid, false);
    assert.match(res.reason || '', /external resource reference/);
  });

  it('rejects SVG with CSS @import', () => {
    const maliciousSvg = '<svg><style>@import "https://evil.example.com/style.css";</style></svg>';
    const res = validateSvgContent(maliciousSvg);
    assert.strictEqual(res.valid, false);
    assert.match(res.reason || '', /CSS external url\(\) or @import/);
  });

  it('validates image dimensions correctly', () => {
    assert.strictEqual(validateImageDimensions(1920, 1080).valid, true);
    assert.strictEqual(validateImageDimensions(720, 1280).valid, true);

    // Over maximum dimension
    const overDimension = validateImageDimensions(MAX_IMAGE_DIMENSION_PX + 1, 100);
    assert.strictEqual(overDimension.valid, false);
    assert.match(overDimension.reason || '', /exceeds maximum allowed limit/);

    // Over 40MP total pixels (e.g. 7000 x 7000 = 49MP)
    const overPixels = validateImageDimensions(7000, 7000);
    assert.strictEqual(overPixels.valid, false);
    assert.match(overPixels.reason || '', /exceeds maximum allowed 40MP/);

    // Invalid numbers
    assert.strictEqual(validateImageDimensions(-10, 100).valid, false);
    assert.strictEqual(validateImageDimensions(0, 100).valid, false);
  });
});
