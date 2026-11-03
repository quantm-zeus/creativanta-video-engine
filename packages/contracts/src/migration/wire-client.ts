/**
 * Pure TypeScript PostgreSQL Wire Protocol v3.0 Client
 * Zero external dependencies — built using native node:net and node:crypto
 * Canonical specification: docs/DEPLOYMENT.md (line 67) & docs/SECURITY.md
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { redactUrlCredentials } from '../config/env.js';
import { DatabaseClient, QueryResult } from './types.js';

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  connectTimeoutMs?: number;
}

export function parsePostgresUrl(rawUrl: string): PostgresConnectionConfig {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error(`Unsupported database protocol: "${url.protocol}"`);
    }
    return {
      host: url.hostname || '127.0.0.1',
      port: url.port ? parseInt(url.port, 10) : 5432,
      user: decodeURIComponent(url.username || 'postgres'),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: url.pathname ? decodeURIComponent(url.pathname.replace(/^\//, '')) : 'postgres',
    };
  } catch (err: unknown) {
    const safeUrl = redactUrlCredentials(rawUrl);
    throw new Error(
      `Failed to parse database connection URL (${safeUrl}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class PostgresWireClient implements DatabaseClient {
  private socket: net.Socket | null = null;
  private config: PostgresConnectionConfig;
  private connected: boolean = false;
  private ready: boolean = false;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(connectionStringOrConfig: string | PostgresConnectionConfig) {
    if (typeof connectionStringOrConfig === 'string') {
      this.config = parsePostgresUrl(connectionStringOrConfig);
    } else {
      this.config = connectionStringOrConfig;
    }
  }

  public async connect(): Promise<void> {
    if (this.connected && this.ready) return;

    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.connectTimeoutMs || 10000;
      const timeout = setTimeout(() => {
        this.closeInternal();
        reject(new Error(`Database connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const socket = net.createConnection({
        host: this.config.host,
        port: this.config.port,
      });

      this.socket = socket;

      socket.on('error', (err) => {
        clearTimeout(timeout);
        this.closeInternal();
        reject(
          new Error(
            `Database connection error (${this.config.host}:${this.config.port}): ${err.message}`,
          ),
        );
      });

      socket.on('connect', () => {
        this.connected = true;
        this.sendStartupMessage();
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processIncomingPackets(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (err) => {
            clearTimeout(timeout);
            this.closeInternal();
            reject(err);
          },
        );
      });
    });
  }

  private closeInternal(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
  }

  public async close(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      // Send Terminate ('X') packet
      const terminate = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]);
      this.socket.write(terminate);
      this.socket.end();
    }
    this.closeInternal();
  }

  private sendStartupMessage(): void {
    const params: [string, string][] = [
      ['user', this.config.user],
      ['database', this.config.database],
      ['client_encoding', 'UTF8'],
      ['application_name', 'cve-migrator'],
    ];

    const bodyParts: Buffer[] = [];
    for (const [key, val] of params) {
      bodyParts.push(Buffer.from(key, 'utf8'), Buffer.from([0]));
      bodyParts.push(Buffer.from(val, 'utf8'), Buffer.from([0]));
    }
    bodyParts.push(Buffer.from([0])); // Double null terminator

    const body = Buffer.concat(bodyParts);
    const length = 4 + 4 + body.length; // length including itself (4) + proto version (4) + body
    const packet = Buffer.alloc(length);
    packet.writeInt32BE(length, 0);
    packet.writeInt16BE(3, 4); // Major 3
    packet.writeInt16BE(0, 6); // Minor 0
    body.copy(packet, 8);

    this.socket?.write(packet);
  }

  private processIncomingPackets(
    onReady: () => void,
    onError: (err: Error) => void,
  ): void {
    while (this.buffer.length >= 5) {
      const firstByte = this.buffer[0];
      if (firstByte === undefined) break;
      const type = String.fromCharCode(firstByte);
      const length = this.buffer.readInt32BE(1);
      const packetTotalLength = 1 + length;

      if (this.buffer.length < packetTotalLength) {
        break; // Wait for full packet
      }

      const payload = this.buffer.subarray(5, packetTotalLength);
      this.buffer = this.buffer.subarray(packetTotalLength);

      switch (type) {
        case 'R': // Authentication Request
          this.handleAuth(payload, onError);
          break;
        case 'S': // ParameterStatus (ignored during handshake)
        case 'K': // BackendKeyData (ignored)
          break;
        case 'Z': // ReadyForQuery
          this.ready = true;
          onReady();
          break;
        case 'E': { // ErrorResponse
          const errorMsg = this.parseErrorResponse(payload);
          onError(new Error(`Postgres Handshake Error: ${errorMsg}`));
          return;
        }
      }
    }
  }

  private handleAuth(payload: Buffer, onError: (err: Error) => void): void {
    const authType = payload.readInt32BE(0);
    if (authType === 0) {
      // AuthenticationOk
      return;
    }
    if (authType === 3) {
      // CleartextPassword
      const pwd = this.config.password || '';
      const pwdBuf = Buffer.from(pwd + '\0', 'utf8');
      const pkt = Buffer.alloc(1 + 4 + pwdBuf.length);
      pkt[0] = 0x70; // 'p'
      pkt.writeInt32BE(4 + pwdBuf.length, 1);
      pwdBuf.copy(pkt, 5);
      this.socket?.write(pkt);
      return;
    }
    if (authType === 5) {
      // MD5Password: 4 bytes salt follows authType
      const salt = payload.subarray(4, 8);
      const pwd = this.config.password || '';
      const user = this.config.user;

      const inner = crypto
        .createHash('md5')
        .update(pwd + user, 'utf8')
        .digest('hex');
      const outer = crypto
        .createHash('md5')
        .update(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))
        .digest('hex');

      const md5Str = 'md5' + outer + '\0';
      const md5Buf = Buffer.from(md5Str, 'utf8');
      const pkt = Buffer.alloc(1 + 4 + md5Buf.length);
      pkt[0] = 0x70; // 'p'
      pkt.writeInt32BE(4 + md5Buf.length, 1);
      md5Buf.copy(pkt, 5);
      this.socket?.write(pkt);
      return;
    }

    onError(new Error(`Unsupported Postgres authentication type: ${authType}`));
  }

  private parseErrorResponse(payload: Buffer): string {
    const fields: Record<string, string> = {};
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
      const byteAtOffset = payload[offset];
      if (byteAtOffset === undefined) break;
      const fieldType = String.fromCharCode(byteAtOffset);
      offset++;
      const nullIdx = payload.indexOf(0, offset);
      if (nullIdx === -1) break;
      const fieldVal = payload.subarray(offset, nullIdx).toString('utf8');
      fields[fieldType] = fieldVal;
      offset = nullIdx + 1;
    }
    return `${fields['S'] || 'ERROR'}: ${fields['M'] || 'Unknown error'} (Code: ${fields['C'] || 'UNKNOWN'})`;
  }

  public async query<T = Record<string, unknown>>(
    sql: string,
  ): Promise<QueryResult<T>> {
    await this.connect();

    return new Promise((resolve, reject) => {
      const sqlBuf = Buffer.from(sql + '\0', 'utf8');
      const pkt = Buffer.alloc(1 + 4 + sqlBuf.length);
      pkt[0] = 0x51; // 'Q' (Query)
      pkt.writeInt32BE(4 + sqlBuf.length, 1);
      sqlBuf.copy(pkt, 5);

      const rows: T[] = [];
      let columnNames: string[] = [];
      let rowCount = 0;
      let queryError: Error | null = null;

      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 5) {
          const firstByte = this.buffer[0];
          if (firstByte === undefined) break;
          const type = String.fromCharCode(firstByte);
          const length = this.buffer.readInt32BE(1);
          const packetTotalLength = 1 + length;

          if (this.buffer.length < packetTotalLength) {
            break;
          }

          const payload = this.buffer.subarray(5, packetTotalLength);
          this.buffer = this.buffer.subarray(packetTotalLength);

          if (type === 'T') {
            // RowDescription
            columnNames = [];
            const numFields = payload.readInt16BE(0);
            let offset = 2;
            for (let i = 0; i < numFields; i++) {
              const nullIdx = payload.indexOf(0, offset);
              const colName = payload.subarray(offset, nullIdx).toString('utf8');
              columnNames.push(colName);
              offset = nullIdx + 1 + 18; // Skip tableId(4), colAttr(2), typeId(4), typeLen(2), typeMod(4), format(2)
            }
          } else if (type === 'D') {
            // DataRow
            const numCols = payload.readInt16BE(0);
            let offset = 2;
            const row: Record<string, unknown> = {};
            for (let i = 0; i < numCols; i++) {
              const colLen = payload.readInt32BE(offset);
              offset += 4;
              const colName = columnNames[i] || `col_${i}`;
              if (colLen === -1) {
                row[colName] = null;
              } else {
                row[colName] = payload.subarray(offset, offset + colLen).toString('utf8');
                offset += colLen;
              }
            }
            rows.push(row as unknown as T);
            rowCount++;
          } else if (type === 'C') {
            // CommandComplete
            const nullIdx = payload.indexOf(0);
            const tag = payload.subarray(0, nullIdx).toString('utf8');
            const match = /(?:INSERT|DELETE|UPDATE|SELECT|MOVE|FETCH|COPY)\s+(?:\d+\s+)?(\d+)/i.exec(tag);
            if (match && match[1]) {
              rowCount = parseInt(match[1], 10);
            }
          } else if (type === 'E') {
            // ErrorResponse
            const errorMsg = this.parseErrorResponse(payload);
            queryError = new Error(`Postgres Query Error: ${errorMsg}`);
          } else if (type === 'Z') {
            // ReadyForQuery
            this.socket?.off('data', onData);
            if (queryError) {
              reject(queryError);
            } else {
              resolve({ rows, rowCount: rows.length > 0 ? rows.length : rowCount });
            }
            return;
          }
        }
      };

      this.socket?.on('data', onData);
      this.socket?.write(pkt);
    });
  }
}
