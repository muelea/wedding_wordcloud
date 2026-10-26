'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectEnvironment, inspectFlyAccess, assertFlyAccess, ensureEnvironment, repair } = require('../scripts/check-environment');
const { BROWSER_DEPENDENCY_FILES } = require('../scripts/prepare-local');

function fixture(overrides = {}) {
  const calls = [];
  const responses = {
    'npm --version': '10.9.0', 'git --version': 'git version 2.50.0',
    'docker --version': 'Docker version 28.3.0',
    'docker context inspect --format {{.Endpoints.docker.Host}}': 'unix:///local/docker.sock',
    'docker info --format {{.ServerVersion}}': '28.3.0',
    'flyctl version': 'flyctl v0.4.0', 'flyctl auth whoami': 'private-identity',
    'flyctl status --app wolkenworte --json': '{}',
    'git ls-remote --exit-code origin refs/heads/main': 'a'.repeat(40) + '\trefs/heads/main',
    ...overrides,
  };
  const run = (command, args) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    assert.ok(Object.hasOwn(responses, key), `Unexpected command: ${key}`);
    const value = responses[key];
    return typeof value === 'string' ? { status: 0, stdout: value } : value;
  };
  return { run, calls };
}

test('test environment checks only local tools and never reads workstation secrets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=secret-hosted-database');
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(filename, ...args) {
    assert.notEqual(path.resolve(String(filename)), path.join(root, '.env'));
    return original.call(this, filename, ...args);
  });
  const { run, calls } = fixture();
  const checks = inspectEnvironment('test', { root, run, env: { DATABASE_URL: 'secret-hosted-database' } });
  assert.ok(checks.some(check => check.id === 'dependencies' && !check.ok));
  assert.ok(!checks.some(check => check.id === 'env'));
  assert.ok(!JSON.stringify(checks).includes('secret-hosted-database'));
  assert.ok(!calls.some(command => /flyctl|git|psql|pull|run /.test(command)));
});

test('a clean npm ci is accepted without the startup stamp, including inside a release gate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-clean-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"packages":{}}');
  for (const filename of BROWSER_DEPENDENCY_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, filename), 'fixture');
  }
  const tools = fixture();
  const checks = inspectEnvironment('test', { root, env: {}, run(command, args, options) {
    if (command === process.execPath) return { status: 0 };
    return tools.run(command, args, options);
  } });
  assert.equal(fs.existsSync(path.join(root, 'node_modules/.wolkenworte-install.json')), false);
  assert.ok(checks.every(check => check.ok));
});

test('bootstrap explains missing Node without installing anything or requiring npm modules', () => {
  const result = spawnSync('/bin/bash', ['-c',
    'node() { return 127; }; export -f node; exec /bin/bash ./setup.sh test --install'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Node.js 22\+ und npm 10\+/);
  assert.match(result.stdout, /docs\/development-environment.md/);
});

test('local Postgres also rejects an explicit remote Docker context overriding a local host', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-docker-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$WW_CONTEXT_FIXTURE_LOG"\nif [ "$1" = context ]; then printf "ssh://fixture.invalid\\n"; else exit 91; fi\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['-e',
    "require('./test/support/local-postgres').startLocalPostgres().then(()=>process.exit(91)).catch(error=>console.log(error.message))"], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH,
      DOCKER_HOST: 'unix:///local.sock', DOCKER_CONTEXT: 'remote-fixture', WW_CONTEXT_FIXTURE_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lokalen Docker-Dienst/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['context', 'inspect', 'remote-fixture', '--format', '{{.Endpoints.docker.Host}}']);
});

test('Docker diagnostics distinguish a missing CLI, stopped service and remote context', () => {
  const missing = fixture({ 'docker --version': { status: null, error: { code: 'ENOENT' } } });
  const absent = inspectEnvironment('test', { run: missing.run, project: false, env: {} });
  assert.equal(absent.find(check => check.id === 'docker').ok, false);
  assert.deepEqual(absent.find(check => check.id === 'docker').action, ['brew', ['install', '--cask', 'docker-desktop']]);
  assert.ok(!missing.calls.some(command => command.startsWith('docker info')));

  const stopped = fixture({ 'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'sensitive raw error' } });
  const unavailable = inspectEnvironment('test', { run: stopped.run, project: false, env: {} });
  assert.equal(unavailable.find(check => check.id === 'docker').ok, true);
  assert.deepEqual(unavailable.find(check => check.id === 'docker-running').action, ['open', ['-a', 'Docker']]);
  assert.ok(!JSON.stringify(unavailable).includes('sensitive raw error'));

  const remote = fixture();
  const refused = inspectEnvironment('test', { run: remote.run, project: false, env: { DOCKER_HOST: 'tcp://remote:2376' } });
  assert.equal(refused.find(check => check.id === 'docker-local').ok, false);
  assert.ok(!remote.calls.some(command => command.startsWith('docker info')));
  const overridden = fixture({ 'docker context inspect remote --format {{.Endpoints.docker.Host}}': 'ssh://remote-host' });
  const context = inspectEnvironment('test', { run: overridden.run, project: false,
    env: { DOCKER_HOST: 'unix:///local.sock', DOCKER_CONTEXT: 'remote' } });
  assert.equal(context.find(check => check.id === 'docker-local').ok, false);
  assert.ok(!overridden.calls.some(command => command.startsWith('docker info')));
  const external = inspectEnvironment('test', { run: remote.run, project: false, dockerRequired: false, env: {} });
  assert.ok(!external.some(check => check.id.startsWith('docker')));
});

test('installed but permission-blocked tools do not offer a pointless reinstall', () => {
  const { run } = fixture({
    'flyctl version': { status: 1, stderr: 'operation not permitted: private-path' },
    'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'permission denied: private-path' },
  });
  const checks = inspectEnvironment('deploy', { run, project: false, env: {} });
  assert.equal(checks.find(check => check.id === 'flyctl').action, null);
  assert.equal(checks.find(check => check.id === 'docker-running').action, null);
  assert.ok(!JSON.stringify(checks).includes('private-path'));
  assert.match(checks.find(check => check.id === 'flyctl').remedy, /Dateirechte/);
});

test('profiles require their own tools and enforce minimum Node and npm versions', () => {
  const { run, calls } = fixture({ 'npm --version': '9.9.0' });
  const checks = inspectEnvironment('develop', { run, project: false, nodeVersion: '20.0.0' });
  assert.equal(checks.find(check => check.id === 'node').ok, false);
  assert.equal(checks.find(check => check.id === 'npm').ok, false);
  assert.ok(!calls.some(command => /docker|flyctl/.test(command)));
  assert.throws(() => inspectEnvironment('unknown'), /Unbekanntes Profil/);
});

test('Fly diagnosis separates login from app access and never exposes identity or provider errors', () => {
  const unauthenticated = fixture({ 'flyctl auth whoami': { status: 1, stderr: 'private token details' } });
  const login = inspectFlyAccess(unauthenticated.run);
  assert.equal(login[0].ok, false);
  assert.match(login[0].remedy, /flyctl auth login/);
  assert.ok(!unauthenticated.calls.some(command => command.includes('status')));

  const forbidden = fixture({ 'flyctl status --app wolkenworte --json': { status: 1, stderr: 'private token details' } });
  const checks = inspectFlyAccess(forbidden.run);
  assert.equal(checks[0].ok, true);
  assert.equal(checks[1].ok, false);
  assert.match(checks[1].remedy, /Maintainer/);
  assert.ok(!JSON.stringify(checks).includes('private'));
  assert.throws(() => assertFlyAccess(forbidden.run), /Fly-App wolkenworte lesbar/);
  assert.doesNotThrow(() => assertFlyAccess(fixture().run));
});

test('deployment diagnosis checks read-only Git and Fly access without release operations', () => {
  const { run, calls } = fixture({ 'git ls-remote --exit-code origin refs/heads/main': { status: 128 } });
  const checks = inspectEnvironment('deploy', { run, project: false, env: {} });
  assert.equal(checks.find(check => check.id === 'github-access').ok, false);
  assert.ok(!calls.some(command => /secrets|deploy|migrat|push|login/.test(command)));
  assert.ok(calls.some(command => command.includes('flyctl status')));
  const tools = fixture();
  inspectEnvironment('deploy', { run: tools.run, project: false, access: false });
  assert.ok(!tools.calls.some(command => /whoami|status|ls-remote/.test(command)));
});

test('noninteractive and declined repair never install or launch anything', async () => {
  const checks = [{ ok: false, label: 'Docker fehlt', action: ['brew', ['install', '--cask', 'docker-desktop']] }];
  const unexpected = () => assert.fail('No action or prompt expected');
  await repair(checks, { interactive: false, run: unexpected, ask: unexpected, log() {} });
  await repair(checks, { interactive: true, platform: 'darwin', ask: async () => false, run: unexpected });
});

test('repair performs only the individually accepted action and can rebuild broken native packages', async () => {
  const commands = [];
  const checks = [
    { id: 'docker', ok: false, label: 'Docker fehlt', action: ['brew', ['install', '--cask', 'docker-desktop']] },
    { id: 'flyctl', ok: false, label: 'Fly fehlt', action: ['brew', ['install', 'flyctl']] },
    { id: 'native', ok: false, action: 'dependencies' },
  ];
  let rebuild;
  await repair(checks, { platform: 'darwin', interactive: true,
    ask: async question => !question.includes('Fly fehlt'),
    run(command, args) { commands.push([command, args]); return { status: 0 }; },
    installDependencies(root, run, options) { rebuild = options; },
  });
  assert.deepEqual(commands, [['brew', ['install', '--cask', 'docker-desktop']]]);
  assert.deepEqual(rebuild, { force: true });
});

test('failed preflight blocks the caller; successful repair is rechecked before continuing', async () => {
  const failed = { id: 'docker', ok: false, label: 'Docker fehlt', remedy: 'Installieren', action: ['brew', ['install', '--cask', 'docker-desktop']] };
  await assert.rejects(ensureEnvironment('test', { inspect: () => [failed], log() {} }), /Umgebung.*unvollständig/);
  let inspections = 0;
  const checks = await ensureEnvironment('test', { install: true, interactive: true, platform: 'darwin', log() {},
    inspect: () => [++inspections === 1 ? failed : { ...failed, ok: true }],
    ask: async () => true, run: () => ({ status: 0 }),
  });
  assert.equal(inspections, 2);
  assert.ok(checks.every(check => check.ok));
});
