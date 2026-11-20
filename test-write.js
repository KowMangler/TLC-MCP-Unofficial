// Write-path verification: create -> report -> details -> update -> delete -> confirm gone.
import { spawn } from 'child_process';

const p = spawn('node', ['src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
p.stdout.on('data', (d) => (buf += d));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 10;
const pending = {};
p.stdout.on('data', () => {
  for (const l of buf.split('\n').filter(Boolean)) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== undefined && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  }
  buf = '';
});
async function call(name, args) {
  const myid = id++;
  const pr = new Promise((res) => (pending[myid] = res));
  send({ jsonrpc: '2.0', id: myid, method: 'tools/call', params: { name, arguments: args } });
  const m = await pr;
  return JSON.parse(m.result?.content?.[0]?.text ?? '{}');
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
await wait(500);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await wait(300);

console.log('create:', JSON.stringify(await call('tlc_event_create', {
  title: 'MCP TEST EVENT (safe to delete)',
  event_type: 'Other',
  start: '2026-12-30T18:00',
  end: '2026-12-30T19:00',
  venue: 'Test Venue',
  content: 'Created by tlc-mcp-server write-path verification. Delete me.',
})));

const rep = await call('tlc_calendar_report', { from: '2026-12-30', to: '2026-12-30' });
console.log('report after create: count =', rep.count, JSON.stringify(rep.events));

const created = rep.events.find((e) => e.title.includes('MCP TEST EVENT'));
if (!created) { console.log('FAIL: created event not found in report'); p.kill(); process.exit(1); }

console.log('details:', JSON.stringify(await call('tlc_event_details', { ref: created.edit_ref })).slice(0, 700));

console.log('update:', JSON.stringify(await call('tlc_event_update', { ref: created.edit_ref, title: 'MCP TEST EVENT UPDATED', venue: 'Updated Venue' })));

const rep2 = await call('tlc_calendar_report', { from: '2026-12-30', to: '2026-12-30' });
console.log('report after update:', JSON.stringify(rep2.events.map((e) => e.title + ' @ ' + e.venue)));

console.log('delete:', JSON.stringify(await call('tlc_event_delete', { ref: created.edit_ref })));

const rep3 = await call('tlc_calendar_report', { from: '2026-12-30', to: '2026-12-30' });
console.log('report after delete: count =', rep3.count);
p.kill();
process.exit(rep3.count === 0 ? 0 : 1);
