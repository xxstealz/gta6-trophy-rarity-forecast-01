// validate.mjs — practice validation for main.ts (not part of the entry).
// Runs main.ts on the kit's p00/p01 and checks: output shape, ids, 5
// quantiles 0..100 non-decreasing, size <= 65536 B, determinism (two runs
// byte-identical), runtime < 8 s. Usage: node validate.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = dirname(fileURLToPath(import.meta.url));
const KIT = '/home/hatch/workspace/makefun/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit';
const TMP = '/tmp/rarity-validate';

const runMain = (inDir, outDir) => {
  const t0 = Date.now();
  const r = spawnSync('node', ['main.ts'], {
    cwd: BOT,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: 'utf8',
  });
  return { ms: Date.now() - t0, status: r.status, stderr: r.stderr };
};

let ok = true;
for (const cid of ['p00', 'p01']) {
  const c = JSON.parse(readFileSync(join(KIT, 'input', `${cid}.in`), 'utf8'));
  const inDir = join(TMP, cid, 'in');
  const outDir = join(TMP, cid, 'out');
  const outDir2 = join(TMP, cid, 'out2');
  rmSync(join(TMP, cid), { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  copyFileSync(join(KIT, 'input', `${cid}.in`), join(inDir, `${cid}.in`));

  const r1 = runMain(inDir, outDir);
  const r2 = runMain(inDir, outDir2);
  const outFile = join(outDir, `${cid}.out`);
  const outFile2 = join(outDir2, `${cid}.out`);
  if (!existsSync(outFile)) {
    console.log(`${cid}: FAIL — no output file (status ${r1.status}) stderr: ${r1.stderr}`);
    ok = false;
    continue;
  }
  const b1 = readFileSync(outFile);
  const b2 = readFileSync(outFile2);
  const det = b1.equals(b2);
  const out = JSON.parse(b1.toString('utf8'));
  const rows = out.trophies;
  let shape = true;
  const problems = [];
  if (!Array.isArray(rows) || rows.length !== c.trophies.length) {
    shape = false;
    problems.push(`rows=${rows?.length} want ${c.trophies.length}`);
  } else {
    rows.forEach((row, i) => {
      if (row.id !== c.trophies[i].id) { shape = false; problems.push(`row ${i} id ${row.id} != ${c.trophies[i].id}`); }
      if (!Array.isArray(row.q) || row.q.length !== 5) { shape = false; problems.push(`row ${i} q len ${row.q?.length}`); }
      else {
        for (let j = 0; j < 5; j++) {
          const q = row.q[j];
          if (!Number.isFinite(q) || q < 0 || q > 100) { shape = false; problems.push(`row ${i} q[${j}]=${q}`); }
          if (j > 0 && q < row.q[j - 1]) { shape = false; problems.push(`row ${i} not non-decreasing at ${j}`); }
        }
      }
      if (Object.keys(row).length !== 2) { shape = false; problems.push(`row ${i} extra keys`); }
    });
  }
  const sizeOk = b1.length <= 65536;
  const timeOk = r1.ms < 8000 && r2.ms < 8000;
  const pass = shape && det && sizeOk && timeOk && r1.status === 0;
  if (!pass) ok = false;
  const first = rows[0]?.q ?? [];
  const mid = rows[3]?.q ?? [];
  console.log(
    `${cid}: ${pass ? 'PASS' : 'FAIL'} shape=${shape} det=${det} size=${b1.length}B time=${r1.ms}ms/${r2.ms}ms status=${r1.status}` +
    (problems.length ? ` problems: ${problems.slice(0, 5).join('; ')}` : '') +
    ` | trophy1 q=${JSON.stringify(first)} trophy4 q=${JSON.stringify(mid)}`,
  );
}
console.log(ok ? 'ALL VALIDATION PASSED' : 'VALIDATION FAILED');
process.exit(ok ? 0 : 1);
