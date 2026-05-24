import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIST = path.resolve(__dirname, '../../../dist');
export const EXTENSION_ID = 'cfcioomehhelcingagbbaadnifhppcgc';

const isCI = process.env.CI === 'true';

function headlessMode(): boolean {
  if (process.env.HEADLESS === 'false') return false;
  if (process.env.HEADLESS === 'true') return true;
  if (!isCI) return false;
  return process.platform !== 'linux';
}

export async function launchExtension(): Promise<BrowserContext> {
  if (!fs.existsSync(path.join(APP_DIST, 'manifest.json'))) {
    throw new Error(
      `Extension not built. Run \`npm run build\` first (missing ${APP_DIST}/manifest.json).`
    );
  }
  const headless = headlessMode();
  return chromium.launchPersistentContext('', {
    headless,
    args: [
      '--no-sandbox',
      '--mute-audio',
      `--disable-extensions-except=${APP_DIST}`,
      `--load-extension=${APP_DIST}`,
    ],
    ...(headless && process.platform !== 'linux' ? { channel: 'chromium' } : {}),
  });
}
