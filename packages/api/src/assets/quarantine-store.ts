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

export const DEFAULT_MAX_ATTEMPT_TEMP_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB per docs/SECURITY.md:55

export interface TempArtifactVerificationDescriptor {
  kind: 'video' | 'manifest' | 'thumbnail' | 'captions' | 'quality_report';
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface TempArtifactVerificationResult {
  valid: boolean;
  errorCode?: 'ENCODE_VERIFICATION_FAILED' | 'SANDBOX_SECURITY_VIOLATION' | 'SANDBOX_RESOURCE_LIMIT';
  errors: string[];
  tempFilePath?: string;
  bytes?: number;
  sha256?: string;
  buffer?: Buffer;
}

export class QuarantineStorageError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'STORAGE_ERROR') {
    super(message);
    this.name = 'QuarantineStorageError';
    this.code = code;
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function verifyContainerMagicAndStructure(
  buffer: Buffer,
  mimeType: string,
  kind: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (mimeType === 'video/mp4' || (kind === 'video' && mimeType !== 'image/png')) {
    if (buffer.length < 32) {
      return { valid: false, errors: [`MP4 container too small (${buffer.length} bytes)`] };
    }
    let offset = 0;
    let ftypOffset = -1;
    let moovOffset = -1;
    let mdatOffset = -1;
    while (offset + 8 <= buffer.length) {
      const boxSize = buffer.readUInt32BE(offset);
      const boxType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      if (boxSize < 8 || offset + boxSize > buffer.length) {
        errors.push(`Truncated or corrupt ISO-BMFF box '${boxType}' at offset ${offset}`);
        break;
      }
      if (boxType === 'ftyp' && ftypOffset === -1) ftypOffset = offset;
      if (boxType === 'moov' && moovOffset === -1) moovOffset = offset;
      if (boxType === 'mdat' && mdatOffset === -1) mdatOffset = offset;
      offset += boxSize;
    }
    if (offset !== buffer.length) {
      errors.push(`MP4 box sizes (${offset}) do not match file size (${buffer.length})`);
    }
    if (ftypOffset !== 0) {
      errors.push(`MP4 missing ftyp box at offset 0 (got ${ftypOffset})`);
    }
    if (moovOffset === -1) {
      errors.push('MP4 missing moov box');
    }
    if (mdatOffset === -1) {
      errors.push('MP4 missing mdat box');
    }
    if (moovOffset !== -1 && mdatOffset !== -1 && moovOffset >= mdatOffset) {
      errors.push(`MP4 is not faststart: moov (${moovOffset}) must precede mdat (${mdatOffset})`);
    }
    return { valid: errors.length === 0, errors };
  }

  if (mimeType === 'image/png' || kind === 'thumbnail') {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
      return { valid: false, errors: ['Missing or corrupt PNG magic signature'] };
    }
    const firstChunk = buffer.subarray(12, 16).toString('ascii');
    if (firstChunk !== 'IHDR') {
      errors.push(`PNG first chunk must be IHDR, got '${firstChunk}'`);
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
      errors.push(`PNG invalid dimensions ${width}x${height}`);
    }
    const iendType = buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii');
    if (iendType !== 'IEND') {
      errors.push(`PNG missing terminal IEND chunk (got '${iendType}')`);
    }
    return { valid: errors.length === 0, errors };
  }

  if (mimeType === 'application/json' || kind === 'manifest' || kind === 'quality_report') {
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('JSON artifact root must be an object');
      }
    } catch (err) {
      errors.push(`Invalid JSON artifact payload: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { valid: errors.length === 0, errors };
  }

  if (mimeType === 'text/vtt' || kind === 'captions') {
    const text = buffer.toString('utf8');
    if (!text.startsWith('WEBVTT')) {
      errors.push('WebVTT artifact must start with WEBVTT header');
    }
    return { valid: errors.length === 0, errors };
  }

  return { valid: true, errors: [] };
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
   * Stages an attempt-scoped temporary output file (`temp/tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>`)
   * prior to fenced publication (`verifying -> succeeded`).
   * Enforces per-attempt temporary disk quota (default 8 GiB per docs/SECURITY.md:55).
   */
  public stageAttemptTempArtifact(
    tenantId: string,
    jobId: string,
    attemptId: string,
    filename: string,
    data: Buffer,
    options: { maxAttemptTempBytes?: number } = {},
  ): {
    tempKey: string;
    tempFilePath: string;
    bytes: number;
    sha256: string;
  } {
    const cleanTenant = sanitizePathComponent(tenantId);
    const cleanJob = sanitizePathComponent(jobId);
    const cleanAttempt = sanitizePathComponent(attemptId);
    const cleanFilename = sanitizePathComponent(filename);

    const tempDir = path.join(
      this.rootDir,
      'temp',
      'tenant',
      cleanTenant,
      'job',
      cleanJob,
      cleanAttempt,
    );
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const maxAttemptTempBytes = options.maxAttemptTempBytes ?? DEFAULT_MAX_ATTEMPT_TEMP_BYTES;
    let existingBytes = 0;
    try {
      const entries = fs.readdirSync(tempDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === cleanFilename) continue;
        const p = path.join(tempDir, entry.name);
        const st = fs.lstatSync(p);
        if (st.isFile()) {
          existingBytes += st.size;
        }
      }
    } catch {
      // ignore
    }

    if (existingBytes + data.byteLength > maxAttemptTempBytes) {
      throw new QuarantineStorageError(
        `Attempt temporary disk quota exceeded (${existingBytes + data.byteLength} > ${maxAttemptTempBytes} bytes)`,
        'SANDBOX_RESOURCE_LIMIT',
      );
    }

    const tempFilePath = path.join(tempDir, cleanFilename);
    fs.writeFileSync(tempFilePath, data);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const tempKey = `temp/tenant/${cleanTenant}/job/${cleanJob}/${cleanAttempt}/${cleanFilename}`;

    return {
      tempKey,
      tempFilePath,
      bytes: data.byteLength,
      sha256,
    };
  }

  /**
   * Verifies an attempt-scoped temporary artifact before atomic promotion (`docs/SECURITY.md:39,55`):
   *   1. Rejects path traversal, symlinks (`lstatSync`), hardlink escapes (`nlink > 1`),
   *      and non-regular files (`!isFile()`), and verifies `realpath` stays inside `attemptTempDir`.
   *   2. Verifies non-empty byte count matches `descriptor.bytes` and per-attempt temp quota.
   *   3. Verifies actual SHA-256 matches `descriptor.sha256`.
   *   4. Verifies magic bytes & container format (`video/mp4` faststart `ftyp`/`moov`/`mdat`,
   *      `image/png` `IHDR`/`IEND`, `application/json`, `text/vtt`).
   */
  public verifyAttemptTempArtifact(
    tenantId: string,
    jobId: string,
    attemptId: string,
    descriptor: TempArtifactVerificationDescriptor,
    options: { maxAttemptTempBytes?: number } = {},
  ): TempArtifactVerificationResult {
    let cleanTenant: string;
    let cleanJob: string;
    let cleanAttempt: string;
    let cleanFilename: string;
    try {
      cleanTenant = sanitizePathComponent(tenantId);
      cleanJob = sanitizePathComponent(jobId);
      cleanAttempt = sanitizePathComponent(attemptId);
      cleanFilename = sanitizePathComponent(descriptor.filename);
    } catch (err) {
      return {
        valid: false,
        errorCode: 'SANDBOX_SECURITY_VIOLATION',
        errors: [err instanceof Error ? err.message : 'Path traversal detected'],
      };
    }

    const attemptTempDir = path.join(
      this.rootDir,
      'temp',
      'tenant',
      cleanTenant,
      'job',
      cleanJob,
      cleanAttempt,
    );
    const tempFilePath = path.join(attemptTempDir, cleanFilename);

    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(tempFilePath);
    } catch {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: [
          `Staged temporary artifact '${cleanFilename}' not found at ${tempFilePath}`,
        ],
      };
    }

    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        errorCode: 'SANDBOX_SECURITY_VIOLATION',
        errors: [`Symlink detected at temporary artifact '${cleanFilename}'`],
      };
    }

    if (!lstat.isFile()) {
      return {
        valid: false,
        errorCode: 'SANDBOX_SECURITY_VIOLATION',
        errors: [`Non-regular file detected at temporary artifact '${cleanFilename}'`],
      };
    }

    if (lstat.nlink > 1) {
      return {
        valid: false,
        errorCode: 'SANDBOX_SECURITY_VIOLATION',
        errors: [
          `Hardlink escape detected (nlink=${lstat.nlink}) at temporary artifact '${cleanFilename}'`,
        ],
      };
    }

    try {
      const realAttemptDir = fs.realpathSync(attemptTempDir);
      const realFilePath = fs.realpathSync(tempFilePath);
      if (!realFilePath.startsWith(realAttemptDir + path.sep)) {
        return {
          valid: false,
          errorCode: 'SANDBOX_SECURITY_VIOLATION',
          errors: [
            `Resolved realpath '${realFilePath}' escapes attempt temp directory '${realAttemptDir}'`,
          ],
        };
      }
    } catch (err) {
      return {
        valid: false,
        errorCode: 'SANDBOX_SECURITY_VIOLATION',
        errors: [
          `Realpath verification failed for '${cleanFilename}': ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }

    const maxAttemptTempBytes = options.maxAttemptTempBytes ?? DEFAULT_MAX_ATTEMPT_TEMP_BYTES;
    if (lstat.size > maxAttemptTempBytes) {
      return {
        valid: false,
        errorCode: 'SANDBOX_RESOURCE_LIMIT',
        errors: [
          `Temporary artifact '${cleanFilename}' size (${lstat.size}) exceeds maxAttemptTempBytes (${maxAttemptTempBytes})`,
        ],
      };
    }

    if (lstat.size <= 0) {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: [`Temporary artifact '${cleanFilename}' is empty (0 bytes)`],
      };
    }

    if (lstat.size !== descriptor.bytes) {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: [
          `Temporary artifact '${cleanFilename}' byte count mismatch: expected ${descriptor.bytes}, actual ${lstat.size}`,
        ],
      };
    }

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(tempFilePath);
    } catch (err) {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: [
          `Failed reading temporary artifact '${cleanFilename}': ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }

    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualSha256.toLowerCase() !== descriptor.sha256.toLowerCase()) {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: [
          `Temporary artifact '${cleanFilename}' SHA-256 mismatch: expected ${descriptor.sha256}, actual ${actualSha256}`,
        ],
      };
    }

    const containerCheck = verifyContainerMagicAndStructure(
      buffer,
      descriptor.mimeType,
      descriptor.kind,
    );
    if (!containerCheck.valid) {
      return {
        valid: false,
        errorCode: 'ENCODE_VERIFICATION_FAILED',
        errors: containerCheck.errors,
      };
    }

    return {
      valid: true,
      errors: [],
      tempFilePath,
      bytes: buffer.byteLength,
      sha256: actualSha256,
      buffer,
    };
  }

  /**
   * Reads a previously staged attempt-scoped temporary artifact.
   */
  public getAttemptTempArtifact(
    tenantId: string,
    jobId: string,
    attemptId: string,
    filename: string,
  ): {
    buffer: Buffer;
    tempFilePath: string;
    bytes: number;
    sha256: string;
  } | null {
    const cleanTenant = sanitizePathComponent(tenantId);
    const cleanJob = sanitizePathComponent(jobId);
    const cleanAttempt = sanitizePathComponent(attemptId);
    const cleanFilename = sanitizePathComponent(filename);

    const tempFilePath = path.join(
      this.rootDir,
      'temp',
      'tenant',
      cleanTenant,
      'job',
      cleanJob,
      cleanAttempt,
      cleanFilename,
    );

    if (!fs.existsSync(tempFilePath)) {
      return null;
    }

    try {
      const lstat = fs.lstatSync(tempFilePath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        return null;
      }
      const buffer = fs.readFileSync(tempFilePath);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      return {
        buffer,
        tempFilePath,
        bytes: buffer.byteLength,
        sha256,
      };
    } catch {
      return null;
    }
  }

  /**
   * Atomically promotes an attempt-scoped temporary artifact to permanent artifact storage
   * (`tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>`) via `.tmp` write + `fs.renameSync`.
   */
  public promoteAttemptArtifactToPermanent(
    tenantId: string,
    jobId: string,
    attemptId: string,
    filename: string,
    fallbackBuffer?: Buffer,
  ): {
    storageKey: string;
    absolutePath: string;
    bytes: number;
    sha256: string;
  } {
    const cleanTenant = sanitizePathComponent(tenantId);
    const cleanJob = sanitizePathComponent(jobId);
    const cleanAttempt = sanitizePathComponent(attemptId);
    const cleanFilename = sanitizePathComponent(filename);

    const staged = this.getAttemptTempArtifact(tenantId, jobId, attemptId, filename);
    const buffer = staged?.buffer ?? fallbackBuffer;
    if (!buffer) {
      throw new QuarantineStorageError(
        `Staged temporary artifact not found for ${tenantId}/${jobId}/${attemptId}/${filename}`,
        'TEMP_ARTIFACT_NOT_FOUND',
      );
    }

    const permDir = path.join(
      this.rootDir,
      'tenant',
      cleanTenant,
      'job',
      cleanJob,
      cleanAttempt,
    );
    if (!fs.existsSync(permDir)) {
      fs.mkdirSync(permDir, { recursive: true });
    }

    const absolutePath = path.join(permDir, cleanFilename);
    const stagingPermPath = path.join(
      permDir,
      `.${cleanFilename}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    fs.writeFileSync(stagingPermPath, buffer);
    fs.renameSync(stagingPermPath, absolutePath);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const storageKey = `tenant/${cleanTenant}/job/${cleanJob}/${cleanAttempt}/${cleanFilename}`;

    if (staged && fs.existsSync(staged.tempFilePath)) {
      try {
        fs.unlinkSync(staged.tempFilePath);
      } catch {
        // ignore
      }
    }

    return {
      storageKey,
      absolutePath,
      bytes: buffer.byteLength,
      sha256,
    };
  }

  /**
   * Removes a promoted permanent artifact by `storage_key` (used to roll back
   * permanent files if the enclosing database commit fails).
   */
  public removePermanentArtifactByStorageKey(storageKey: string): boolean {
    if (!storageKey || storageKey.includes('..') || storageKey.startsWith('/')) {
      return false;
    }
    try {
      const parts = storageKey.split('/');
      for (const part of parts) {
        sanitizePathComponent(part);
      }
      const filePath = path.join(this.rootDir, ...parts);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        const parentDir = path.dirname(filePath);
        try {
          if (fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
          }
        } catch {
          // ignore
        }
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * Cleans up the attempt-scoped temporary directory (`temp/tenant/<tenantId>/job/<jobId>/<attemptId>`).
   */
  public cleanupAttemptTempDir(tenantId: string, jobId: string, attemptId: string): void {
    try {
      const cleanTenant = sanitizePathComponent(tenantId);
      const cleanJob = sanitizePathComponent(jobId);
      const cleanAttempt = sanitizePathComponent(attemptId);
      const tempDir = path.join(
        this.rootDir,
        'temp',
        'tenant',
        cleanTenant,
        'job',
        cleanJob,
        cleanAttempt,
      );
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      const jobTempDir = path.dirname(tempDir);
      if (fs.existsSync(jobTempDir) && fs.readdirSync(jobTempDir).length === 0) {
        fs.rmdirSync(jobTempDir);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Lists remaining temporary files in a specific `(tenantId, jobId, attemptId)` temp directory.
   */
  public listAttemptTempFiles(tenantId: string, jobId: string, attemptId: string): string[] {
    try {
      const cleanTenant = sanitizePathComponent(tenantId);
      const cleanJob = sanitizePathComponent(jobId);
      const cleanAttempt = sanitizePathComponent(attemptId);
      const tempDir = path.join(
        this.rootDir,
        'temp',
        'tenant',
        cleanTenant,
        'job',
        cleanJob,
        cleanAttempt,
      );
      if (!fs.existsSync(tempDir)) {
        return [];
      }
      return fs.readdirSync(tempDir);
    } catch {
      return [];
    }
  }

  /**
   * Lists all existing attempt temporary directories under `temp/tenant/<tenantId>/job/<jobId>/<attemptId>`.
   */
  public listAllAttemptTempDirs(): Array<{
    tenantId: string;
    jobId: string;
    attemptId: string;
    files: string[];
    totalBytes: number;
  }> {
    const results: Array<{
      tenantId: string;
      jobId: string;
      attemptId: string;
      files: string[];
      totalBytes: number;
    }> = [];
    const tempTenantsBase = path.join(this.rootDir, 'temp', 'tenant');
    if (!fs.existsSync(tempTenantsBase)) {
      return results;
    }

    try {
      for (const tDir of fs.readdirSync(tempTenantsBase, { withFileTypes: true })) {
        if (!tDir.isDirectory()) continue;
        const tenantId = tDir.name;
        const jobsBase = path.join(tempTenantsBase, tenantId, 'job');
        if (!fs.existsSync(jobsBase)) continue;

        for (const jDir of fs.readdirSync(jobsBase, { withFileTypes: true })) {
          if (!jDir.isDirectory()) continue;
          const jobId = jDir.name;
          const jobPath = path.join(jobsBase, jobId);

          for (const aDir of fs.readdirSync(jobPath, { withFileTypes: true })) {
            if (!aDir.isDirectory()) continue;
            const attemptId = aDir.name;
            const attemptPath = path.join(jobPath, attemptId);
            const files: string[] = [];
            let totalBytes = 0;

            for (const entry of fs.readdirSync(attemptPath)) {
              files.push(entry);
              try {
                const st = fs.lstatSync(path.join(attemptPath, entry));
                if (st.isFile()) {
                  totalBytes += st.size;
                }
              } catch {
                // ignore
              }
            }

            results.push({ tenantId, jobId, attemptId, files, totalBytes });
          }
        }
      }
    } catch {
      // ignore
    }

    return results;
  }

  /**
   * Sweeps orphan attempt-scoped temp directories (`temp/tenant/<tenantId>/job/<jobId>/<attemptId>`)
   * older than `maxAgeMs` that do NOT belong to any active live lease (`liveAttemptKeys`).
   *
   * Canonical invariant (`docs/ARCHITECTURE.md:92`, `docs/DEPLOYMENT.md:114`):
   *   - "Orphan sweeper xóa temp >24h không referenced và không live lease."
   *   - "don't delete live lease output."
   */
  public sweepOrphanAttemptTempDirs(options: {
    maxAgeMs: number;
    now?: Date;
    liveAttemptKeys?: ReadonlySet<string>;
  }): {
    dirsRemoved: number;
    filesRemoved: number;
    bytesReclaimed: number;
  } {
    const now = options.now ?? new Date();
    const liveKeys = options.liveAttemptKeys ?? new Set<string>();
    let dirsRemoved = 0;
    let filesRemoved = 0;
    let bytesReclaimed = 0;

    const tempTenantsBase = path.join(this.rootDir, 'temp', 'tenant');
    if (!fs.existsSync(tempTenantsBase)) {
      return { dirsRemoved, filesRemoved, bytesReclaimed };
    }

    try {
      for (const tDir of fs.readdirSync(tempTenantsBase, { withFileTypes: true })) {
        if (!tDir.isDirectory()) continue;
        const tenantId = tDir.name;
        const jobsBase = path.join(tempTenantsBase, tenantId, 'job');
        if (!fs.existsSync(jobsBase)) continue;

        for (const jDir of fs.readdirSync(jobsBase, { withFileTypes: true })) {
          if (!jDir.isDirectory()) continue;
          const jobId = jDir.name;
          const jobPath = path.join(jobsBase, jobId);

          for (const aDir of fs.readdirSync(jobPath, { withFileTypes: true })) {
            if (!aDir.isDirectory()) continue;
            const attemptId = aDir.name;
            const attemptKey = `${tenantId}:${jobId}:${attemptId}`;

            // Strictly preserve any attempt temp dir belonging to an active live lease
            if (liveKeys.has(attemptKey)) {
              continue;
            }

            const attemptPath = path.join(jobPath, attemptId);
            try {
              const dirStat = fs.lstatSync(attemptPath);
              let newestMtimeMs = dirStat.mtimeMs;
              let dirBytes = 0;
              let dirFiles = 0;

              const entries = fs.readdirSync(attemptPath);
              for (const entryName of entries) {
                const entryPath = path.join(attemptPath, entryName);
                try {
                  const st = fs.lstatSync(entryPath);
                  if (st.mtimeMs > newestMtimeMs) {
                    newestMtimeMs = st.mtimeMs;
                  }
                  if (st.isFile()) {
                    dirBytes += st.size;
                  }
                  dirFiles += 1;
                } catch {
                  // ignore
                }
              }

              const ageMs = now.getTime() - newestMtimeMs;
              if (ageMs > options.maxAgeMs) {
                fs.rmSync(attemptPath, { recursive: true, force: true });
                dirsRemoved += 1;
                filesRemoved += dirFiles;
                bytesReclaimed += dirBytes;
              }
            } catch {
              // ignore individual attempt dir error
            }
          }

          try {
            if (fs.existsSync(jobPath) && fs.readdirSync(jobPath).length === 0) {
              fs.rmdirSync(jobPath);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    return { dirsRemoved, filesRemoved, bytesReclaimed };
  }

  /**
   * Reads a published permanent artifact by its `storage_key`.
   */
  public getArtifactFileByStorageKey(
    storageKey: string,
  ): { buffer: Buffer; filePath: string } | null {
    if (!storageKey || storageKey.includes('..') || storageKey.startsWith('/')) {
      return null;
    }
    const parts = storageKey.split('/');
    for (const part of parts) {
      sanitizePathComponent(part);
    }
    const filePath = path.join(this.rootDir, ...parts);
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
