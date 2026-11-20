// Step 2: complete SMS verify with code from argv, tick trust-device, save state,
// then dump /calendar + nav links for mapping.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TLCClient } from './src/tlc-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });

const code = process.argv[2];
if (!code) {
  console.error('usage: node recon3.js <sms-code>');
  process.exit(1);
}

const c = new TLCClient();
try {
  const page = await (await c.start()).newPage();
  await page.goto('https://www.traillifeconnect.com/site/sms-verify', { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    console.error('pre-auth session expired; re-run recon2.js to restart password phase');
    process.exit(2);
  }
  await page.fill('#sms-verify-code', code);
  const trust = await page.$('#w0');
  if (trust) await trust.evaluate((el) => { el.value = '1'; });
  await page.click('button[name="sms_action"]'); // first submit = Verify & Continue
  await page.waitForLoadState('networkidle');
  console.log('after verify, on:', page.url());
  if (page.url().includes('sms-verify') || page.url().includes('login')) {
    const t = await page.evaluate(() => document.body.innerText.slice(0, 800));
    console.error('verify failed. PAGE:\n', t);
    process.exit(3);
  }
  await c.saveState();
  console.log('session saved (trusted device). Now dumping /calendar');

  const r = await c.fetchText('/calendar');
  fs.writeFileSync(path.join(outDir, 'calendar.html'), r.body);
  console.log(`calendar: status=${r.status} url=${r.url} bytes=${r.body.length}`);
  const hrefs = [...r.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(hrefs.filter((h) => h.startsWith('/')))];
  fs.writeFileSync(path.join(outDir, 'calendar-links.txt'), uniq.join('\n'));
  console.log('links:', uniq.length);
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await c.stop();
}
