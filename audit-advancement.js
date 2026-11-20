// Read-only advancement audit dump: run tlc_advancement_report over stdio,
// save JSON + CSV (patrol/step/boy/status/earned_on/tooltip) for paper-record correction.
import { spawn } from 'child_process';
import fs from 'fs';
const p = spawn(process.execPath, ['src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit', version: '1' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== 3) continue;
    const r = JSON.parse(m.result.content[0].text);
    fs.writeFileSync('out/advancement-audit.json', JSON.stringify(r, null, 2));
    const boyPatrol = {};
    for (const [pat, boys] of Object.entries(r.per_patrol)) for (const b of boys) boyPatrol[b.name] = pat;
    const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
    let csv = 'patrol,step_section,step,boy,status,earned_on,tooltip_note\n';
    for (const st of r.steps) {
      for (const [boy, v] of Object.entries(st.cells)) {
        const done = v.startsWith('Y');
        const dm = v.match(/@(\S+)/);
        const nm = v.match(/"([^"]*)"/);
        csv += [boyPatrol[boy] || '', st.section, st.step, boy, done ? 'EARNED' : 'not', dm ? dm[1] : '', nm ? nm[1] : ''].map(q).join(',') + '\n';
      }
    }
    fs.writeFileSync('out/advancement-audit.csv', csv);
    console.log('steps:', r.steps.length, 'boys:', r.total_boys, '| wrote out/advancement-audit.json + .csv');
    for (const s of r.steps) {
      console.log('\n[' + s.section + '] ' + s.step + '  ' + Object.entries(s.completion).map(([k, v]) => k + ' ' + v).join(' | '));
      console.log('  ' + Object.entries(s.cells).slice(0, 5).map(([b, v]) => b + ': ' + v).join('   '));
    }
    p.kill();
    process.exit(0);
  }
});
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tlc_advancement_report', arguments: { badge: 'Heritage Branch' } } }), 4000);
