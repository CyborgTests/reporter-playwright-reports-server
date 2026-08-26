import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { FullConfig, Reporter } from '@playwright/test/reporter';
import { randomUUID } from 'node:crypto';
import type { UUID } from 'node:crypto';

// reporter: [
//   ['reporter-playwright-reports-server', {
//       url: 'http://localhost:3000/'
//       resultDetails: {
//           browser: 'chromium',
//           foo: 'bar',
//       },
//       triggerReportGeneration: true
//   }]
// ]

export type PublicReporterOptions = {
  enabled?: boolean;
  url: string;
  reportPath: string;
  token?: string;
  requestTimeout?: number;
  resultDetails?: Record<string, string>;
  triggerReportGeneration?: boolean;
  blobUploadTimeout?: number;
  logProgress?: boolean;
};

/**
 * Used for proper internal typings after merging with default options
 */
type ReporterOptions = {
  enabled: boolean;
  url: string;
  reportPath: string;
  token?: string;
  requestTimeout?: number;
  resultDetails: Record<string, string>;
  triggerReportGeneration: boolean;
  blobUploadTimeout?: number;
  logProgress?: boolean;
};

const DEFAULT_OPTIONS: Omit<ReporterOptions, 'url' | 'reportPath'> = {
  enabled: true,
  resultDetails: {},
  triggerReportGeneration: true,
  requestTimeout: 60000,
  blobUploadTimeout: 10 * 60000, // 30 minutes default for large files
  logProgress: false,
};

const getUsername = (): string => {
  let username = process.env.QA_USERNAME || '';
  if (username) return username;
  try {
    const gitUser = execSync('git config user.name', { encoding: 'utf8' }).trim();
    if (gitUser) return gitUser;
  } catch {
    /* ignore */
  }
  return '';
};

function makeBoundary() {
  return '----pwreporter-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  const head = `--${boundary}\r\n` + `Content-Disposition: form-data; name="${name}"\r\n\r\n` + `${value}\r\n`;
  return Buffer.from(head, 'utf8');
}

function fileHead(boundary: string, fieldName: string, filename: string, contentType: string): Buffer {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  return Buffer.from(head, 'utf8');
}

function closingBoundary(boundary: string): Buffer {
  return Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
}

async function* multipartStream(opts: {
  boundary: string;
  fields: Record<string, string>;
  filePath: string;
  fileName: string;
  fileType: string;
  totalBytes: number;
  logProgress: boolean;
}): AsyncIterable<Uint8Array> {
  const { boundary, fields, filePath, fileName, fileType, totalBytes, logProgress } = opts;

  for (const [k, v] of Object.entries(fields)) {
    yield fieldPart(boundary, k, v) as Uint8Array;
  }

  yield fileHead(boundary, 'file', fileName, fileType) as Uint8Array;

  const rs = fs.createReadStream(filePath, { highWaterMark: 512 * 1024 }); // 512KB
  let sent = 0,
    lastPct = -5,
    lastTick = Date.now();

  console.log('[ReporterPlaywrightReportsServer] Starting to stream file data...');

  for await (const chunk of rs) {
    if (logProgress && totalBytes > 0) {
      sent += (chunk as Buffer).length;
      const now = Date.now();
      const pct = Math.min(100, Math.floor((sent / totalBytes) * 100));
      if (now - lastTick >= 500 && pct >= lastPct + 2) {
        const line = `Upload: ${pct}% (${(sent / 1024 / 1024).toFixed(1)}/${(totalBytes / 1024 / 1024).toFixed(1)} MB)`;
        if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
        else console.log(line);
        lastPct = pct;
        lastTick = now;
      }
    }
    yield chunk as Uint8Array;
  }

  console.log(`[ReporterPlaywrightReportsServer] Finished streaming file data (${(sent / 1024 / 1024).toFixed(2)} MB)`);

  if (logProgress && totalBytes > 0) {
    const line = `Upload: 100% (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`;
    if (process.stdout.isTTY) process.stdout.write(`\r${line}\n`);
    else console.log(line);
  }

  yield closingBoundary(boundary) as Uint8Array;
}

class ReporterPlaywrightReportsServer implements Reporter {
  rpOptions: ReporterOptions;
  pwConfig!: FullConfig;
  blobPath!: string;
  blobName!: string;

  constructor(options: PublicReporterOptions) {
    this.rpOptions = { ...DEFAULT_OPTIONS, ...options };
    if (this.rpOptions.enabled === false) {
      return;
    }
    if (!this.rpOptions.reportPath) {
      throw new Error('[ReporterPlaywrightReportsServer] reportPath is required, cannot run without it');
    }
    if (!this.rpOptions.url) {
      throw new Error('[ReporterPlaywrightReportsServer] url is required, cannot run without it');
    }
    this.blobPath = path.join(process.cwd(), this.rpOptions.reportPath);
    this.blobName = path.basename(this.blobPath);
  }

  onBegin(config: FullConfig /*suite: Suite*/) {
    if (this.rpOptions.enabled === false) {
      return;
    }
    this.pwConfig = config;
  }

  async onEnd(/*result: FullResult*/) {
    if (this.rpOptions.enabled === false) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.blobPath);
    } catch (err) {
      console.error(err);
      throw new Error(
        '[ReporterPlaywrightReportsServer] Blob file not found or cannot be loaded. Results cannot be uploaded',
      );
    }
    const filePath = this.blobPath;
    const fileName = this.blobName || 'blob.zip';
    const zipSize = stat.size;

    const details: Record<string, string> = Object.fromEntries(
      Object.entries(this.rpOptions.resultDetails).map(([k, v]) => [k, v ?? '']),
    );
    if (!details.username) {
      const u = getUsername();
      if (u) details.username = u;
    }
    const version = this.pwConfig.version ?? '';
    const shard = this.pwConfig.shard;
    if (shard) {
      details.shardCurrent = String(shard.current);
      details.shardTotal = String(shard.total);
    }
    details.playwrightVersion = version;
    details.triggerReportGeneration = String(this.rpOptions.triggerReportGeneration ?? false);

    const baseUrl = this.rpOptions.url.endsWith('/') ? this.rpOptions.url.slice(0, -1) : this.rpOptions.url;
    const chunkSize = 50 * 1024 * 1024; // 50 MB chunks
    const totalChunks = Math.ceil(zipSize / chunkSize);
    const uploadId = randomUUID();

    const uploadStartTime = Date.now();
    console.log('[ReporterPlaywrightReportsServer] Starting chunked upload:');
    console.log(`  File: ${fileName} (${(zipSize / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  Chunks: ${totalChunks} (${(chunkSize / 1024 / 1024).toFixed(1)} MB each)`);
    console.log(`  Upload ID: ${uploadId}`);

    const headers: Record<string, string> = {};
    if (this.rpOptions.token) headers['Authorization'] = this.rpOptions.token;

    const totalTimeout = this.rpOptions.blobUploadTimeout ?? this.rpOptions.requestTimeout ?? 30 * 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error('[ReporterPlaywrightReportsServer] Upload timeout reached!');
      controller.abort();
    }, totalTimeout);

    let resultResponse: {
      resultID: UUID;
      createdAt: string;
      size: string;
      sizeBytes: number;
      generatedReport: { reportId: string; reportUrl: string; metadata: { title: string; project: string } } | null;
      username?: string;
    };

    try {
      const fileHandle = await fsp.open(filePath, 'r');
      const activePromises = new Set<Promise<void>>();
      const concurrencyLimit = 5;
      let activeUploads = 0;
      let uploadedBytes = 0;
      const uploadQueue: Array<{ index: number; start: number; end: number }> = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, zipSize);
        uploadQueue.push({ index: i, start, end });
      }

      const uploadChunk = async (chunkInfo: { index: number; start: number; end: number }) => {
        const { index, start, end } = chunkInfo;
        const chunkSizeBytes = end - start;
        const chunkData = Buffer.allocUnsafe(chunkSizeBytes);
        const readResult = await fileHandle.read(chunkData as Uint8Array, 0, chunkSizeBytes, start);

        if (readResult.bytesRead !== chunkSizeBytes) {
          throw new Error(
            `Failed to read chunk ${index}: expected ${chunkSizeBytes} bytes, read ${readResult.bytesRead}`,
          );
        }

        const boundary = makeBoundary();
        const chunkBody = (async function* () {
          yield fileHead(boundary, 'file', fileName, 'application/zip') as Uint8Array;
          yield chunkData as Uint8Array;
          yield closingBoundary(boundary) as Uint8Array;
        })();

        const chunkUrl = `${baseUrl}/api/result/upload-chunk?uploadId=${uploadId}&chunkIndex=${index}&totalChunks=${totalChunks}&totalSize=${zipSize}`;
        const chunkHeaders = {
          ...headers,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        };

        const fetchAny: any = fetch;
        const resp = await fetchAny(chunkUrl, {
          method: 'PUT',
          headers: chunkHeaders,
          body: chunkBody as any,
          signal: controller.signal,
          duplex: 'half',
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`Chunk ${index} upload failed ${resp.status}: ${text.slice(0, 200)}`);
        }

        uploadedBytes += end - start;
        if (this.rpOptions.logProgress) {
          const pct = Math.min(100, Math.floor((uploadedBytes / zipSize) * 100));
          const line = `Upload: ${pct}% (${(uploadedBytes / 1024 / 1024).toFixed(1)}/${(zipSize / 1024 / 1024).toFixed(1)} MB)`;
          if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
          else console.log(line);
        }
      };

      while (uploadQueue.length > 0 || activeUploads > 0) {
        while (activeUploads < concurrencyLimit && uploadQueue.length > 0) {
          const chunkInfo = uploadQueue.shift()!;
          activeUploads++;
          const promise = uploadChunk(chunkInfo)
            .catch((err) => {
              throw err;
            })
            .finally(() => {
              activeUploads--;
              activePromises.delete(promise);
            });
          activePromises.add(promise);
        }
        if (uploadQueue.length > 0 || activeUploads > 0) {
          await Promise.race(Array.from(activePromises));
        }
      }

      // Wait for any remaining active promises
      if (activePromises.size > 0) {
        await Promise.all(Array.from(activePromises));
      }
      await fileHandle.close();

      if (this.rpOptions.logProgress) {
        const line = `Upload: 100% (${(zipSize / 1024 / 1024).toFixed(1)} MB)`;
        if (process.stdout.isTTY) process.stdout.write(`\r${line}\n`);
        else console.log(line);
      }

      const uploadDuration = Date.now() - uploadStartTime;
      console.log(`[ReporterPlaywrightReportsServer] All chunks uploaded in ${(uploadDuration / 1000).toFixed(2)}s`);

      const finalizeUrl = `${baseUrl}/api/result/finalize-upload`;
      const finalizeResp = await fetch(finalizeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          uploadId,
          resultDetails: details,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!finalizeResp.ok) {
        const text = await finalizeResp.text().catch(() => '');
        throw new Error(`Finalize failed ${finalizeResp.status}: ${text.slice(0, 500)}`);
      }

      const json = (await finalizeResp.json()) as { data: typeof resultResponse };
      resultResponse = json.data;

      console.log('[ReporterPlaywrightReportsServer] Upload completed successfully');

      if (resultResponse.generatedReport?.reportUrl) {
        console.log(
          `[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${baseUrl}${resultResponse.generatedReport.reportUrl}`,
        );
      }

      if (this.rpOptions.triggerReportGeneration && !this.pwConfig.shard) {
        const genResp = await fetch(`${baseUrl}/api/report/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.rpOptions.token ? { Authorization: this.rpOptions.token } : {}),
          },
          body: JSON.stringify({
            resultsIds: [resultResponse.resultID],
            ...details,
            playwrightVersion: version,
          }),
          signal: controller.signal,
        });
        if (!genResp.ok) {
          const t = await genResp.text().catch(() => '');
          throw new Error(`[Reporter] Report generation failed ${genResp.status}: ${t.slice(0, 500)}`);
        }
        const report = (await genResp.json()) as { reportUrl?: string };
        if (report?.reportUrl) {
          console.log(
            `[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${baseUrl}${report.reportUrl}`,
          );
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      console.error('[ReporterPlaywrightReportsServer] Upload error:', err);
      throw err;
    }
  }
}

export default ReporterPlaywrightReportsServer;
