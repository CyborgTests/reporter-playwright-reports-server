import fs from 'fs/promises';
import path from 'path';
import { request } from '@playwright/test';
import type { FullConfig, Reporter /*, FullResult, Suite */ } from '@playwright/test/reporter';

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

type ReporterOptions = {
  enabled?: boolean;
  url: string;
  reportPath: string;
  token?: string;
  resultDetails?: {
    [key: string]: string;
  };
  triggerReportGeneration?: boolean;
  dryRun?: boolean;
};

const DEFAULT_OPTIONS: Omit<ReporterOptions, 'url' | 'reportPath'> = {
  enabled: true,
  resultDetails: {},
  triggerReportGeneration: true,
  dryRun: false,
};

class ReporterPlaywrightReportsServer implements Reporter {
  rpOptions: ReporterOptions;
  pwConfig: FullConfig | undefined;
  blobPath: string | undefined;
  blobName: string | undefined;

  constructor(options: ReporterOptions) {
    this.rpOptions = { ...DEFAULT_OPTIONS, ...options };
    if (this.rpOptions.enabled === false) {
      return;
    }
    if (!this.rpOptions.url) {
      throw new Error('[ReporterPlaywrightReportsServer] url is required, cannot run without it');
    }

    if (!this.rpOptions.reportPath) {
      throw new Error('[ReporterPlaywrightReportsServer] reportPath is required, cannot run without it');
    }
  }

  onBegin(/*config: FullConfig, suite: Suite*/) {
    if (this.rpOptions.enabled === false) {
      return;
    }
    this.blobPath = path.join(process.cwd(), this.rpOptions.reportPath);
    this.blobName = path.basename(this.blobPath);
  }

  async onEnd(/*result: FullResult*/) {
    if (this.rpOptions.enabled === false) {
      return;
    }
    if (this.blobPath === undefined) {
      throw new Error('[ReporterPlaywrightReportsServer] Blob file path is absent. Results cannot be uploaded');
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.blobPath);
    } catch (err) {
      console.error(err);
      throw new Error(
        '[ReporterPlaywrightReportsServer] Blob file not found or cannot be loaded. Results cannot be uploaded',
      );
    }

    const ctx = await request.newContext({
      extraHTTPHeaders:
        this.rpOptions.token !== undefined
          ? {
              Authorization: this.rpOptions.token,
            }
          : {},
    });

    const resultDetails = this.rpOptions.resultDetails === undefined ? {} : this.rpOptions.resultDetails;

    let resultData: any;
    const url = this.rpOptions.url.endsWith('/') ? this.rpOptions.url.slice(0, -1) : this.rpOptions.url;
    if (this.rpOptions.dryRun === false) {
      const resp = await ctx.put(`${url}/api/result/upload`, {
        multipart: {
          file: {
            name: this.blobName ?? 'blob.zip',
            mimeType: 'application/zip',
            buffer: buffer,
          },
          ...resultDetails,
        },
      });
      resultData = (await resp.json()).data;
    } else {
      resultData = { resultID: '123' };
    }
    console.debug('[ReporterPlaywrightReportsServer] blob result uploaded: ', resultData);

    if (this.rpOptions.triggerReportGeneration === true) {
      let report;
      if (this.rpOptions.dryRun === false) {
        report = await (
          await ctx.post(`${this.rpOptions.url}/api/report/generate`, {
            data: {
              resultsIds: [resultData.resultID],
              ...resultDetails,
            },
          })
        ).json();
      } else {
        report = {
          reportUrl: '/data/report/123/index.html',
        };
      }

      console.log(
        `[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${this.rpOptions.url}${report.reportUrl}`,
      );
    }
  }
}

export default ReporterPlaywrightReportsServer;
