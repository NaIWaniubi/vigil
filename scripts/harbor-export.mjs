// Harbor export adapter.
//
// SoTALab maintains a fork of the Harbor evaluation framework
// (github.com/SoTALab-ai/long-horizon-interaction-harbor, Apache-2.0) and uses
// commit-pinned task ZIPs with per-member SHA-256 manifests (TB4.0-task-artifacts).
// This adapter exports VIGIL tasks into that convention so they can be imported
// into their harness without bespoke glue.
//
// We follow the CONVENTION (pinned archive + manifest), not their code: the
// TB4.0 repo carries no license, so nothing is copied from it.
//
// All three families are exported:
//   vigil-core — the ablation grid (generated on demand)
//   vigil-swe  — the mini-repos (generated on demand)
//   vigil-rush — every task in the committed, solver-calibrated dataset
//                (obligation 'off'; the other variants are derived at load time)
//
// `--verify <dir>` re-hashes an existing export against its manifests without
// writing anything, which is what CI runs after producing the archive.

import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generate, grid, taskFingerprint } from '../tasks/core/generate.mjs';
import { generateSwe, MODULES } from '../tasks/swe/generate.mjs';
import { loadDataset, taskFromEntry } from '../tasks/rush/load.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Render one task as a Harbor-style task directory:
 *   task.yaml      — metadata, entrypoint, verifier declaration
 *   environment/   — the task definition the agent runtime consumes
 *   verifier/      — the oracle + checks, kept OUT of the agent's view
 *   manifest.json  — per-member sha256
 */
function taskDir(outRoot, task, oracle) {
  const dir = join(outRoot, task.id);
  mkdirSync(join(dir, 'environment'), { recursive: true });
  mkdirSync(join(dir, 'verifier'), { recursive: true });

  const fingerprint = sha(taskFingerprint(task));
  const yaml = [
    `id: ${task.id}`,
    `family: ${task.family}`,
    `version: 0.1.0`,
    `license: Apache-2.0`,
    `max_steps: ${task.maxSteps}`,
    `entrypoint: environment/task.json`,
    `verifier: verifier/oracle.json`,
    `fingerprint: ${fingerprint}`,
    `tags: [long-horizon, accumulating-constraints, background-obligations, deterministic-attribution]`,
  ].join('\n');
  writeFileSync(join(dir, 'task.yaml'), `${yaml}\n`);
  writeFileSync(join(dir, 'environment', 'task.json'), JSON.stringify(task, null, 2));
  writeFileSync(join(dir, 'verifier', 'oracle.json'), JSON.stringify({ oracle, fingerprint }, null, 2));

  const members = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else {
        const buf = readFileSync(p);
        members.push({ path: rel, sha256: sha(buf), bytes: buf.length });
      }
    }
  };
  walk(dir, '');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ members }, null, 2));
  return { id: task.id, family: task.family, dir, members: members.length };
}

export function exportHarbor(outRoot, { quick = false } = {}) {
  mkdirSync(outRoot, { recursive: true });
  const exported = [];

  const coreConfigs = quick
    ? grid({ seeds: [1], depths: [6, 12] })
    : grid({ seeds: [1, 2, 3], depths: [6, 12, 18] });
  for (const cfg of coreConfigs) {
    const { task, oracle } = generate(cfg);
    exported.push(taskDir(outRoot, task, oracle));
  }

  for (let moduleIndex = 0; moduleIndex < MODULES.length; moduleIndex++) {
    for (const obligation of ['off', 'deadline', 'decay']) {
      const { task, oracle } = generateSwe({ moduleIndex, depth: 5, obligation, seed: 1 });
      exported.push(taskDir(outRoot, task, oracle));
    }
  }

  // Rush: the committed dataset is the source of truth. Export every task
  // (obligation 'off'); the decay/deadline variants are derived from the same
  // board at load time and would duplicate the search problem.
  const dataset = loadDataset();
  for (const entry of dataset.tasks) {
    const { task, oracle } = taskFromEntry(entry, { obligation: 'off' });
    exported.push(taskDir(outRoot, task, oracle));
  }

  const index = {
    name: 'vigil',
    version: '0.1.0',
    license: 'Apache-2.0',
    exportedAt: new Date().toISOString(),
    convention: 'commit-pinned task directories with per-member sha256 manifests',
    families: [...new Set(exported.map((e) => e.family))].sort(),
    tasks: exported.map((e) => ({ id: e.id, family: e.family, members: e.members })),
  };
  writeFileSync(join(outRoot, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

/**
 * Re-hash an existing export against its own manifests. Returns
 *   { ok, tasks, members, problems }
 * where `tasks` counts task directories (not index entries). Nothing is written.
 */
export function verifyExport(outRoot) {
  const problems = [];
  let tasks = 0;
  let members = 0;

  if (!existsSync(outRoot)) {
    return { ok: false, tasks: 0, members: 0, problems: [`export directory missing: ${outRoot}`] };
  }
  const indexPath = join(outRoot, 'index.json');
  if (!existsSync(indexPath)) {
    return { ok: false, tasks: 0, members: 0, problems: ['index.json missing'] };
  }
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (err) {
    return { ok: false, tasks: 0, members: 0, problems: [`index.json unreadable: ${err.message}`] };
  }
  if (!Array.isArray(index.tasks)) {
    return { ok: false, tasks: 0, members: 0, problems: ['index.json has no tasks array'] };
  }

  const listed = new Set();
  for (const entry of index.tasks) {
    if (listed.has(entry.id)) problems.push(`index lists ${entry.id} twice`);
    listed.add(entry.id);
  }

  const onDisk = readdirSync(outRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of onDisk) {
    tasks++;
    const dir = join(outRoot, name);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      problems.push(`${name}: manifest.json missing`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      problems.push(`${name}: manifest.json unreadable: ${err.message}`);
      continue;
    }
    if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
      problems.push(`${name}: manifest has no members`);
      continue;
    }
    const seen = new Set();
    for (const member of manifest.members) {
      members++;
      seen.add(member.path);
      if (member.path === 'manifest.json') {
        problems.push(`${name}: manifest lists itself`);
        continue;
      }
      const file = join(dir, ...String(member.path).split('/'));
      if (!existsSync(file)) {
        problems.push(`${name}: missing ${member.path}`);
        continue;
      }
      const buf = readFileSync(file);
      if (sha(buf) !== member.sha256) problems.push(`${name}: hash mismatch: ${member.path}`);
      if (buf.length !== member.bytes) problems.push(`${name}: byte length mismatch: ${member.path}`);
    }
    // Every file on disk except the manifest itself must be listed.
    const walk = (d, prefix = '') => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), rel);
        else if (rel !== 'manifest.json' && !seen.has(rel)) problems.push(`${name}: unlisted file: ${rel}`);
      }
    };
    walk(dir);

    // index and task.yaml must agree with the manifest and each other.
    const entry = index.tasks.find((t) => t.id === name);
    if (!entry) {
      problems.push(`${name}: directory not listed in index.json`);
      continue;
    }
    if (entry.members !== manifest.members.length) {
      problems.push(`${name}: index says ${entry.members} members, manifest has ${manifest.members.length}`);
    }
    const yamlPath = join(dir, 'task.yaml');
    if (!existsSync(yamlPath)) {
      problems.push(`${name}: task.yaml missing`);
      continue;
    }
    const yaml = readFileSync(yamlPath, 'utf8');
    if (!new RegExp(`^id: ${name}$`, 'm').test(yaml)) problems.push(`${name}: task.yaml id mismatch`);
    const yamlFamily = yaml.match(/^family: (.+)$/m)?.[1];
    if (yamlFamily !== entry.family) problems.push(`${name}: family ${yamlFamily} != index ${entry.family}`);
    const yamlFingerprint = yaml.match(/^fingerprint: ([0-9a-f]{64})$/m)?.[1];
    const oraclePath = join(dir, 'verifier', 'oracle.json');
    if (!existsSync(oraclePath)) {
      problems.push(`${name}: verifier/oracle.json missing`);
      continue;
    }
    const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
    if (yamlFingerprint !== oracle.fingerprint) {
      problems.push(`${name}: task.yaml fingerprint != verifier fingerprint`);
    }
  }

  for (const id of listed) {
    if (!onDisk.includes(id)) problems.push(`index lists ${id}, directory missing`);
  }

  return { ok: problems.length === 0, tasks, members, problems };
}

const isMain = process.argv[1] && process.argv[1].endsWith('harbor-export.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist/harbor');
  if (args.includes('--verify')) {
    const result = verifyExport(out);
    for (const p of result.problems) console.error(`FAIL ${p}`);
    if (!result.ok) {
      console.error(`HARBOR: FAIL (${result.problems.length} problems)`);
      process.exit(1);
    }
    console.log(`HARBOR: PASS — ${result.tasks} tasks, ${result.members} members, all hashes match`);
  } else {
    const quick = args.includes('--quick');
    const index = exportHarbor(out, { quick });
    console.log(`exported ${index.tasks.length} tasks to ${out}`);
    for (const family of index.families) {
      const n = index.tasks.filter((t) => t.family === family).length;
      console.log(`  ${family}: ${n}`);
    }
  }
}