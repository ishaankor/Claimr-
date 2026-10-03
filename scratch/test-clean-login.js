import { chromium } from 'playwright';
import path from 'path';

async function test() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();
  console.log('Navigating to Epic login...');
  await page.goto('https://www.epicgames.com/id/login', { waitUntil: 'domcontentloaded' });
  console.log('Login page loaded cleanly!');

  // Check if prototype is native
  const isNative = await page.evaluate(() => {
    return WebGLRenderingContext.prototype.getParameter.toString().includes('[native code]');
  });
  console.log('getParameter is native [native code]:', isNative);

  await page.waitForTimeout(5000);
  await context.close();
}

test();
