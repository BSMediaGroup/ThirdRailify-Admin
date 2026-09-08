import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const directory = '.artifacts/matchup-studio/live';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
await page.goto('https://admin.thirdrailify.com/polls/abootnothing');
await page.screenshot({ path: `${directory}/operator-login.png` });
console.log('Operator browser opened on the real Admin site. No existing profile or cookies were copied.');
const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
for await (const line of lines) {
  try {
    if (line.trim() === 'status') console.log(JSON.stringify({ url: page.url(), title: await page.title(), headings: await page.locator('h1,h2').allTextContents() }));
    if (line.trim() === 'capture') { await page.screenshot({ path: `${directory}/operator-current.png`, fullPage: true }); console.log('Saved operator-current.png'); }
    if (line.trim() === 'accept') { const { acceptance } = await import(`./matchup-stable-acceptance.mjs?${Date.now()}`); await acceptance({ browser, context, page, directory }); }
    if (line.trim() === 'close') break;
  } catch (e) { console.log(`Operator step failed: ${e.message}`); }
}
await browser.close();
