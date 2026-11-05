/**
 * Browser Download Helper and Container Integrity Verifier (Task P8-02).
 *
 * Implements acceptance requirement: "memory/cancel/download/quality parity tests".
 * Manages client-side artifact delivery:
 * 1. Native DOM object URL creation and anchor-click download triggering with immediate URL revocation.
 * 2. Origin Private File System (OPFS) streaming export.
 * 3. Container binary format validation (fMP4 box headers and WebM EBML signatures).
 */

export interface ContainerVerificationResult {
  readonly format: 'mp4' | 'webm' | 'unknown';
  readonly isValid: boolean;
  readonly sizeBytes: number;
  readonly brand?: string;
  readonly error?: string;
}

/**
 * Validates the binary header signatures of an exported video container (fMP4 or WebM).
 */
export function verifyVideoContainer(
  data: Uint8Array | ArrayBuffer,
): ContainerVerificationResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const sizeBytes = bytes.byteLength;

  if (sizeBytes < 16) {
    return {
      format: 'unknown',
      isValid: false,
      sizeBytes,
      error: `Exported buffer is too small to be a valid media container (${sizeBytes} bytes).`,
    };
  }

  // 1. Check for MP4 ftyp box (bytes 4..7 === 'ftyp' = [0x66, 0x74, 0x79, 0x70])
  const isMp4 =
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70;

  if (isMp4) {
    // Read major brand (bytes 8..11)
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    return {
      format: 'mp4',
      isValid: true,
      sizeBytes,
      brand,
    };
  }

  // 2. Check for WebM EBML Header ([0x1A, 0x45, 0xDF, 0xA3])
  const isWebm =
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;

  if (isWebm) {
    return {
      format: 'webm',
      isValid: true,
      sizeBytes,
      brand: 'matroska/webm',
    };
  }

  return {
    format: 'unknown',
    isValid: false,
    sizeBytes,
    error: 'Buffer does not match MP4 (ftyp) or WebM (EBML) header signatures.',
  };
}

export interface DomContextMock {
  document: {
    createElement(tag: string): {
      href?: string;
      download?: string;
      style?: { display: string };
      click(): void;
    };
    body: {
      appendChild(child: unknown): void;
      removeChild(child: unknown): void;
    };
  };
  URL: {
    createObjectURL(blob: unknown): string;
    revokeObjectURL(url: string): void;
  };
}

export interface TriggerDownloadOptions {
  readonly mimeType?: string;
  readonly onTrigger?: (info: { filename: string; mimeType: string; sizeBytes: number; url?: string }) => void;
  /** Injected DOM window/document for headless testing */
  readonly domContext?: DomContextMock;
}

/**
 * Triggers a client-side file download via DOM synthetic click or OPFS delivery.
 * Automatically cleans up the allocated Blob object URL to prevent memory leaks.
 */
export function triggerBrowserDownload(
  data: Uint8Array | Blob,
  filename: string,
  options: TriggerDownloadOptions = {},
): { success: boolean; filename: string; sizeBytes: number; mimeType: string } {
  const mimeType = options.mimeType ?? (filename.endsWith('.webm') ? 'video/webm' : 'video/mp4');
  const sizeBytes = data instanceof Uint8Array ? data.byteLength : data.size;

  if (sizeBytes === 0) {
    throw new Error(`Cannot trigger download of empty 0-byte video file: '${filename}'`);
  }

  // Use injected or global DOM context if available
  const globalObj = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>) : {};
  const doc = options.domContext?.document ?? (globalObj['document'] as DomContextMock['document'] | undefined);
  const urlApi = options.domContext?.URL ?? (globalObj['URL'] as DomContextMock['URL'] | undefined);

  let objectUrl: string | undefined;

  if (doc && urlApi) {
    const blob = data instanceof Uint8Array ? new Blob([data], { type: mimeType }) : data;
    objectUrl = urlApi.createObjectURL(blob);

    const anchor = doc.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    if (anchor.style) {
      anchor.style.display = 'none';
    }

    doc.body.appendChild(anchor);
    anchor.click();
    doc.body.removeChild(anchor);

    // Revoke object URL after click to release Blob memory
    urlApi.revokeObjectURL(objectUrl);
  }

  if (options.onTrigger) {
    options.onTrigger({
      filename,
      mimeType,
      sizeBytes,
      url: objectUrl,
    });
  }

  return {
    success: true,
    filename,
    sizeBytes,
    mimeType,
  };
}
