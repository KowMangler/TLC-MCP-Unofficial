// Drive the MCP server over stdio: list tools + call tlc_calendar_report.
import { spawn } from 'child_process';

const p = spawn('node', ['src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
p.stdout.on('data', (d) => (buf += d));
const lines = [];
p.stdin.on('error', () => {});
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
await wait(500);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
await wait(1000);
for (const l of buf.split('\n').filter(Boolean)) {
  const m = JSON.parse(l);
  if (m.id === 2) console.log('TOOLS:', m.result.tools.map((t) => t.name).join(', '));
}
buf = '';
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tlc_calendar_report', arguments: { from: '2026-11-19', to: '2026-12-31' } } });

const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  await wait(2000);
  const hit = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 3);
  if (hit) {
    const txt = hit.result?.content?.[0]?.text || JSON.stringify(hit);
    const parsed = JSON.parse(txt);
    console.log('REPORT count =', parsed.count);
    for (const e of (parsed.events || []).slice(0, 10))
      console.log(`${e.date}  ${e.type.padEnd(28)} ${e.title.slice(0, 55).padEnd(56)} ${e.venue || ''}  [${e.edit_ref}]`);
    break;
  }
}
p.kill();
process.exit(0);
