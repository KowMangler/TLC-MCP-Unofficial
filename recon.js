// Authenticated recon: login, dump /calendar + nav links to out/ for mapping.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TLCClient, BASE_URL } from './src/tlc-client.js';

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
  let authed = await c.isAuthed();
  if (!authed) {
    const r = await c.login(creds.TLC_EMAIL, creds.TLC_PASSWORD);
    console.log('login:', JSON.stringify(r));
    authed = true;
  } else {
    console.log('saved session still valid');
  }

  const save = (name, r) => {
    fs.writeFileSync(path.join(outDir, name), r.body);
    console.log(`${name}: status=${r.status} url=${r.url} bytes=${r.body.length}`);
  };

  const cal = await c.fetchText('/calendar');
  save('calendar.html', cal);

  // Extract the page's own nav/sidebar links to discover staff routes.
  const hrefs = [...cal.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(hrefs.filter((h) => h.startsWith('/') || h.startsWith(BASE_URL)))];
  fs.writeFileSync(path.join(outDir, 'calendar-links.txt'), uniq.join('\n'));
  console.log('links found:', uniq.length);
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await c.stop();
}
