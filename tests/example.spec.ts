import { test, expect } from '@playwright/test';
import ReporterPlaywrightReportsServer from '..';

test('url should be required', async ({}) => {
  let noError = false;
  try {
    new ReporterPlaywrightReportsServer({} as any);
    noError = true;
  } catch (err) {
    expect((err as Error).message).toContain(
      '[ReporterPlaywrightReportsServer] url is required, cannot run without it',
    );
  }
  expect(noError).toBeFalsy();
});

test('onEnd should throw if no blobPath defined', async ({}) => {
  const reporter = new ReporterPlaywrightReportsServer({
    dryRun: true,
    url: 'test',
    reportPath: 'test',
  } as any);

  let noError = false;
  try {
    await reporter.onEnd({} as any);
    noError = true;
  } catch (err) {
    expect((err as Error).message).toContain(
      '[ReporterPlaywrightReportsServer] Blob file path is absent. Results cannot be uploaded',
    );
  }
  expect(noError).toBeFalsy();
});
