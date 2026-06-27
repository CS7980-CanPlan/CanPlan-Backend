import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

type PersonalCommand = 'deploy' | 'destroy';

const VALID_COMMANDS = new Set<PersonalCommand>(['deploy', 'destroy']);
const RESERVED_ENV_NAMES = new Set(['dev', 'prod', 'sandbox']);
const OWNER_PATTERN = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }

  const assignment = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed;
  const equalsIndex = assignment.indexOf('=');
  if (equalsIndex <= 0) {
    return undefined;
  }

  const key = assignment.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  let value = assignment.slice(equalsIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }

  return [key, value];
}

function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    const [key, value] = parsed;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function resolveOwner(): string {
  const rawOwner = process.env.CDK_OWNER?.trim();
  if (!rawOwner) {
    fail(
      'CDK_OWNER is required. Add CDK_OWNER=michael to .env or export it before running this command.',
    );
  }

  const owner = rawOwner.toLowerCase();
  if (RESERVED_ENV_NAMES.has(owner)) {
    fail(
      `CDK_OWNER cannot be one of the shared environment names: ${[...RESERVED_ENV_NAMES].join(', ')}.`,
    );
  }

  if (!OWNER_PATTERN.test(owner)) {
    fail(
      'CDK_OWNER must be 1-20 lowercase letters, numbers, or hyphens, start with a letter, and end with a letter or number.',
    );
  }

  return owner;
}

const command = process.argv[2] as PersonalCommand | undefined;
if (!command || !VALID_COMMANDS.has(command)) {
  fail('Usage: ts-node scripts/cdk-personal.ts <deploy|destroy> [additional cdk args]');
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

const owner = resolveOwner();
const extraArgs = process.argv.slice(3);
const cdkArgs = [
  command,
  '--all',
  '--context',
  `env=${owner}`,
  '--context',
  'personal=true',
  '--context',
  `owner=${owner}`,
  ...extraArgs,
];
const localCdk = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'cdk.cmd' : 'cdk',
);
const cdkCommand = existsSync(localCdk) ? localCdk : 'cdk';

console.log(`Running: cdk ${cdkArgs.join(' ')}`);

const result = spawnSync(cdkCommand, cdkArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  fail(`Failed to run CDK: ${result.error.message}`);
}

process.exit(result.status ?? 1);
