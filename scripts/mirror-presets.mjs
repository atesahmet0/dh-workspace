/**
 * Manual fallback: mirror the bundle's agent-presets into the user root
 * ($DSH_HOME/.agent-presets). The dh-workspace plugin mirrors presets
 * automatically at boot (packages/dh-workspace/src/index.ts), so this script
 * is no longer wired to any lifecycle hook. Run it by hand only when you need
 * to re-mirror presets without a boot.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sourceDir = fileURLToPath(new URL('../presets/', import.meta.url));
const targetDir = join(dshHome, '.agent-presets');

if (!existsSync(sourceDir)) {
  process.exit(0); // dev checkout without a presets/ dir — nothing to mirror
}

mkdirSync(targetDir, { recursive: true });

for (const entry of readdirSync(sourceDir)) {
  if (entry.startsWith('.')) continue; // skip dotfiles
  cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true });
}

console.log(`dh-multiagents: presets mirrored to ${targetDir}`);
