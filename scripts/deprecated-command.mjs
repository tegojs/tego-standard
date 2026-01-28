#!/usr/bin/env node

const oldCmd = process.argv[2];
const newCmd = process.argv[3];
const actualArgs = process.argv.slice(4);

// Print deprecation warning in red with box
console.error('\x1b[31m');
console.error('╔═════════════════════════════════════════════════════════════════════╗');
console.error(`║  DEPRECATED: '${oldCmd}' is deprecated and will be removed soon.`.padEnd(70) + '║');
console.error(`║  Please migrate to '${newCmd}' command.`.padEnd(70) + '║');
console.error('╚═════════════════════════════════════════════════════════════════════╝');
console.error('\x1b[0m');

// Execute the new command using pnpm run
import { spawn } from 'child_process';

const isWindows = process.platform === 'win32';

const child = spawn('pnpm', ['run', newCmd, ...actualArgs], {
  stdio: 'inherit',
  shell: isWindows,
  env: process.env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`Failed to execute '${newCmd}':`, err.message);
  process.exit(1);
});
