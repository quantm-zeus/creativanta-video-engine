/**
 * Scene and Composition Revision comparison & concurrency validation.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md
 */

import { CompositionSpec, SceneSpec } from '../types/scene.js';
import {
  computeSpecHash,
  computeSceneHash,
  materializeCompositionDefaults,
} from './canonical-json.js';

export interface SceneRevisionDiff {
  scene_id: string;
  status: 'unchanged' | 'modified' | 'added' | 'removed';
  base_revision?: number;
  new_revision?: number;
  base_hash?: string;
  new_hash?: string;
}

export interface CompositionRevisionComparison {
  valid: boolean;
  base_revision: number;
  new_revision: number;
  is_render_affecting: boolean;
  is_metadata_only: boolean;
  base_spec_hash: string;
  new_spec_hash: string;
  scene_diffs: SceneRevisionDiff[];
  errors: string[];
}

/**
 * Compares two composition specifications across revisions to enforce:
 * 1. Base revision concurrency (new_revision > base_revision)
 * 2. Scene content changes must increment scene revision
 * 3. Accurate categorization of metadata-only vs render-affecting changes
 */
export function compareCompositionRevisions(
  baseSpec: CompositionSpec,
  newSpec: CompositionSpec,
  baseRevision: number,
  newRevision: number
): CompositionRevisionComparison {
  const errors: string[] = [];

  if (newRevision <= baseRevision) {
    errors.push(
      `New revision (${newRevision}) must be strictly greater than base revision (${baseRevision})`
    );
  }

  const baseNorm = materializeCompositionDefaults(baseSpec);
  const newNorm = materializeCompositionDefaults(newSpec);

  const baseSpecHash = computeSpecHash(baseNorm);
  const newSpecHash = computeSpecHash(newNorm);

  const isRenderAffecting = baseSpecHash !== newSpecHash;
  const isMetadataOnly = !isRenderAffecting && (
    JSON.stringify(baseSpec.metadata ?? {}) !== JSON.stringify(newSpec.metadata ?? {})
  );

  const baseScenesMap = new Map<string, { scene: SceneSpec; hash: string }>();
  for (const s of baseNorm.scenes) {
    baseScenesMap.set(s.id, {
      scene: s,
      hash: computeSceneHash(s),
    });
  }

  const newScenesMap = new Map<string, { scene: SceneSpec; hash: string }>();
  for (const s of newNorm.scenes) {
    newScenesMap.set(s.id, {
      scene: s,
      hash: computeSceneHash(s),
    });
  }

  const sceneDiffs: SceneRevisionDiff[] = [];

  // Check new and existing scenes
  for (const [id, newInfo] of newScenesMap.entries()) {
    const baseInfo = baseScenesMap.get(id);
    if (!baseInfo) {
      sceneDiffs.push({
        scene_id: id,
        status: 'added',
        new_revision: newInfo.scene.revision,
        new_hash: newInfo.hash,
      });
    } else if (baseInfo.hash === newInfo.hash) {
      sceneDiffs.push({
        scene_id: id,
        status: 'unchanged',
        base_revision: baseInfo.scene.revision,
        new_revision: newInfo.scene.revision,
        base_hash: baseInfo.hash,
        new_hash: newInfo.hash,
      });
    } else {
      // Scene content was modified!
      // Enforce: new revision must be > base revision
      if (newInfo.scene.revision <= baseInfo.scene.revision) {
        errors.push(
          `Scene '${id}' content changed but revision (${newInfo.scene.revision}) was not incremented over base revision (${baseInfo.scene.revision})`
        );
      }
      sceneDiffs.push({
        scene_id: id,
        status: 'modified',
        base_revision: baseInfo.scene.revision,
        new_revision: newInfo.scene.revision,
        base_hash: baseInfo.hash,
        new_hash: newInfo.hash,
      });
    }
  }

  // Check removed scenes
  for (const [id, baseInfo] of baseScenesMap.entries()) {
    if (!newScenesMap.has(id)) {
      sceneDiffs.push({
        scene_id: id,
        status: 'removed',
        base_revision: baseInfo.scene.revision,
        base_hash: baseInfo.hash,
      });
    }
  }

  return {
    valid: errors.length === 0,
    base_revision: baseRevision,
    new_revision: newRevision,
    is_render_affecting: isRenderAffecting,
    is_metadata_only: isMetadataOnly,
    base_spec_hash: baseSpecHash,
    new_spec_hash: newSpecHash,
    scene_diffs: sceneDiffs,
    errors,
  };
}
