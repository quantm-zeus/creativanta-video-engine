/**
 * Isolated Tenant Quarantine & Ready Asset Storage (Task P3-02).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Filesystem, quotas và content", lines 53-56)
 *   - docs/API.md ("Asset intake", lines 87-92)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface QuarantinedAssetData {
  buffer: Buffer;
  bytes: number;
  sha256: string;
  filePath: string;
}

export class QuarantineStorageError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'STORAGE_ERROR') {
    super(message);
    this.name = 'QuarantineStorageError';
    this.code = code;
  }
}

function sanitizePathComponent(name: string): string {
  if (!name || typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new QuarantineStorageError(`Invalid path component detected: '${name}'`, 'PATH_TRAVERSAL_DETECTED');
  }
  return path.basename(name);
}

export class QuarantineStore {
  private readonly rootDir: string;
  private readonly memoryStore = new Map<string, { buffer: Buffer; sha256: string }>();

  constructor(rootDir?: string) {
    if (rootDir) {
      this.rootDir = path.resolve(rootDir);
    } else {
      const defaultRoot = process.env['CVE_STORAGE_DIR'] || path.join(os.tmpdir(), 'creativanta-cve-storage');
      this.rootDir = path.resolve(defaultRoot);
    }
  }

  public getRootDir(): string {
    return this.rootDir;
  }

  private getQuarantineDir(tenantId: string): string {
    const cleanTenant = sanitizePathComponent(tenantId);
    const dir = path.join(this.rootDir, 'quarantine', cleanTenant);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getPermanentDir(tenantId: string, assetId: string, version: number): string {
    const cleanTenant = sanitizePathComponent(tenantId);
    const cleanAsset = sanitizePathComponent(assetId);
    const cleanVersion = sanitizePathComponent(String(version));
    const dir = path.join(this.rootDir, 'tenant', cleanTenant, 'asset', cleanAsset, cleanVersion);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Saves raw bytes received during upload into the quarantine isolation directory.
   */
  public saveQuarantined(
    tenantId: string,
    assetId: string,
    data: Buffer,
  ): QuarantinedAssetData {
    const cleanAsset = sanitizePathComponent(assetId);
    const dir = this.getQuarantineDir(tenantId);
    const filePath = path.join(dir, `${cleanAsset}.part`);

    fs.writeFileSync(filePath, data);

    const sha256 = crypto.createHash('sha256').update(data).digest('hex');

    // Also cache in memory for fast synchronous validation
    const key = `${tenantId}:${assetId}`;
    this.memoryStore.set(key, { buffer: data, sha256 });

    return {
      buffer: data,
      bytes: data.byteLength,
      sha256,
      filePath,
    };
  }

  /**
   * Retrieves quarantined bytes and path for probing.
   */
  public getQuarantined(tenantId: string, assetId: string): QuarantinedAssetData | null {
    const key = `${tenantId}:${assetId}`;
    const mem = this.memoryStore.get(key);

    const cleanAsset = sanitizePathComponent(assetId);
    const dir = this.getQuarantineDir(tenantId);
    const filePath = path.join(dir, `${cleanAsset}.part`);

    if (mem) {
      return {
        buffer: mem.buffer,
        bytes: mem.buffer.byteLength,
        sha256: mem.sha256,
        filePath,
      };
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');

    this.memoryStore.set(key, { buffer: data, sha256 });

    return {
      buffer: data,
      bytes: data.byteLength,
      sha256,
      filePath,
    };
  }

  /**
   * Promotes an asset from quarantine to ready permanent storage.
   */
  public promoteToReady(
    tenantId: string,
    assetId: string,
    version: number,
    filename: string,
  ): { storageKey: string; absolutePath: string } {
    const cleanFilename = sanitizePathComponent(filename);
    const permDir = this.getPermanentDir(tenantId, assetId, version);
    const targetPath = path.join(permDir, cleanFilename);

    const quarantined = this.getQuarantined(tenantId, assetId);
    if (!quarantined) {
      throw new QuarantineStorageError(
        `Quarantined file for asset ${assetId} not found`,
        'QUARANTINE_FILE_NOT_FOUND',
      );
    }

    fs.writeFileSync(targetPath, quarantined.buffer);

    // Remove quarantine .part
    this.removeQuarantined(tenantId, assetId);

    const storageKey = `tenant/${tenantId}/asset/${assetId}/${version}/${cleanFilename}`;
    return {
      storageKey,
      absolutePath: targetPath,
    };
  }

  /**
   * Retrieves permanent asset file data.
   */
  public getPermanentFile(
    tenantId: string,
    assetId: string,
    version: number,
    filename: string,
  ): { buffer: Buffer; filePath: string } | null {
    const cleanTenant = sanitizePathComponent(tenantId);
    const cleanAsset = sanitizePathComponent(assetId);
    const cleanVersion = sanitizePathComponent(String(version));
    const cleanFilename = sanitizePathComponent(filename);
    const filePath = path.join(this.rootDir, 'tenant', cleanTenant, 'asset', cleanAsset, cleanVersion, cleanFilename);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      return { buffer, filePath };
    } catch {
      return null;
    }
  }

  /**
   * Scans and sweeps orphan quarantine .part files older than maxAgeMs.
   */
  public sweepQuarantine(
    maxAgeMs: number,
    now = new Date(),
  ): { removedFiles: number; bytesReclaimed: number } {
    let removedFiles = 0;
    let bytesReclaimed = 0;
    const quarantineBase = path.join(this.rootDir, 'quarantine');

    if (!fs.existsSync(quarantineBase)) {
      return { removedFiles, bytesReclaimed };
    }

    try {
      const tenantDirs = fs.readdirSync(quarantineBase, { withFileTypes: true });
      for (const tDir of tenantDirs) {
        if (!tDir.isDirectory()) continue;
        const tenantId = tDir.name;
        const tenantDirPath = path.join(quarantineBase, tenantId);
        const files = fs.readdirSync(tenantDirPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.part')) continue;
          const filePath = path.join(tenantDirPath, file.name);
          try {
            const stat = fs.statSync(filePath);
            const ageMs = now.getTime() - stat.mtimeMs;
            if (ageMs > maxAgeMs) {
              const size = stat.size;
              fs.unlinkSync(filePath);
              const assetId = file.name.slice(0, -5);
              this.memoryStore.delete(`${tenantId}:${assetId}`);
              removedFiles++;
              bytesReclaimed += size;
            }
          } catch {
            // ignore individual file errors
          }
        }
      }
    } catch {
      // ignore directory errors
    }

    return { removedFiles, bytesReclaimed };
  }

  /**
   * Deletes temporary quarantine data for an asset.
   */
  public removeQuarantined(tenantId: string, assetId: string): void {
    const cleanAsset = sanitizePathComponent(assetId);
    const dir = this.getQuarantineDir(tenantId);
    const filePath = path.join(dir, `${cleanAsset}.part`);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    this.memoryStore.delete(`${tenantId}:${assetId}`);
  }

  /**
   * Deletes all files (quarantine + permanent versions) for an asset.
   */
  public removeAsset(tenantId: string, assetId: string): void {
    this.removeQuarantined(tenantId, assetId);

    try {
      const cleanTenant = sanitizePathComponent(tenantId);
      const cleanAsset = sanitizePathComponent(assetId);
      const assetDir = path.join(this.rootDir, 'tenant', cleanTenant, 'asset', cleanAsset);
      if (fs.existsSync(assetDir)) {
        fs.rmSync(assetDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  /**
   * Cleans up all storage (useful for test resets).
   */
  public clearAll(): void {
    this.memoryStore.clear();
    try {
      if (fs.existsSync(this.rootDir)) {
        fs.rmSync(this.rootDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
