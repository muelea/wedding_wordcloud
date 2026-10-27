'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const IMAGE_PATHS = ['server.js', 'package.json', 'package-lock.json', 'certs', 'src', 'public', 'views'];

function treeProof(files, read) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file + '\0' + crypto.createHash('sha256').update(read(file)).digest('hex') + '\0');
  }
  return { files: files.length, sha256: hash.digest('hex') };
}

function assertOperatorOnlyChanges(verifiedCommit, run = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(verifiedCommit)) throw new Error('An exact previously verified commit is required.');
  run('git', ['merge-base', '--is-ancestor', verifiedCommit, 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
  const changed = String(run('git', ['diff', '--name-only', verifiedCommit, 'HEAD'], { cwd: ROOT, encoding: 'utf8' }))
    .trim().split('\n').filter(Boolean);
  if (changed.some(file => !/^(?:scripts\/|test\/|docs\/|README\.md$|AGENTS\.md$)/.test(file))) {
    throw new Error('Recovery refuses application, dependency, migration or Fly configuration changes since the verified commit.');
  }
  return changed;
}

function remoteProofCode() {
  return `
    const fs=require("node:fs"), c=require("node:crypto"), files=[];
    function walk(p) {
      const s=fs.statSync("/app/"+p);
      if(s.isDirectory()) {
        for(const n of fs.readdirSync("/app/"+p)) {
          if(n!==".DS_Store") walk(p+"/"+n);
        }
      } else if(s.isFile()) files.push(p);
    }
    for(const p of ${JSON.stringify(IMAGE_PATHS)}) walk(p);
    const h=c.createHash("sha256");
    for(const p of files.sort()) h.update(p+"\\0"+c.createHash("sha256").update(fs.readFileSync("/app/"+p)).digest("hex")+"\\0");
    console.log("WW_IMAGE_PROOF="+JSON.stringify({files:files.length,sha256:h.digest("hex")}));
  `;
}

function verifyImage(machine, imageDigest, run = execFileSync) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || machine?.image_ref?.digest !== imageDigest ||
      machine.image_ref.registry !== 'registry.fly.io' || machine.image_ref.repository !== 'wolkenworte') {
    throw new Error('The re-armed image does not match the exact approved production image.');
  }
  const files = String(run('git', ['ls-files', '-z', '--', ...IMAGE_PATHS], { cwd: ROOT, encoding: 'utf8' })).split('\0').filter(Boolean);
  const expected = treeProof(files, file => fs.readFileSync(path.join(ROOT, file)));
  // Match only the application tree copied by Dockerfile; no environment,
  // customer data, dependency directories or writable runtime state is read.
  // Finder's untracked .DS_Store metadata is not an application file.
  const code = remoteProofCode();
  const quote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  const output = String(run('flyctl', ['ssh', 'console', '--app', 'wolkenworte', '--machine', machine.id,
    '--command', 'node -e ' + quote(code)], { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }));
  const line = output.split('\n').find(value => value.startsWith('WW_IMAGE_PROOF='));
  if (!line) throw new Error('The deployed application tree proof was not returned.');
  const observed = JSON.parse(line.slice('WW_IMAGE_PROOF='.length));
  if (observed.files !== expected.files || observed.sha256 !== expected.sha256) {
    throw new Error('The deployed application tree differs from the approved source.');
  }
  return { imageDigest, ...observed, matched: true };
}

module.exports = { IMAGE_PATHS, treeProof, remoteProofCode, assertOperatorOnlyChanges, verifyImage };
