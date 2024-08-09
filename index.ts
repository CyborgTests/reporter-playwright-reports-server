import fs from "fs/promises";
import path from "path";
import { request } from "@playwright/test";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";

// reporter: [
//   ['list'],
//   ['reporter-playwright-reports-server', {
//       url: 'http://localhost:3000/'
//       resultDetails: {
//       },
//       triggerReportGeneration: true
//   }]
// ]

type ReporterOptions = {
  url: string;
  token?: string;
  resultDetails?: {
    [key: string]: string;
  };
  triggerReportGeneration?: boolean;
  dryRun?: boolean;
};

const DEFAULT_OPTIONS: Omit<ReporterOptions, "url"> = {
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
    if (options.url === undefined) {
      throw new Error(
        "[ReporterPlaywrightReportsServer] url is required, cannot run without it"
      );
    }
    this.rpOptions = { ...DEFAULT_OPTIONS, ...options };
    console.debug(
      `[ReporterPlaywrightReportsServer] running with ${JSON.stringify(
        options,
        null,
        2
      )}`
    );
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.pwConfig = config;
    const blobReporterConfig = this.pwConfig?.reporter.find(
      (r) => r[0] === "blob"
    );
    if (blobReporterConfig === undefined) {
      throw new Error(
        "[ReporterPlaywrightReportsServer] Blob reporter config not found. Results cannot be uploaded"
      );
    }
    config.shard?.current;
    const { fileName, outputDir } = blobReporterConfig[1] ?? {};
    this.blobName = fileName ?? `report.zip`;
    this.blobPath = path.join(
      process.cwd(),
      outputDir ?? "blob-report",
      this.blobName as string
    );
  }

  async onEnd(result: FullResult) {
    if (this.blobPath === undefined) {
      throw new Error(
        "[ReporterPlaywrightReportsServer] Blob file path is absent. Results cannot be uploaded"
      );
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.blobPath);
    } catch (err) {
      throw new Error(
        "[ReporterPlaywrightReportsServer] Blob file not found or cannot be loaded. Results cannot be uploaded",
        { cause: err }
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

    const resultDetails =
      this.rpOptions.resultDetails === undefined
        ? {}
        : this.rpOptions.resultDetails;
    // TODO: Handle trailing slash in url
    let resultData: any;
    if (this.rpOptions.dryRun === false) {
      const resp = await ctx.put(`${this.rpOptions.url}/api/result/upload`, {
        multipart: {
          file: {
            name: this.blobName ?? "blob.zip",
            mimeType: "application/zip",
            buffer: buffer,
          },
          ...resultDetails,
        },
      });
      resultData = (await resp.json()).data;
    } else {
      resultData = { resultID: "123" };
      console.debug("[ReporterPlaywrightReportsServer] result uploaded: ", resultData);
    }

    if (this.rpOptions.triggerReportGeneration === true) {
      let report;
      if (this.rpOptions.dryRun === false) {
        report = await (
          await ctx.post(`${this.rpOptions.url}/api/report/generate`, {
            data: {
              resultsIds: [resultData.resultID],
            },
          })
        ).json();
      } else {
        report = {
          reportUrl: "/data/report/123/index.html",
        };
      }

      console.log(
        `[ReporterPlaywrightReportsServer] 🎭 HTML Report is available at: ${this.rpOptions.url}${report.reportUrl}`
      );
    }
  }
}

export default ReporterPlaywrightReportsServer;
