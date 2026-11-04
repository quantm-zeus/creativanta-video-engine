/**
 * Curated Template Instantiation, Variable Materialization, and Regeneration Engine.
 * Conforms to docs/SCENE-SPEC.md, docs/API.md, and docs/TESTING.md.
 */

import {
  CanonicalCompilerManifest,
  CompositionRevisionComparison,
  CompositionSpec,
  StandardSceneSpec,
  TextLayerContent,
  compareCompositionRevisions,
  compileComposition,
  validateCompositionUnified,
} from '@creativanta/contracts';
import {
  applyBrandTokens,
  assertValidBrandTokens,
  validateCompositionTextOverflow,
} from '@creativanta/sdk';

import {
  CuratedTemplate,
  TemplateInstantiationOptions,
  TemplateRegenerationOptions,
} from './types.js';

export interface InstantiationResult {
  compositionSpec: CompositionSpec;
  manifest: CanonicalCompilerManifest;
}

export interface RegenerationResult {
  compositionSpec: CompositionSpec;
  manifest: CanonicalCompilerManifest;
  revisionComparison: CompositionRevisionComparison;
}

/**
 * Type guard for StandardSceneSpec (with layers).
 */
export function isStandardScene(scene: unknown): scene is StandardSceneSpec {
  return (
    typeof scene === 'object' &&
    scene !== null &&
    'layers' in scene &&
    Array.isArray((scene as StandardSceneSpec).layers)
  );
}

/**
 * Validates variables against template variable schema and merges with defaults.
 */
export function resolveTemplateVariables(
  template: CuratedTemplate,
  userVariables?: Record<string, unknown>,
): Record<string, unknown> {
  const schema = template.variables_schema;
  const defaults = template.defaults;
  const merged: Record<string, unknown> = { ...defaults, ...(userVariables ?? {}) };

  const requiredProps = (schema['required'] as string[]) ?? [];
  for (const req of requiredProps) {
    const val = merged[req];
    if (val === undefined || val === null || (typeof val === 'string' && val.trim().length === 0)) {
      throw new Error(`Missing required template variable: '${req}'`);
    }
  }

  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const val = merged[key];
    if (val !== undefined && val !== null) {
      const expectedType = propSchema['type'] as string | undefined;
      if (expectedType === 'string') {
        if (typeof val !== 'string') {
          throw new Error(`Variable '${key}' must be a string, got ${typeof val}`);
        }
        const maxLen = propSchema['maxLength'] as number | undefined;
        if (maxLen !== undefined && val.length > maxLen) {
          throw new Error(`Variable '${key}' exceeds maximum length of ${maxLen} characters`);
        }
      } else if (expectedType === 'number' || expectedType === 'integer') {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          throw new Error(`Variable '${key}' must be a finite number`);
        }
      }
    }
  }

  return merged;
}

/**
 * Materializes variable values into template layers.
 */
function materializeVariablesIntoSpec(
  spec: CompositionSpec,
  templateFamily: string,
  variables: Record<string, unknown>,
): void {
  // Normalize all string variables to Unicode NFC
  const nfcVars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(variables)) {
    nfcVars[k] = typeof v === 'string' ? v.normalize('NFC') : v;
  }

  if (templateFamily === 'retail_promo') {
    const s0 = spec.scenes[0];
    const s1 = spec.scenes[1];
    const s2 = spec.scenes[2];

    if (isStandardScene(s0) && s0.layers[0]?.content && 'text' in s0.layers[0].content) {
      if (typeof nfcVars['headline'] === 'string') {
        (s0.layers[0].content as TextLayerContent).text = nfcVars['headline'];
      }
    }
    if (isStandardScene(s1) && s1.layers[0]?.content && 'text' in s1.layers[0].content) {
      if (typeof nfcVars['price_text'] === 'string') {
        (s1.layers[0].content as TextLayerContent).text = nfcVars['price_text'];
      }
    }
    if (isStandardScene(s2) && s2.layers[0]?.content && 'text' in s2.layers[0].content) {
      if (typeof nfcVars['cta_text'] === 'string') {
        (s2.layers[0].content as TextLayerContent).text = nfcVars['cta_text'];
      }
    }
    if (spec.audio_tracks[0] && typeof nfcVars['upload_fallback_asset_id'] === 'string') {
      spec.audio_tracks[0].asset_id = nfcVars['upload_fallback_asset_id'];
    }
  } else if (templateFamily === 'narrated_explainer') {
    const s0 = spec.scenes[0];
    const s1 = spec.scenes[1];
    const s3 = spec.scenes[3];

    if (isStandardScene(s0) && s0.layers[0]?.content && 'text' in s0.layers[0].content) {
      if (typeof nfcVars['problem_text'] === 'string') {
        (s0.layers[0].content as TextLayerContent).text = nfcVars['problem_text'];
      }
    }
    if (isStandardScene(s1) && s1.layers[0]?.content && 'text' in s1.layers[0].content) {
      if (typeof nfcVars['solution_title'] === 'string') {
        (s1.layers[0].content as TextLayerContent).text = nfcVars['solution_title'];
      }
    }
    if (isStandardScene(s3) && s3.layers[0]?.content && 'text' in s3.layers[0].content) {
      if (typeof nfcVars['summary_headline'] === 'string') {
        (s3.layers[0].content as TextLayerContent).text = nfcVars['summary_headline'];
      }
    }
    if (spec.audio_tracks[0] && typeof nfcVars['upload_fallback_asset_id'] === 'string') {
      spec.audio_tracks[0].asset_id = nfcVars['upload_fallback_asset_id'];
    }
  } else if (templateFamily === 'captioned_story') {
    const s0 = spec.scenes[0];
    const s1 = spec.scenes[1];
    const s2 = spec.scenes[2];

    if (isStandardScene(s0) && s0.layers[1]?.content && 'text' in s0.layers[1].content) {
      if (typeof nfcVars['title_text'] === 'string') {
        (s0.layers[1].content as TextLayerContent).text = nfcVars['title_text'];
      }
    }
    if (isStandardScene(s0) && s0.layers[2]?.content && 'text' in s0.layers[2].content) {
      if (typeof nfcVars['location_tag'] === 'string') {
        (s0.layers[2].content as TextLayerContent).text = nfcVars['location_tag'];
      }
    }
    if (isStandardScene(s1) && s1.layers[1]?.content && 'text' in s1.layers[1].content) {
      if (typeof nfcVars['story_quote'] === 'string') {
        (s1.layers[1].content as TextLayerContent).text = nfcVars['story_quote'];
      }
    }
    if (isStandardScene(s2) && s2.layers[1]?.content && 'text' in s2.layers[1].content) {
      if (typeof nfcVars['cta_text'] === 'string') {
        (s2.layers[1].content as TextLayerContent).text = nfcVars['cta_text'];
      }
    }
    if (spec.audio_tracks[0] && typeof nfcVars['narration_asset_id'] === 'string') {
      spec.audio_tracks[0].asset_id = nfcVars['narration_asset_id'];
    }
    if (spec.audio_tracks[1] && typeof nfcVars['music_asset_id'] === 'string') {
      spec.audio_tracks[1].asset_id = nfcVars['music_asset_id'];
    }
  }
}

/**
 * Instantiates a curated template with user variable overrides, brand tokens, and locale checks.
 * Guarantees that the resulting composition conforms to Scene Spec 1.0 and passes preflight layout checks.
 */
export function instantiateCuratedTemplate(
  template: CuratedTemplate,
  options?: TemplateInstantiationOptions,
): InstantiationResult {
  const targetLocale = options?.locale ?? template.composition_spec.locale;

  if (!template.supported_locales.includes(targetLocale)) {
    throw new Error(
      `Locale '${targetLocale}' is not supported by template '${template.id}'. Supported: ${template.supported_locales.join(', ')}`,
    );
  }

  // 1. Resolve variables
  const resolvedVariables = resolveTemplateVariables(template, options?.variables);

  // 2. Clone composition spec
  let spec: CompositionSpec = JSON.parse(JSON.stringify(template.composition_spec));
  spec.locale = targetLocale as 'vi-VN' | 'en-US';

  // 3. Materialize variables
  materializeVariablesIntoSpec(spec, template.family, resolvedVariables);

  // 4. Validate and apply safe brand tokens if provided
  const brandTokens = options?.brandTokens ?? template.brand_tokens_defaults;
  if (brandTokens) {
    const allowedFontIds = spec.fonts.map((f) => f.id);
    assertValidBrandTokens(brandTokens, allowedFontIds);
    spec = applyBrandTokens(spec, brandTokens);
  }

  // 5. Preflight Text Overflow Check
  if (options?.checkOverflow !== false) {
    validateCompositionTextOverflow(spec);
  }

  // 6. Unified validation and canonical compilation
  const validationResult = validateCompositionUnified(spec, { profile: 'mp4-720p-v1' });
  if (!validationResult.valid) {
    const msgs = validationResult.all_errors.map((e) => `[${e.pointer}]: ${e.message}`).join('\n');
    throw new Error(`Instantiated composition failed validation:\n${msgs}`);
  }

  const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

  return {
    compositionSpec: spec,
    manifest,
  };
}

/**
 * Regenerates an existing composition spec with user edits (revision 2+ workflow).
 * Preserves scene IDs, increments revisions, re-validates layout, and compiles deterministically.
 */
export function regenerateTemplate(
  template: CuratedTemplate,
  baseSpec: CompositionSpec,
  options: TemplateRegenerationOptions,
): RegenerationResult {
  const cloned: CompositionSpec = JSON.parse(JSON.stringify(baseSpec));

  // Merge edits into variables
  const newVariables = resolveTemplateVariables(template, options.edits);
  materializeVariablesIntoSpec(cloned, template.family, newVariables);

  // Apply brand tokens if updated
  if (options.brandTokens) {
    const allowedFontIds = cloned.fonts.map((f) => f.id);
    assertValidBrandTokens(options.brandTokens, allowedFontIds);
    const updated = applyBrandTokens(cloned, options.brandTokens);
    cloned.canvas = updated.canvas;
    cloned.scenes = updated.scenes;
  }

  // Preflight Text Overflow Check
  if (options.checkOverflow !== false) {
    validateCompositionTextOverflow(cloned);
  }

  // Increment scene revisions for changed scenes
  for (let i = 0; i < cloned.scenes.length; i++) {
    const baseScene = baseSpec.scenes[i];
    const newScene = cloned.scenes[i];
    if (baseScene && newScene) {
      const baseStr = JSON.stringify(baseScene);
      const newStr = JSON.stringify(newScene);
      if (baseStr !== newStr) {
        newScene.revision = baseScene.revision + 1;
      }
    }
  }

  // Unified validation
  const validationResult = validateCompositionUnified(cloned, { profile: 'mp4-720p-v1' });
  if (!validationResult.valid) {
    const msgs = validationResult.all_errors.map((e) => `[${e.pointer}]: ${e.message}`).join('\n');
    throw new Error(`Regenerated composition failed validation:\n${msgs}`);
  }

  const manifest = compileComposition(cloned, { profile: 'mp4-720p-v1' });

  const baseRev = baseSpec.scenes[0]?.revision ?? 1;
  const newRev = cloned.scenes[0]?.revision ?? baseRev + 1;
  const revisionComparison = compareCompositionRevisions(baseSpec, cloned, baseRev, newRev);

  return {
    compositionSpec: cloned,
    manifest,
    revisionComparison,
  };
}
