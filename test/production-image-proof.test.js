'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const proof = require('../scripts/production-image-proof');

test('the actual remote proof program hashes nested application files and ignores Finder metadata only', () => {
  const vm = require('node:vm');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-image-proof-'));
  try {
    for (const p of proof.IMAGE_PATHS) {
      if (p.includes('.')) fs.writeFileSync(path.join(root,p), p);
      else { fs.mkdirSync(path.join(root,p)); fs.writeFileSync(path.join(root,p,'app.txt'),p); }
    }
    fs.writeFileSync(path.join(root,'public','.DS_Store'),'Finder metadata');
    fs.mkdirSync(path.join(root,'public','nested'));
    fs.writeFileSync(path.join(root,'public','nested','image.png'),'exact image bytes');
    const files = ['server.js','package.json','package-lock.json','certs/app.txt','src/app.txt','public/app.txt',
      'views/app.txt','public/nested/image.png'];
    const map = p => path.join(root,p.slice('/app/'.length));
    const remoteFs = Object.fromEntries(['statSync','readdirSync','readFileSync'].map(name => [name,p=>fs[name](map(p))]));
    let output;
    vm.runInNewContext(proof.remoteProofCode(), { require: name => name === 'node:fs' ? remoteFs : require(name),
      console: { log: value => { output=value; } } });
    assert.deepEqual(JSON.parse(output.slice('WW_IMAGE_PROOF='.length)),
      proof.treeProof(files,p=>fs.readFileSync(path.join(root,p))));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('application tree proofs bind both file names and exact bytes independently of traversal order', () => {
  const read = file => Buffer.from(file);
  assert.deepEqual(proof.treeProof(['a', 'b'], read), proof.treeProof(['b', 'a'], read));
  assert.notEqual(proof.treeProof(['a', 'b'], read).sha256, proof.treeProof(['a', 'c'], read).sha256);
  assert.notEqual(proof.treeProof(['a', 'b'], read).sha256, proof.treeProof(['a', 'b'], () => Buffer.from('changed')).sha256);
});

test('image recovery refuses any unverified runtime, dependency, migration or Fly configuration change', () => {
  const verified = 'a'.repeat(40);
  const run = changed => (command, args) => args[0] === 'diff' ? changed.join('\n') : '';
  assert.deepEqual(proof.assertOperatorOnlyChanges(verified, run(['scripts/production-readiness-smoke.js', 'test/hosting.test.js'])),
    ['scripts/production-readiness-smoke.js', 'test/hosting.test.js']);
  for (const changed of ['src/mugPrint.js', 'public/js/mug-editor.js', 'views/configure.ejs',
    'package-lock.json', 'supabase/migrations/new.sql', 'fly.production.toml', 'certs/ca.crt']) {
    assert.throws(() => proof.assertOperatorOnlyChanges(verified, run([changed])), /Recovery refuses/);
  }
  assert.throws(() => proof.assertOperatorOnlyChanges('main', run([])), /exact previously verified/);
});

test('recovery verifies the exact live image and its complete application tree using read-only SSH', () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const machine = { id: 'machine-fixture', image_ref: { digest, registry: 'registry.fly.io', repository: 'wolkenworte' } };
  const files = ['server.js', 'public/js/design-fonts.js'];
  const expected = proof.treeProof(files, file => fs.readFileSync(path.join(__dirname, '..', file)));
  let ssh = 0;
  const run = (command, args) => {
    if (command === 'git') return files.join('\0') + '\0';
    ssh++;
    assert.deepEqual(args.slice(0, 4), ['ssh', 'console', '--app', 'wolkenworte']);
    assert.ok(args.includes(machine.id));
    assert.doesNotMatch(args.at(-1), /process\.env|writeFile|DATABASE_URL/);
    return 'WW_IMAGE_PROOF=' + JSON.stringify(expected) + '\n';
  };
  assert.equal(proof.verifyImage(machine, digest, run).matched, true);
  assert.equal(ssh, 1);
  assert.throws(() => proof.verifyImage(machine, 'sha256:' + 'd'.repeat(64), run), /exact approved production image/);
  assert.equal(ssh, 1, 'A changed image must fail before SSH');
  assert.throws(() => proof.verifyImage(machine, digest, (command, args) => command === 'git' ? files.join('\0') :
    'WW_IMAGE_PROOF=' + JSON.stringify({ ...expected, sha256: 'changed' })), /differs/);
});
