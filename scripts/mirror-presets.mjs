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
