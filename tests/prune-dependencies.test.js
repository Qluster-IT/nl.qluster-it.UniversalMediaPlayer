'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('dependency pruning preserves runtime entry points and dev packages and is repeatable', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ump-prune-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const write = (name, value) => {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, value);
    };
    write('package.json', JSON.stringify({
        name: 'prune-fixture', version: '1.0.0', dependencies: {runtime: '1.0.0'}, devDependencies: {editor: '1.0.0'}
    }));
    write('node_modules/runtime/package.json', JSON.stringify({
        name: 'runtime', version: '1.0.0', main: 'dist/main.min.js',
        exports: {'.': './dist/main.min.js', './sample': './examples/entry.js'}
    }));
    write('node_modules/runtime/dist/main.min.js', 'module.exports = true;');
    write('node_modules/runtime/examples/entry.js', 'module.exports = true;');
    write('node_modules/runtime/examples/unused.ts', 'type Unused = string;');
    write('node_modules/runtime/dist/main.min.js.map', '{}');
    write('node_modules/runtime/README.md', 'Documentation');
    write('node_modules/runtime/LICENSE', 'License');
    write('node_modules/editor/package.json', JSON.stringify({name: 'editor', version: '1.0.0'}));
    write('node_modules/editor/index.d.ts', 'export {};');
    fs.mkdirSync(path.join(root, 'tools'));
    fs.copyFileSync(path.join(__dirname, '..', 'tools', 'prune-dependencies.js'), path.join(root, 'tools', 'prune-dependencies.js'));
    const run = (...args) => execFileSync(process.execPath, [path.join(root, 'tools', 'prune-dependencies.js'), ...args],
        {encoding: 'utf8'});
    assert.match(run('--dry-run'), /Would prune 3 non-runtime files/);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/runtime/README.md')), true);
    assert.match(run(), /Pruned 3 non-runtime files/);
    for (const name of ['dist/main.min.js', 'examples/entry.js', 'LICENSE']) {
        assert.equal(fs.existsSync(path.join(root, 'node_modules/runtime', name)), true, name);
    }
    assert.equal(fs.existsSync(path.join(root, 'node_modules/editor/index.d.ts')), true);
    assert.equal(fs.existsSync(path.join(root, 'node_modules/runtime/README.md')), false);
    assert.match(run(), /Pruned 0 non-runtime files \(0 bytes\)/);
});
