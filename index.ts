import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { FullConfig, Reporter } from '@playwright/test/reporter';
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
  blobUploadTimeout: 10 * 60000,
  logProgress: false,
};

const getUsername = (): string => {
  let username = process.env.QA_USERNAME || '';
  if (username) return username;
  try {
    const gitUser = execSync('git config user.name', { encoding: 'utf8' }).trim();
    if (gitUser) return gitUser;
  } catch { /* ignore */ }
  return '';
};

function makeBoundary() {
  return '----pwreporter-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`;
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
  let sent = 0, lastPct = -5, lastTick = Date.now();

  for await (const chunk of rs) {
    if (logProgress && totalBytes > 0) {
      sent += (chunk as Buffer).length;
      const now = Date.now();
      const pct = Math.min(100, Math.floor((sent / totalBytes) * 100));
      if ((now - lastTick >= 500) && pct >= lastPct + 2) {
        const line = `Upload: ${pct}% (${(sent/1024/1024).toFixed(1)}/${(totalBytes/1024/1024).toFixed(1)} MB)`;
        if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
        else console.log(line);
        lastPct = pct; lastTick = now;
      }
    }
    yield chunk as Uint8Array;
  }

  if (logProgress && totalBytes > 0) {
    const line = `Upload: 100% (${(totalBytes/1024/1024).toFixed(1)} MB)`;
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
    this.blobPath = path.join(process.cwd(), 'blob.zip');
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
      Object.entries(this.rpOptions.resultDetails).map(([k, v]) => [k, v ?? ''])
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

    const boundary = makeBoundary();
    const body = multipartStream({
      boundary,
      fields: details,
      filePath,
      fileName,
      fileType: 'application/zip',
      totalBytes: zipSize,
      logProgress: !!this.rpOptions.logProgress,
    });

    const baseUrl = this.rpOptions.url.endsWith('/') ? this.rpOptions.url.slice(0, -1) : this.rpOptions.url;
    const uploadUrl = `${baseUrl}/api/result/upload?fileContentLength=${zipSize}`;

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (this.rpOptions.token) headers['Authorization'] = this.rpOptions.token;

    const totalTimeout = this.rpOptions.blobUploadTimeout ?? this.rpOptions.requestTimeout ?? 10 * 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), totalTimeout);
    let resultResponse: {
      resultID: UUID;
      createdAt: string;
      size: string;
      sizeBytes: number;
      generatedReport: { reportId: string; reportUrl: string; metadata: { title: string; project: string } } | null;
      username?: string;
    };

    try {
      const fetchAny: any = fetch;

      const resp = await fetchAny(uploadUrl, {
        method: 'PUT',
        headers,
        body: body as any,
        signal: controller.signal,
        duplex: 'half',
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`[Reporter] Upload failed ${resp.status}: ${text.slice(0, 500)}`);
      }

      const json = await resp.json() as { data: typeof resultResponse };
      resultResponse = json.data;

      console.debug('[ReporterPlaywrightReportsServer] blob result uploaded:1', resultResponse);

      if (resultResponse.generatedReport?.reportUrl) {
        console.log(`[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${baseUrl}${resultResponse.generatedReport.reportUrl}`);
      }

      if (this.rpOptions.triggerReportGeneration && !this.pwConfig.shard) {
        const genResp = await fetch(`${baseUrl}/api/report/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.rpOptions.token ? { Authorization: this.rpOptions.token } : {}) },
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
        const report = await genResp.json() as { reportUrl?: string };
        if (report?.reportUrl) {
          console.log(`[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${baseUrl}${report.reportUrl}`);
        }
      }

    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

export default ReporterPlaywrightReportsServer;
