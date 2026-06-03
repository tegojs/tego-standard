#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

const options = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(repoRoot, options.outputDir);
const packages = discoverPackages({
  includeApps: options.includeApps,
  includePackages: options.includePackages,
  only: options.packages,
});

console.log(`Discovered ${packages.length} packages with package.json.`);
console.log(`Packages with test files: ${packages.filter((item) => item.testFileCount > 0).length}`);

if (!options.run) {
  console.log('');
  console.log('Dry run only. Add --run to execute tests.');
  printPlan(packages, options);
  process.exit(0);
}

const runDir = path.join(outputDir, timestamp());
mkdirSync(runDir, { recursive: true });

const results = [];
for (const [index, pkg] of packages.entries()) {
  if (pkg.testFileCount === 0) {
    results.push({
      name: pkg.name,
      packageName: pkg.name,
      directory: pkg.directory,
      packageDirectory: pkg.directory,
      file: null,
      mode: options.fileLevel ? 'file' : 'package',
      skipped: true,
      skipReason: 'no test files',
      packageJsonParseError: pkg.packageJsonParseError,
      testFileCount: 0,
      command: null,
      exitCode: null,
      timedOut: false,
      wallSeconds: 0,
      slow: false,
      logPath: null,
      vitest: null,
    });
    continue;
  }

  const targets = options.fileLevel
    ? pkg.testFiles.map((file, fileIndex) => ({
        label: file,
        commandTarget: file,
        logName: `${safeFileName(pkg.directory)}__${String(fileIndex + 1).padStart(3, '0')}__${safeFileName(file)}`,
        file,
      }))
    : [
        {
          label: pkg.directory,
          commandTarget: pkg.directory,
          logName: safeFileName(pkg.directory),
          file: null,
        },
      ];

  for (const [targetIndex, target] of targets.entries()) {
    const command = buildVitestCommand(target.commandTarget, options.project);
    const logPath = path.join(runDir, `${target.logName}.log`);
    const prefix = options.fileLevel
      ? `[pkg ${index + 1}/${packages.length} file ${targetIndex + 1}/${targets.length}]`
      : `[pkg ${index + 1}/${packages.length}]`;

    console.log(`${formatClock()} START ${prefix} ${pkg.directory}${target.file ? ` :: ${target.file}` : ''}`);
    console.log(`  ${command.join(' ')}`);

    const run = await runCommand(command, {
      timeoutSeconds: options.timeoutSeconds,
      cwd: repoRoot,
    });
    writeFileSync(logPath, run.output, 'utf8');

    const vitest = parseVitestOutput(run.output);
    const exitText = run.timedOut ? 'TIMEOUT' : `exit=${run.exitCode}`;
    console.log(
      `${formatClock()} END   ${prefix} ${pkg.directory}${target.file ? ` :: ${target.file}` : ''} wall=${run.wallSeconds}s ${exitText}`,
    );

    results.push({
      name: pkg.name,
      packageName: pkg.name,
      directory: options.fileLevel ? target.file : pkg.directory,
      packageDirectory: pkg.directory,
      file: target.file,
      mode: options.fileLevel ? 'file' : 'package',
      skipped: false,
      skipReason: null,
      packageJsonParseError: pkg.packageJsonParseError,
      testFileCount: options.fileLevel ? 1 : pkg.testFileCount,
      command: command.join(' '),
      exitCode: run.timedOut ? null : run.exitCode,
      timedOut: run.timedOut,
      wallSeconds: run.wallSeconds,
      slow: run.wallSeconds >= options.slowThresholdSeconds,
      logPath: toPosix(path.relative(repoRoot, logPath)),
      vitest,
    });
  }
}

const jsonPath = path.join(runDir, 'summary.json');
const markdownPath = path.join(runDir, 'summary.md');
const csvPath = path.join(runDir, 'summary.csv');

writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
writeFileSync(markdownPath, renderMarkdown(results, options), 'utf8');
writeFileSync(csvPath, renderCsv(results), 'utf8');

console.log('');
console.log(`Wrote ${toPosix(path.relative(repoRoot, jsonPath))}`);
console.log(`Wrote ${toPosix(path.relative(repoRoot, markdownPath))}`);
console.log(`Wrote ${toPosix(path.relative(repoRoot, csvPath))}`);

function parseArgs(argv) {
  const parsed = {
    run: false,
    includeApps: false,
    includePackages: true,
    packages: [],
    fileLevel: false,
    listFiles: false,
    project: 'all',
    outputDir: '.tmp/test-timings',
    timeoutSeconds: 900,
    slowThresholdSeconds: 60,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === '--run') parsed.run = true;
    else if (arg === '--file-level') parsed.fileLevel = true;
    else if (arg === '--list-files') parsed.listFiles = true;
    else if (arg === '--include-apps') parsed.includeApps = true;
    else if (arg === '--no-packages') parsed.includePackages = false;
    else if (arg === '--package') parsed.packages.push(next());
    else if (arg === '--project') parsed.project = next();
    else if (arg === '--output-dir') parsed.outputDir = next();
    else if (arg === '--timeout-seconds') parsed.timeoutSeconds = Number(next());
    else if (arg === '--slow-threshold-seconds') parsed.slowThresholdSeconds = Number(next());
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['all', 'client', 'server'].includes(parsed.project)) {
    throw new Error('--project must be one of: all, client, server');
  }
  if (!Number.isFinite(parsed.timeoutSeconds) || parsed.timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be a positive number');
  }
  if (!Number.isFinite(parsed.slowThresholdSeconds) || parsed.slowThresholdSeconds <= 0) {
    throw new Error('--slow-threshold-seconds must be a positive number');
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/measure-package-tests.mjs [options]

Default is dry-run. It only lists packages and commands.

Options:
  --run                         Actually execute per-package test commands
  --file-level                  Run each test file separately within each package
  --list-files                  Expand test files in dry-run output
  --project all|client|server   Add Vitest --project filter (default: all)
  --include-apps                Include apps/* packages
  --no-packages                 Do not include packages/*
  --package <name|dir|basename> Limit to one package; repeatable
  --output-dir <dir>            Output directory (default: .tmp/test-timings)
  --timeout-seconds <n>         Per-package timeout (default: 900)
  --slow-threshold-seconds <n>  Mark slow packages (default: 60)
  --help                        Show this help

Examples:
  node scripts/measure-package-tests.mjs
  node scripts/measure-package-tests.mjs --run --project client
  node scripts/measure-package-tests.mjs --run --file-level --package packages/client --project client
  node scripts/measure-package-tests.mjs --run --package packages/client
`);
}

function discoverPackages({ includeApps, includePackages, only }) {
  const roots = [];
  if (includeApps) roots.push('apps');
  if (includePackages) roots.push('packages');

  const output = [];
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;

    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const absoluteDir = path.join(absoluteRoot, entry.name);
      const packageJsonPath = path.join(absoluteDir, 'package.json');
      if (!existsSync(packageJsonPath)) continue;

      const relDir = toPosix(path.relative(repoRoot, absoluteDir));
      const { json, error } = readPackageJson(packageJsonPath);
      const name = json?.name || entry.name;

      if (
        only.length > 0 &&
        !only.includes(name) &&
        !only.includes(relDir) &&
        !only.includes(entry.name)
      ) {
        continue;
      }

      const testFiles = findTestFiles(absoluteDir);
      output.push({
        name,
        directory: relDir,
        private: Boolean(json?.private),
        packageJsonParseError: error,
        testFileCount: testFiles.length,
        testFiles: testFiles.map((item) => toPosix(path.relative(repoRoot, item))),
      });
    }
  }

  return output.sort((a, b) => a.directory.localeCompare(b.directory));
}

function readPackageJson(filePath) {
  try {
    return { json: JSON.parse(readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { json: null, error: error.message };
  }
}

function findTestFiles(absoluteDir) {
  const results = [];
  walk(absoluteDir, results);
  return results;

  function walk(currentDir, out) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib') continue;

      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, out);
      } else if (/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(absolute);
      }
    }
  }
}

function buildVitestCommand(packageDir, project) {
  const command = ['pnpm', 'exec', 'vitest', 'run', packageDir, '--reporter=verbose', '--logHeapUsage'];
  if (project !== 'all') {
    command.push('--project', project);
  }
  return command;
}

function runCommand(command, { cwd, timeoutSeconds }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(command[0], command.slice(1), {
      cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        CI: process.env.CI || '1',
      },
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const ended = process.hrtime.bigint();
      const wallSeconds = Number(ended - started) / 1_000_000_000;
      resolve({
        exitCode,
        signal,
        timedOut,
        wallSeconds: round(wallSeconds, 3),
        output,
      });
    });
  });
}

function parseVitestOutput(text) {
  const normalized = stripAnsi(text);
  const summary = {
    testFilesTotal: null,
    testFilesPassed: null,
    testFilesFailed: null,
    testsTotal: null,
    testsPassed: null,
    testsFailed: null,
    testsSkipped: null,
    transformSeconds: null,
    setupSeconds: null,
    collectSeconds: null,
    testsSeconds: null,
    environmentSeconds: null,
    prepareSeconds: null,
    heapMb: null,
    warningCount: countMatches(normalized, /\bwarning\b|⚠️/gi),
    stdoutBlockCount: countMatches(normalized, /^stdout \|/gm),
    stderrBlockCount: countMatches(normalized, /^stderr \|/gm),
  };

  const fileMatch = normalized.match(/Test Files\s+(?:(?<failed>\d+)\s+failed\s+\|\s+)?(?:(?<passed>\d+)\s+passed\s+)?\((?<total>\d+)\)/);
  if (fileMatch?.groups) {
    summary.testFilesTotal = toInt(fileMatch.groups.total);
    summary.testFilesPassed = toInt(fileMatch.groups.passed);
    summary.testFilesFailed = toInt(fileMatch.groups.failed);
  }

  const testsMatch = normalized.match(/Tests\s+(?:(?<failed>\d+)\s+failed\s+\|\s+)?(?:(?<passed>\d+)\s+passed\s*)?(?:\|\s+(?<skipped>\d+)\s+skipped\s*)?\((?<total>\d+)\)/);
  if (testsMatch?.groups) {
    summary.testsTotal = toInt(testsMatch.groups.total);
    summary.testsPassed = toInt(testsMatch.groups.passed);
    summary.testsFailed = toInt(testsMatch.groups.failed);
    summary.testsSkipped = toInt(testsMatch.groups.skipped);
  }

  const durationMatch = normalized.match(
    /Duration\s+[\d.,]+(?:ms|s|m)\s+\(transform\s+(?<transform>[\d.,]+)(?<transformUnit>ms|s|m),\s+setup\s+(?<setup>[\d.,]+)(?<setupUnit>ms|s|m),\s+collect\s+(?<collect>[\d.,]+)(?<collectUnit>ms|s|m),\s+tests\s+(?<tests>[\d.,]+)(?<testsUnit>ms|s|m),\s+environment\s+(?<environment>[\d.,]+)(?<environmentUnit>ms|s|m),\s+prepare\s+(?<prepare>[\d.,]+)(?<prepareUnit>ms|s|m)\)/,
  );
  if (durationMatch?.groups) {
    summary.transformSeconds = parseDuration(durationMatch.groups.transform, durationMatch.groups.transformUnit);
    summary.setupSeconds = parseDuration(durationMatch.groups.setup, durationMatch.groups.setupUnit);
    summary.collectSeconds = parseDuration(durationMatch.groups.collect, durationMatch.groups.collectUnit);
    summary.testsSeconds = parseDuration(durationMatch.groups.tests, durationMatch.groups.testsUnit);
    summary.environmentSeconds = parseDuration(durationMatch.groups.environment, durationMatch.groups.environmentUnit);
    summary.prepareSeconds = parseDuration(durationMatch.groups.prepare, durationMatch.groups.prepareUnit);
  }

  const heapMatch = normalized.match(/(?<heap>\d+)\s+MB heap used/);
  if (heapMatch?.groups) {
    summary.heapMb = Number(heapMatch.groups.heap);
  }

  return summary;
}

function renderMarkdown(results, options) {
  const ran = results.filter((item) => !item.skipped);
  const skipped = results.filter((item) => item.skipped);
  const failed = ran.filter((item) => item.timedOut || item.exitCode !== 0);
  const slow = ran.filter((item) => item.slow);
  const parseErrors = results.filter((item) => item.packageJsonParseError);

  const lines = [];
  lines.push('# Package Test Timing Summary');
  lines.push('');
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- project: ${options.project}`);
  lines.push(`- mode: ${options.fileLevel ? 'file-level' : 'package-level'}`);
  lines.push(`- timeoutSeconds: ${options.timeoutSeconds}`);
  lines.push(`- packages: ${results.length}`);
  lines.push(`- packagesRun: ${ran.length}`);
  lines.push(`- packagesSkipped: ${skipped.length}`);
  lines.push(`- failedOrTimedOut: ${failed.length}`);
  lines.push(`- slowThresholdSeconds: ${options.slowThresholdSeconds}`);
  lines.push(`- slowPackages: ${slow.length}`);
  lines.push(`- packageJsonParseErrors: ${parseErrors.length}`);
  lines.push('');
  lines.push('## Slowest Packages');
  lines.push('');
  lines.push('| package | target | file | wall(s) | exit | timeout | files | tests | collect(s) | test(s) | heap(MB) | warnings | log |');
  lines.push('| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');

  for (const item of [...ran].sort((a, b) => b.wallSeconds - a.wallSeconds)) {
    lines.push(
      `| ${item.packageName} | ${item.directory} | ${item.file ?? ''} | ${item.wallSeconds} | ${item.exitCode ?? ''} | ${item.timedOut} | ${item.testFileCount} | ${item.vitest?.testsTotal ?? ''} | ${item.vitest?.collectSeconds ?? ''} | ${item.vitest?.testsSeconds ?? ''} | ${item.vitest?.heapMb ?? ''} | ${item.vitest?.warningCount ?? ''} | ${item.logPath ?? ''} |`,
    );
  }

  lines.push('');
  lines.push('## Failed Or Timed Out');
  lines.push('');
  if (failed.length === 0) {
    lines.push('None.');
  } else {
    for (const item of failed) {
      lines.push(`- ${item.directory}: exit=${item.exitCode ?? ''}, timedOut=${item.timedOut}, wall=${item.wallSeconds}s, log=${item.logPath}`);
    }
  }

  lines.push('');
  lines.push('## Skipped Packages');
  lines.push('');
  if (skipped.length === 0) {
    lines.push('None.');
  } else {
    for (const item of skipped) {
      lines.push(`- ${item.directory}: ${item.skipReason}`);
    }
  }

  if (parseErrors.length > 0) {
    lines.push('');
    lines.push('## Package.json Parse Errors');
    lines.push('');
    for (const item of parseErrors) {
      lines.push(`- ${item.directory}: ${item.packageJsonParseError}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderCsv(results) {
  const header = [
    'name',
    'packageName',
    'packageDirectory',
    'directory',
    'file',
    'mode',
    'skipped',
    'exitCode',
    'timedOut',
    'wallSeconds',
    'testFileCount',
    'testsTotal',
    'testsPassed',
    'testsFailed',
    'collectSeconds',
    'testsSeconds',
    'heapMb',
    'warningCount',
    'logPath',
  ];
  const rows = [header];
  for (const item of results) {
    rows.push([
      item.name,
      item.packageName,
      item.packageDirectory,
      item.directory,
      item.file ?? '',
      item.mode,
      item.skipped,
      item.exitCode ?? '',
      item.timedOut,
      item.wallSeconds,
      item.testFileCount,
      item.vitest?.testsTotal ?? '',
      item.vitest?.testsPassed ?? '',
      item.vitest?.testsFailed ?? '',
      item.vitest?.collectSeconds ?? '',
      item.vitest?.testsSeconds ?? '',
      item.vitest?.heapMb ?? '',
      item.vitest?.warningCount ?? '',
      item.logPath ?? '',
    ]);
  }
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

function printPlan(items, options) {
  const rows = options.fileLevel || options.listFiles
    ? items.flatMap((item) =>
        item.testFiles.length === 0
          ? [
              {
                name: item.name,
                directory: item.directory,
                file: '',
                tests: 0,
                packageJson: item.packageJsonParseError ? 'parse-error' : 'ok',
              },
            ]
          : item.testFiles.map((file) => ({
              name: item.name,
              directory: item.directory,
              file,
              tests: 1,
              packageJson: item.packageJsonParseError ? 'parse-error' : 'ok',
            })),
      )
    : items.map((item) => ({
        name: item.name,
        directory: item.directory,
        tests: item.testFileCount,
        packageJson: item.packageJsonParseError ? 'parse-error' : 'ok',
      }));
  console.table(rows);
}

function parseDuration(value, unit) {
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  if (unit === 'ms') return round(number / 1000, 3);
  if (unit === 's') return round(number, 3);
  if (unit === 'm') return round(number * 60, 3);
  return null;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function countMatches(value, regexp) {
  return [...value.matchAll(regexp)].length;
}

function toInt(value) {
  return value == null ? null : Number(value);
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function safeFileName(value) {
  return value.replace(/[\\/:"*?<>|]+/g, '_');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function formatClock() {
  return new Date().toISOString();
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
