// Step 1: login (password phase) -> land on /site/sms-verify -> save state + dump page.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TLCClient } from './src/tlc-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });

function readCreds() {
  const f = path.join(process.env.HOME, '.config', 'tlc-mcp', 'credentials.env');
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const creds = readCreds();
const c = new TLCClient();
try {
  const page = await (await c.start()).newPage();
  await page.goto('https://www.traillifeconnect.com/login', { waitUntil: 'domcontentloaded' });
  // tick rememberMe if present (krajee checkbox-x uses hidden input)
  await page.fill('input[name="LoginForm[email]"]', creds.TLC_EMAIL);
  await page.fill('input[name="LoginForm[password]"]', creds.TLC_PASSWORD);
  const rm = await page.$('input[name="LoginForm[rememberMe]"]');
  if (rm) await rm.evaluate((el) => { el.value = '1'; });
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForLoadState('networkidle');
  console.log('landed on:', page.url());
  fs.writeFileSync(path.join(outDir, 'sms-verify.html'), await page.content());
  // what inputs/buttons does the verify page have?
  const inputs = await page.$$eval('input,button,select', (els) =>
    els.map((e) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id, text: (e.textContent || '').trim().slice(0, 40) }))
  );
  console.log(JSON.stringify(inputs, null, 1));
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('PAGE TEXT:\n', text);
  await c.saveState();
  console.log('state saved to', c.stateFile);
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await c.stop();
}
