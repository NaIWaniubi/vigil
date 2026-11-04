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

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generate, grid, taskFingerprint } from '../tasks/core/generate.mjs';
import { generateSwe, MODULES } from '../tasks/swe/generate.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Render one task as a Harbor-style task directory:
 *   task.yaml      — metadata, entrypoint, verifier declaration
 *   environment/   — the task definition the agent runtime consumes
 *   verifier/      — the oracle + checks, kept OUT of the agent's view
 *   manifest.json  — per-member sha256
 */
function taskDir(outRoot, task, oracle, family) {
  const dir = join(outRoot, task.id);
  mkdirSync(join(dir, 'environment'), { recursive: true });
  mkdirSync(join(dir, 'verifier'), { recursive: true });

  const yaml = [
    `id: ${task.id}`,
    `family: ${family}`,
    `version: 0.1.0`,
    `license: Apache-2.0`,
    `max_steps: ${task.maxSteps}`,
    `entrypoint: environment/task.json`,
    `verifier: verifier/oracle.json`,
    `fingerprint: ${sha(taskFingerprint(task))}`,
    `tags: [long-horizon, accumulating-constraints, background-obligations, deterministic-attribution]`,
  ].join('\n');
  writeFileSync(join(dir, 'task.yaml'), `${yaml}\n`);
  writeFileSync(join(dir, 'environment', 'task.json'), JSON.stringify(task, null, 2));
  writeFileSync(join(dir, 'verifier', 'oracle.json'), JSON.stringify({ oracle, fingerprint: sha(taskFingerprint(task)) }, null, 2));

  const members = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else members.push({ path: rel, sha256: sha(readFileSync(p)), bytes: readFileSync(p).length });
    }
  };
  walk(dir, '');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ members }, null, 2));
  return { id: task.id, dir, members: members.length };
}

export function exportHarbor(outRoot, { quick = false } = {}) {
  mkdirSync(outRoot, { recursive: true });
  const exported = [];

  const coreConfigs = quick
    ? grid({ seeds: [1], depths: [6, 12] })
    : grid({ seeds: [1, 2, 3], depths: [6, 12, 18] });
  for (const cfg of coreConfigs) {
    const { task, oracle } = generate(cfg);
    exported.push(taskDir(outRoot, task, oracle, 'vigil-core'));
  }

  for (let moduleIndex = 0; moduleIndex < MODULES.length; moduleIndex++) {
    for (const obligation of ['off', 'deadline', 'decay']) {
      const { task, oracle } = generateSwe({ moduleIndex, depth: 5, obligation, seed: 1 });
      exported.push(taskDir(outRoot, task, oracle, 'vigil-swe'));
    }
  }

  const index = {
    name: 'vigil',
    version: '0.1.0',
    license: 'Apache-2.0',
    exportedAt: new Date().toISOString(),
    convention: 'commit-pinned task directories with per-member sha256 manifests',
    tasks: exported.map((e) => ({ id: e.id, members: e.members })),
  };
  writeFileSync(join(outRoot, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

const isMain = process.argv[1] && process.argv[1].endsWith('harbor-export.mjs');
if (isMain) {
  const out = resolve(process.argv[2] ?? 'dist/harbor');
  const quick = process.argv.includes('--quick');
  const index = exportHarbor(out, { quick });
  console.log(`exported ${index.tasks.length} tasks to ${out}`);
}