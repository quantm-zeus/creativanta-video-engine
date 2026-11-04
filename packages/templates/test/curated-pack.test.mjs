import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition, validateCompositionUnified } from '@creativanta/contracts';

import {
  CURATED_TEMPLATES_CATALOG,
  CURATED_TEMPLATE_FAMILIES,
  RETAIL_PROMO_FAMILY,
  RETAIL_PROMO_TEMPLATE_V1,
  RETAIL_PROMO_TEMPLATE_V2,
  NARRATED_EXPLAINER_FAMILY,
  NARRATED_EXPLAINER_TEMPLATE_V1,
  NARRATED_EXPLAINER_TEMPLATE_V2,
  CAPTIONED_STORY_FAMILY,
  CAPTIONED_STORY_TEMPLATE_V1,
  CAPTIONED_STORY_TEMPLATE_V2,
  getCuratedTemplate,
  getCuratedTemplateFamily,
  listCuratedTemplates,
  verifyTemplateLicenseEvidence,
  assertTemplateLicenseCompliance,
} from '../dist/index.js';

test('Curated Pack: Exactly 3 Template Families Are Registered', () => {
  const families = Object.keys(CURATED_TEMPLATE_FAMILIES);
  assert.equal(families.length, 3);
  assert.deepEqual(families.sort(), ['captioned_story', 'narrated_explainer', 'retail_promo'].sort());

  assert.equal(RETAIL_PROMO_FAMILY.family_id, 'retail_promo');
  assert.equal(NARRATED_EXPLAINER_FAMILY.family_id, 'narrated_explainer');
  assert.equal(CAPTIONED_STORY_FAMILY.family_id, 'captioned_story');
});

test('Curated Pack: Every Family Has At Least 2 Immutable Revisions', () => {
  for (const family of Object.values(CURATED_TEMPLATE_FAMILIES)) {
    assert.ok(family.revisions.length >= 2, `Family ${family.family_id} must have >= 2 revisions`);
    const rev1 = family.revisions.find((r) => r.revision === 1);
    const rev2 = family.revisions.find((r) => r.revision === 2);

    assert.ok(rev1, `Family ${family.family_id} missing revision 1`);
    assert.ok(rev2, `Family ${family.family_id} missing revision 2`);
    assert.equal(family.latest.revision, 2);

    // Verify revisions metadata
    assert.ok(rev1.revisions && rev1.revisions.length >= 2);
    assert.ok(rev1.revisions[1].change_note.length > 0);
    assert.equal(rev1.revisions[1].base_revision, 1);
  }
});

test('Curated Pack: Retail Promo Family Compiles Cleanly on All Revisions', () => {
  for (const tpl of [RETAIL_PROMO_TEMPLATE_V1, RETAIL_PROMO_TEMPLATE_V2]) {
    assert.equal(tpl.family, 'retail_promo');
    assert.equal(tpl.composition_spec.canvas.width, 720);
    assert.equal(tpl.composition_spec.canvas.height, 1280);
    assert.equal(tpl.composition_spec.duration_frames, 450);

    const validation = validateCompositionUnified(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(validation.valid, true, `Validation failed: ${JSON.stringify(validation.all_errors)}`);

    const manifest = compileComposition(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(manifest.duration_frames, 450);
    assert.equal(manifest.scenes.length, 3);
    assert.equal(manifest.audio_tracks.length, 1);
  }
});

test('Curated Pack: Narrated Explainer Family Compiles Cleanly on All Revisions', () => {
  for (const tpl of [NARRATED_EXPLAINER_TEMPLATE_V1, NARRATED_EXPLAINER_TEMPLATE_V2]) {
    assert.equal(tpl.family, 'narrated_explainer');
    assert.equal(tpl.composition_spec.canvas.width, 1280);
    assert.equal(tpl.composition_spec.canvas.height, 720);
    assert.equal(tpl.composition_spec.duration_frames, 900);

    const validation = validateCompositionUnified(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(validation.valid, true, `Validation failed: ${JSON.stringify(validation.all_errors)}`);

    const manifest = compileComposition(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(manifest.duration_frames, 900);
    assert.equal(manifest.scenes.length, 4);
    assert.equal(manifest.audio_tracks.length, 1);
    assert.equal(manifest.subtitles.length, 1);
  }
});

test('Curated Pack: Captioned Story Family Compiles Cleanly on All Revisions', () => {
  for (const tpl of [CAPTIONED_STORY_TEMPLATE_V1, CAPTIONED_STORY_TEMPLATE_V2]) {
    assert.equal(tpl.family, 'captioned_story');
    assert.equal(tpl.composition_spec.canvas.width, 720);
    assert.equal(tpl.composition_spec.canvas.height, 1280);
    assert.equal(tpl.composition_spec.duration_frames, 1350);

    const validation = validateCompositionUnified(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(validation.valid, true, `Validation failed: ${JSON.stringify(validation.all_errors)}`);

    const manifest = compileComposition(tpl.composition_spec, { profile: 'mp4-720p-v1' });
    assert.equal(manifest.duration_frames, 1350);
    assert.equal(manifest.duration_seconds, 45);
    assert.equal(manifest.scenes.length, 3);
    assert.equal(manifest.audio_tracks.length, 2); // voice + music
    assert.equal(manifest.subtitles.length, 1);
  }
});

test('Curated Pack: 100% of Referenced Assets Have Verified Commercial License Evidence', () => {
  for (const template of CURATED_TEMPLATES_CATALOG) {
    const result = verifyTemplateLicenseEvidence(template);
    assert.equal(result.valid, true, `License verification failed for ${template.id} rev ${template.revision}: ${result.errors.join(', ')}`);
    assert.equal(result.missingAssets.length, 0);
    assert.equal(result.errors.length, 0);
    assert.ok(result.evidenceList.length > 0);

    for (const ev of result.evidenceList) {
      assert.ok(ev.asset_id.startsWith('ast_'));
      assert.equal(ev.commercial_use_allowed, true);
      assert.equal(ev.sha256.length, 64);
      assert.ok(ev.attribution.length > 0);
      assert.ok(ev.source.length > 0);
    }

    assert.doesNotThrow(() => assertTemplateLicenseCompliance(template));
  }
});

test('Curated Pack: Catalog Lookup and Filter Queries', () => {
  // 1. By ID and Revision
  const retailV1 = getCuratedTemplate('tpl_retail_promo_v1', 1);
  assert.ok(retailV1);
  assert.equal(retailV1.revision, 1);

  const retailLatest = getCuratedTemplate('tpl_retail_promo_v1');
  assert.ok(retailLatest);
  assert.equal(retailLatest.revision, 2);

  // 2. By Family
  const family = getCuratedTemplateFamily('captioned_story');
  assert.ok(family);
  assert.equal(family.family_id, 'captioned_story');

  // 3. Filter by locale
  const viTemplates = listCuratedTemplates({ locale: 'vi-VN' });
  assert.equal(viTemplates.length, 6); // All 6 revisions support vi-VN

  const latestOnly = listCuratedTemplates({ latestOnly: true });
  assert.equal(latestOnly.length, 3); // 3 families latest revisions
});
