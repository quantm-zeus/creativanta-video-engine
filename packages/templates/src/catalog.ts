/**
 * Curated Template Pack Catalog Registry.
 * Exposes the 3 curated template families and multi-revision discovery.
 */

import { CAPTIONED_STORY_FAMILY, CAPTIONED_STORY_TEMPLATE_V1, CAPTIONED_STORY_TEMPLATE_V2 } from './captioned-story.js';
import { NARRATED_EXPLAINER_FAMILY, NARRATED_EXPLAINER_TEMPLATE_V1, NARRATED_EXPLAINER_TEMPLATE_V2 } from './narrated-explainer.js';
import { RETAIL_PROMO_FAMILY, RETAIL_PROMO_TEMPLATE_V1, RETAIL_PROMO_TEMPLATE_V2 } from './retail-promo.js';
import { CuratedTemplate, CuratedTemplateFamily, CuratedTemplateFamilyId } from './types.js';

export const CURATED_TEMPLATE_FAMILIES: Record<CuratedTemplateFamilyId, CuratedTemplateFamily> = {
  retail_promo: RETAIL_PROMO_FAMILY,
  narrated_explainer: NARRATED_EXPLAINER_FAMILY,
  captioned_story: CAPTIONED_STORY_FAMILY,
};

export const CURATED_TEMPLATES_CATALOG: CuratedTemplate[] = [
  RETAIL_PROMO_TEMPLATE_V1,
  RETAIL_PROMO_TEMPLATE_V2,
  NARRATED_EXPLAINER_TEMPLATE_V1,
  NARRATED_EXPLAINER_TEMPLATE_V2,
  CAPTIONED_STORY_TEMPLATE_V1,
  CAPTIONED_STORY_TEMPLATE_V2,
];

/**
 * Retrieves a curated template by ID and revision.
 * Defaults to the latest revision if omitted.
 */
export function getCuratedTemplate(
  id: string,
  revision?: number,
): CuratedTemplate | undefined {
  const matches = CURATED_TEMPLATES_CATALOG.filter((t) => t.id === id);
  if (matches.length === 0) {
    return undefined;
  }
  if (revision !== undefined) {
    return matches.find((t) => t.revision === revision);
  }
  // Return the highest revision
  return matches.reduce((prev, curr) => (curr.revision > prev.revision ? curr : prev));
}

/**
 * Retrieves a curated template family by its family ID.
 */
export function getCuratedTemplateFamily(
  familyId: CuratedTemplateFamilyId,
): CuratedTemplateFamily | undefined {
  return CURATED_TEMPLATE_FAMILIES[familyId];
}

/**
 * Lists curated templates matching optional family and locale filter criteria.
 */
export function listCuratedTemplates(options?: {
  family?: CuratedTemplateFamilyId;
  locale?: string;
  latestOnly?: boolean;
}): CuratedTemplate[] {
  let list = CURATED_TEMPLATES_CATALOG;

  if (options?.family) {
    list = list.filter((t) => t.family === options.family);
  }

  if (options?.locale) {
    list = list.filter((t) => t.supported_locales.includes(options.locale!));
  }

  if (options?.latestOnly) {
    const latestMap = new Map<string, CuratedTemplate>();
    for (const tpl of list) {
      const existing = latestMap.get(tpl.id);
      if (!existing || tpl.revision > existing.revision) {
        latestMap.set(tpl.id, tpl);
      }
    }
    list = Array.from(latestMap.values());
  }

  return list;
}
