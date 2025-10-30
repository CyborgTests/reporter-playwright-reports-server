import fs from 'fs/promises';
import path from 'path';
import { request } from '@playwright/test';
import type { FullConfig, Reporter /*, FullResult, Suite */ } from '@playwright/test/reporter';
import { type UUID } from 'crypto';
import { execSync } from 'child_process';

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
  resultDetails?: {
    [key: string]: string;
  };
  triggerReportGeneration?: boolean;
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
  resultDetails: {
    [key: string]: string;
  };
  triggerReportGeneration: boolean;
};

// Function to get user information
const getUsername = () => {
  let username = process.env.QA_USERNAME || '';

  if (username) {
    return username;
  }

  try {
    const gitUser = execSync('git config user.name', { encoding: 'utf8' }).trim();
    if (gitUser) {
      return gitUser;
    }
  } catch (error) {
    // Git config not available, continue with system user
  }

  return '';
};

const DEFAULT_OPTIONS: Omit<ReporterOptions, 'url' | 'reportPath'> = {
  enabled: true,
  resultDetails: {},
  triggerReportGeneration: true,
  requestTimeout: 60000,
};

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
    this.blobPath = path.join(process.cwd(), this.rpOptions.reportPath);
    this.blobName = path.basename(this.blobPath);
    if (!this.rpOptions.url) {
      throw new Error('[ReporterPlaywrightReportsServer] url is required, cannot run without it');
    }
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
    let buffer: Buffer;
    try {
      // TODO: Rewrite to use ReadStream
      buffer = await fs.readFile(this.blobPath);
    } catch (err) {
      console.error(err);
      throw new Error(
        '[ReporterPlaywrightReportsServer] Blob file not found or cannot be loaded. Results cannot be uploaded',
      );
    }
    const ctx = await request.newContext({
      timeout: this.rpOptions.requestTimeout,
      extraHTTPHeaders:
        this.rpOptions.token !== undefined
          ? {
              Authorization: this.rpOptions.token,
            }
          : {},
    });

    // Replace undefined values with empty strings
    const clearedResDetails = Object.fromEntries(
      Object.entries(this.rpOptions.resultDetails).map(([key, value]) => [key, value ?? '']),
    );

    // Add username to result details if not already provided
    if (!clearedResDetails.username) {
      const username = getUsername();
      if (username) clearedResDetails.username = username;
    }

    const version = this.pwConfig.version ?? '';

    const url = this.rpOptions.url.endsWith('/') ? this.rpOptions.url.slice(0, -1) : this.rpOptions.url;
    const shard = this.pwConfig.shard;

    const uploadUrl = new URL('/api/result/upload', url);
    // set specific parameter with file content length, to handle s3 presigned url upload
    uploadUrl.searchParams.set('fileContentLength', buffer?.length?.toString() ?? '0');

    // Uploading result to the server
    const resp = await ctx.put(uploadUrl.href, {
      failOnStatusCode: true,
      multipart: {
        file: {
          name: this.blobName ?? 'blob.zip',
          mimeType: 'application/zip',
          buffer: buffer,
        },
        // Passing result details from user, and internal
        ...clearedResDetails,
        ...(shard ? { shardCurrent: shard.current, shardTotal: shard.total } : {}),
        triggerReportGeneration: this.rpOptions.triggerReportGeneration,
        playwrightVersion: version,
      },
    });

    let resultResponse: {
      resultID: UUID;
      createdAt: string;
      size: string;
      sizeBytes: number;
      generatedReport: { reportId: string; reportUrl: string; metadata: { title: string; project: string } } | null;
      username?: string;
    };
    try {
      resultResponse = (await resp.json()).data;
    } catch (error) {
      console.error(
        `[ReporterPlaywrightReportsServer] Failed to parse result response: ${await resp.text()} ${resp.statusText()} ${resp.status()}`,
      );
      throw error;
    }

    console.debug('[ReporterPlaywrightReportsServer] blob result uploaded: ', resultResponse);

    // If we are not in a shard, we should trigger report generation with POST request, otherwise report will be generated by the server
    if (this.rpOptions.triggerReportGeneration) {
      let report: { reportUrl: string };
      if (this.pwConfig.shard) {
        report = {
          reportUrl: `/api/serve/${resultResponse.generatedReport?.reportId}/index.html`,
        };
      } else {
        report = await (
          await ctx.post(`${this.rpOptions.url}/api/report/generate`, {
            failOnStatusCode: true,
            data: {
              resultsIds: [resultResponse.resultID],
              ...clearedResDetails,
              playwrightVersion: version,
            },
          })
        ).json();
      }
      if (report.reportUrl) {
        console.log(
          `[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${this.rpOptions.url}${report.reportUrl}`,
        );
      }
    }
  }
}

export default ReporterPlaywrightReportsServer;
