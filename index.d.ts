import type { FullConfig, Reporter } from '@playwright/test/reporter';
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
declare class ReporterPlaywrightReportsServer implements Reporter {
    rpOptions: ReporterOptions;
    pwConfig: FullConfig;
    blobPath: string;
    blobName: string;
    constructor(options: PublicReporterOptions);
    onBegin(config: FullConfig): void;
    onEnd(): Promise<void>;
}
export default ReporterPlaywrightReportsServer;
