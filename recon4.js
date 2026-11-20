// Step 3: dump calendar subroutes for mapping.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TLCClient } from './src/tlc-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });

const c = new TLCClient();
const targets = {
  'view-events.html': '/calendar/view-events',
  'create.html': '/calendar/create',
  'ical.txt': '/calendar/ical',
  'ical-ranged.ics': '/calendar/ical?start=2026-11-01&end=2026-12-31',
};
try {
  await c.start();
  for (const [name, route] of Object.entries(targets)) {
    const r = await c.fetchText(route);
    fs.writeFileSync(path.join(outDir, name), r.body);
    console.log(`${route}: status=${r.status} url=${r.url} bytes=${r.body.length}`);
  }
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await c.stop();
}
