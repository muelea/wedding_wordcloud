'use strict';

// Built-ins only: this must work before npm ci and must never load .env.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { once } = require('node:events');
const { inspectDependencies, ensureDependencies } = require('./prepare-local');

const ROOT = path.join(__dirname, '..');
const GUIDE = 'docs/development-environment.md';
const PROFILES = ['develop', 'test', 'deploy'];
const INSTALLS = Object.freeze({
  git: ['xcode-select', ['--install']],
  docker: ['brew', ['install', '--cask', 'docker-desktop']],
  flyctl: ['brew', ['install', 'flyctl']],
});

function capture(command, args, { root = ROOT, env = process.env } = {}) {
  return spawnSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });
}

function passed(result) { return !result.error && result.status === 0; }
function missing(result) { return result.error?.code === 'ENOENT'; }
function permissionDenied(result) {
  return ['EACCES', 'EPERM'].includes(result.error?.code) || /permission denied|operation not permitted/i.test(String(result.stderr || ''));
}

function inspectEnvironment(profile, {
  root = ROOT, run = capture, env = process.env, nodeVersion = process.versions.node,
  project = true, access = true, dockerRequired = true,
} = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`Unbekanntes Profil: ${profile}. Erlaubt: ${PROFILES.join(', ')}.`);
  const checks = [];
  const add = (id, ok, label, remedy = '', action = null) => checks.push({ id, ok, label, remedy, action });
  const execute = (command, args) => run(command, args, { root, env });
  add('node', Number.parseInt(nodeVersion, 10) >= 22, `Node.js ${nodeVersion} (benötigt: 22+)`,
    './setup.sh ' + profile + ' --install richtet Node.js 22 samt npm ein.');
  const npm = execute('npm', ['--version']);
  add('npm', passed(npm) && Number.parseInt(npm.stdout, 10) >= 10, 'npm 10 oder neuer',
    './setup.sh ' + profile + ' --install richtet Node.js 22 samt npm ein.');

  if (profile !== 'test') {
    const git = execute('git', ['--version']);
    add('git', passed(git), 'Git', 'Apple Command Line Tools installieren; den macOS-Dialog abschließen.', INSTALLS.git);
  }
  if (profile !== 'develop' && dockerRequired) {
    const cli = execute('docker', ['--version']);
    add('docker', passed(cli), 'Docker-Kommandozeile', 'Docker Desktop installieren oder dessen CLI in PATH aktivieren.', INSTALLS.docker);
    if (passed(cli)) {
      const endpoint = (!env.DOCKER_CONTEXT && env.DOCKER_HOST) || (() => {
        const context = execute('docker', ['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}']);
        return passed(context) ? String(context.stdout || '').trim() : '';
      })();
      const local = endpoint.startsWith('unix://') || endpoint.startsWith('npipe://');
      add('docker-local', local, 'Docker verwendet einen lokalen Dienst',
        'Lokalen Docker-Kontext wählen (docker context ls); DOCKER_HOST/DOCKER_CONTEXT prüfen. Remote-Docker ist für Tests gesperrt.');
      if (local) {
        const daemon = execute('docker', ['info', '--format', '{{.ServerVersion}}']);
        add('docker-running', passed(daemon), 'Docker-Dienst erreichbar',
          permissionDenied(daemon)
            ? 'Zugriff auf den lokalen Docker-Dienst wurde verweigert. macOS-/Dateirechte oder die Freigabe der Agent-/Terminal-Umgebung prüfen.'
            : 'Docker Desktop öffnen, Einrichtung abschließen und warten, bis der Dienst bereit ist.',
          permissionDenied(daemon) ? null : ['open', ['-a', 'Docker']]);
      }
    }
  }
  if (profile === 'deploy') {
    const fly = execute('flyctl', ['version']);
    add('flyctl', passed(fly), 'Fly CLI aufrufbar',
      missing(fly) ? 'Fly CLI installieren oder ihren bin-Ordner in PATH aktivieren.'
        : 'Fly CLI wurde gefunden, kann aber nicht ausgeführt werden. Dateirechte, ~/.fly und Freigaben der Agent-/Terminal-Umgebung prüfen.',
      missing(fly) ? INSTALLS.flyctl : null);
    if (passed(fly) && access) {
      checks.push(...inspectFlyAccess((command, args) => execute(command, args)));
      const remote = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {
        root, env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      });
      add('github-access', passed(remote), 'Git-Remote origin/main lesbar',
        'Netzwerk, Repository-URL und eigene GitHub-Anmeldung/Zugriffsrechte prüfen. Schreibrechte und Release-Commit prüft der Release-Ablauf separat.');
    }
  }
  if (project) {
    if (profile !== 'test') add('env', fs.existsSync(path.join(root, '.env')), 'Lokale .env vorhanden',
      'Die für diese Aufgabe freigegebenen Werte sicher vom Maintainer beziehen. Die Umgebungsprüfung liest keine Secret-Werte; der Start-/Release-Befehl validiert sie anschließend.');
    let installed;
    try {
      // A normal npm ci (including the release gate) removes the local stamp.
      // Accept that clean install; validate package bytes/versions and canvas.
      installed = inspectDependencies(root, { requireStamp: false });
      if (installed.stamp && installed.stamp !== installed.fingerprint) {
        installed.problems.push('Node-Version, Lockfile oder Rechner hat sich geändert');
      }
    }
    catch { installed = { problems: ['Installation kann nicht gelesen werden'] }; }
    add('dependencies', installed.problems.length === 0, 'Projektpakete passen zu Lockfile, Node und Rechner',
      'Reproduzierbare Installation mit npm ci und Prüfung der nativen Pakete erforderlich.', 'dependencies');
    if (!installed.problems.length) {
      const native = run(process.execPath, ['-e', "require('canvas')"], { root, env });
      add('native', passed(native), 'Native Grafikbibliothek canvas ladbar',
        `Installation für diese Node-Version erneuern. Bei Compiler-/Cairo-Fehlern: ${GUIDE}#native-grafikbibliotheken.`, 'dependencies');
    }
  }
  return checks;
}

function inspectFlyAccess(run = capture) {
  const auth = passed(run('flyctl', ['auth', 'whoami']));
  const checks = [{ id: 'fly-auth', ok: auth, label: 'Fly-Anmeldung bestätigt',
    remedy: 'flyctl auth login ausführen. Bei vorhandener Anmeldung auch Netzwerk und Token-Gültigkeit prüfen.', action: null }];
  if (auth) checks.push({ id: 'fly-access', ok: passed(run('flyctl', ['status', '--app', 'wolkenworte', '--json'])),
    label: 'Fly-App wolkenworte lesbar',
    remedy: 'Zugriff nicht bestätigt: Netzwerk prüfen und den Maintainer um Freigabe in der richtigen Fly-Organisation bitten. Lesender Zugriff bestätigt keine Deployment-Schreibrechte.', action: null });
  return checks;
}

function assertFlyAccess(run = capture) {
  const failed = inspectFlyAccess(run).filter(check => !check.ok);
  if (failed.length) throw new Error(failed.map(check => `${check.label}: ${check.remedy}`).join('\n') + `\nAnleitung: ${GUIDE}`);
}

function report(checks, log = console.log) {
  for (const check of checks) {
    log(`[${check.ok ? 'OK' : 'FEHLT'}] ${check.label}`);
    if (!check.ok) log(`  ${check.remedy}`);
  }
}

async function confirm(question) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([
      input.question(`${question} [j/N] `),
      once(input, 'close').then(() => ''),
    ]);
    return /^(?:j|ja|y|yes)$/i.test(answer.trim());
  }
  finally { input.close(); }
}

async function repair(checks, {
  root = ROOT, platform = process.platform, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = confirm, run = spawnSync, log = console.log, installDependencies = ensureDependencies,
} = {}) {
  if (!interactive) {
    log('Keine interaktive Eingabe: nichts installiert. Im eigenen Terminal ./setup.sh <Profil> --install ausführen.');
    return;
  }
  for (const check of checks.filter(item => !item.ok && item.action)) {
    if (check.action === 'dependencies') {
      if (await ask('Projektpakete jetzt gemäß package-lock.json installieren/prüfen (npm ci bei Abweichungen)?')) {
        installDependencies(root, run, { force: check.id === 'native' });
      }
      continue;
    }
    if (platform !== 'darwin') {
      log(`Automatische Programminstallation ist nur für macOS vorgesehen. Siehe ${GUIDE}.`);
      continue;
    }
    const [command, args] = check.action;
    const display = [command, ...args].join(' ');
    if (!await ask(`${check.label}: jetzt „${display}“ ausführen?`)) continue;
    const result = run(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (!passed(result)) log(`Aktion fehlgeschlagen oder noch nicht abgeschlossen. Siehe ${GUIDE}.`);
    if (command === 'open' || command === 'xcode-select') {
      log('Bitte die Einrichtung im macOS-Fenster abschließen und die Prüfung erneut starten.');
    }
  }
}

async function ensureEnvironment(profile, {
  install = false, offerInstall = false, inspect = inspectEnvironment, log = console.log, ...options
} = {}) {
  let checks = inspect(profile, options);
  if (checks.every(check => check.ok)) return checks;
  report(checks, log);
  const shouldRepair = install || (offerInstall && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && !process.env.NODE_TEST_CONTEXT);
  if (shouldRepair) {
    await repair(checks, { ...options, log });
    checks = inspect(profile, options);
  }
  if (checks.some(check => !check.ok)) {
    if (shouldRepair) report(checks.filter(check => !check.ok), log);
    throw new Error(`Umgebung für „${profile}“ noch unvollständig. ./setup.sh ${profile} --install bietet Hilfe; Anleitung: ${GUIDE}.`);
  }
  return checks;
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Verwendung: ./setup.sh [develop|test|deploy] [--install]\nOhne --install wird nur geprüft. Standard: test.');
    return;
  }
  const profile = args.find(arg => !arg.startsWith('-')) || 'test';
  if (args.filter(arg => !arg.startsWith('-')).length > 1 || args.some(arg => arg.startsWith('-') && arg !== '--install')) {
    throw new Error('Verwendung: ./setup.sh [develop|test|deploy] [--install]');
  }
  console.log(`[Umgebung] Profil: ${profile}; Anleitung: ${GUIDE}`);
  const checks = await ensureEnvironment(profile, { install: args.includes('--install') });
  report(checks);
  console.log('Umgebungsprüfung erfolgreich. Start-/Release-Prüfungen folgen im jeweiligen Befehl.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertFlyAccess, ensureEnvironment, inspectEnvironment, inspectFlyAccess, main, repair, report };
