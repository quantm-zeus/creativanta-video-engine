/**
 * Content-Addressable TTS Synthesis Cache.
 * Caches synthesized audio by deterministic parameters (text hash, voice, model, rate, pitch, format).
 * Specification: docs/IMPLEMENTATION_PLAN.md (P5-02).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  TtsCache,
  TtsCacheStats,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from './types.js';

/**
 * Computes deterministic 64-hex cache key for a TTS synthesis request.
 */
export function computeTtsCacheKey(
  providerId: string,
  modelId: string,
  voiceId: string,
  request: TtsSynthesisRequest
): string {
  const normText = (request.text || '').normalize('NFC');
  const textHash = createHash('sha256').update(normText, 'utf8').digest('hex');

  const components = [
    providerId.toLowerCase().trim(),
    modelId.toLowerCase().trim(),
    voiceId.toLowerCase().trim(),
    (request.locale || 'vi-VN').toLowerCase().trim(),
    request.outputFormat || 'wav-48k-pcm16',
    (request.speechRate ?? 1.0).toFixed(2),
    (request.pitch ?? 0.0).toFixed(2),
    (request.volumeDb ?? 0.0).toFixed(2),
    String(request.targetFps ?? 30),
    textHash,
  ];

  return createHash('sha256').update(components.join('::'), 'utf8').digest('hex');
}

export class MemoryTtsCache implements TtsCache {
  private cache = new Map<string, { result: TtsSynthesisResult; expiresAt?: number }>();
  private stats: TtsCacheStats = { hits: 0, misses: 0, entriesCount: 0, totalBytes: 0 };
  private maxEntries: number;
  private maxBytes: number;

  constructor(maxEntries = 500, maxBytes = 100 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  public async get(key: string): Promise<TtsSynthesisResult | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      this.stats.entriesCount = this.cache.size;
      this.stats.totalBytes -= entry.result.byteLength;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    // Return clone with fromCache set to true
    return {
      ...entry.result,
      audioBuffer: Buffer.from(entry.result.audioBuffer),
      fromCache: true,
    };
  }

  public async set(key: string, result: TtsSynthesisResult, ttlMs?: number): Promise<void> {
    // Evict if at capacity
    while (this.cache.size >= this.maxEntries || (this.stats.totalBytes + result.byteLength > this.maxBytes && this.cache.size > 0)) {
      const firstKey = this.cache.keys().next().value;
      if (!firstKey) break;
      const old = this.cache.get(firstKey);
      if (old) {
        this.stats.totalBytes -= old.result.byteLength;
      }
      this.cache.delete(firstKey);
    }

    const expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
    this.cache.set(key, {
      result: {
        ...result,
        audioBuffer: Buffer.from(result.audioBuffer),
      },
      expiresAt,
    });

    this.stats.entriesCount = this.cache.size;
    this.stats.totalBytes += result.byteLength;
  }

  public async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      this.stats.entriesCount = this.cache.size;
      this.stats.totalBytes -= entry.result.byteLength;
      return false;
    }
    return true;
  }

  public async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (entry) {
      this.stats.totalBytes -= entry.result.byteLength;
      this.cache.delete(key);
      this.stats.entriesCount = this.cache.size;
      return true;
    }
    return false;
  }

  public async clear(): Promise<void> {
    this.cache.clear();
    this.stats.entriesCount = 0;
    this.stats.totalBytes = 0;
  }

  public getStats(): TtsCacheStats {
    return { ...this.stats };
  }
}

export class FileTtsCache implements TtsCache {
  private cacheDir: string;
  private memoryFallback: MemoryTtsCache;
  private stats: TtsCacheStats = { hits: 0, misses: 0, entriesCount: 0, totalBytes: 0 };

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.memoryFallback = new MemoryTtsCache(100);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  public async get(key: string): Promise<TtsSynthesisResult | null> {
    const memResult = await this.memoryFallback.get(key);
    if (memResult) {
      this.stats.hits++;
      return memResult;
    }

    try {
      await this.ensureDir();
      const wavPath = join(this.cacheDir, `${key}.wav`);
      const metaPath = join(this.cacheDir, `${key}.meta.json`);

      const [audioBuffer, metaRaw] = await Promise.all([
        fs.readFile(wavPath),
        fs.readFile(metaPath, 'utf8'),
      ]);

      const meta = JSON.parse(metaRaw);
      const result: TtsSynthesisResult = {
        ...meta,
        audioBuffer,
        fromCache: true,
      };

      await this.memoryFallback.set(key, result);
      this.stats.hits++;
      return result;
    } catch {
      this.stats.misses++;
      return null;
    }
  }

  public async set(key: string, result: TtsSynthesisResult): Promise<void> {
    await this.memoryFallback.set(key, result);
    try {
      await this.ensureDir();
      const wavPath = join(this.cacheDir, `${key}.wav`);
      const metaPath = join(this.cacheDir, `${key}.meta.json`);

      const meta = { ...result };
      delete (meta as Record<string, unknown>).audioBuffer;

      await Promise.all([
        fs.writeFile(wavPath, result.audioBuffer),
        fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8'),
      ]);

      this.stats.entriesCount++;
      this.stats.totalBytes += result.byteLength;
    } catch {
      // Disk write failure shouldn't crash in-memory cache
    }
  }

  public async has(key: string): Promise<boolean> {
    const res = await this.get(key);
    return res !== null;
  }

  public async delete(key: string): Promise<boolean> {
    await this.memoryFallback.delete(key);
    try {
      const wavPath = join(this.cacheDir, `${key}.wav`);
      const metaPath = join(this.cacheDir, `${key}.meta.json`);
      await Promise.all([
        fs.unlink(wavPath).catch(() => {}),
        fs.unlink(metaPath).catch(() => {}),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  public async clear(): Promise<void> {
    await this.memoryFallback.clear();
    try {
      const files = await fs.readdir(this.cacheDir);
      await Promise.all(
        files.map((f) => fs.unlink(join(this.cacheDir, f)).catch(() => {}))
      );
      this.stats.entriesCount = 0;
      this.stats.totalBytes = 0;
    } catch {
      // Ignore if dir not found
    }
  }

  public getStats(): TtsCacheStats {
    return { ...this.stats };
  }
}
