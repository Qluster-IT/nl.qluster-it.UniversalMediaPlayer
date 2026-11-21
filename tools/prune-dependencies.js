'use strict';

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modules = path.join(root, 'node_modules');
const removableFile = /(?:\.d\.[cm]?ts|\.[cm]?ts|\.map|\.md|\.markdown|\.min\.[cm]?js)$/i;
const removableDirs = new Set(['example', 'examples', 'test', 'tests', '__tests__']);
// Node entry points use protobufjs/src and xml2js/lib, not these alternate builds.
const unused = ['protobufjs/dist', 'protobufjs/cli', 'xml2js/lib/xml2js.bc.js'];
const dryRun = process.argv.includes('--dry-run');
const stats = {files: 0, bytes: 0};
const removed = new Set();

function packagePaths() {
    const command = 'npm ls --parseable --all --omit=dev';
    const output = process.platform === 'win32'
        ? execFileSync(process.env.ComSpec, ['/d', '/s', '/c', command], {cwd: root, encoding: 'utf8'})
        : execFileSync('npm', ['ls', '--parseable', '--all', '--omit=dev'], {cwd: root, encoding: 'utf8'});
    return [...new Set(output.trim().split(/\r?\n/).map(entry => path.resolve(entry)))]
        .filter(entry => entry !== root);
}

function entriesFor(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const entries = new Set();
    const add = value => {
        if (typeof value === 'string') entries.add(path.resolve(dir, value));
        else if (value && typeof value === 'object') Object.values(value).forEach(add);
    };
    add(pkg.main || 'index.js');
    add(pkg.exports);
    add(pkg.bin);
    for (const entry of [...entries]) {
        for (const suffix of ['.js', '.cjs', '.mjs', '/index.js']) entries.add(entry + suffix);
    }
    return entries;
}

function remove(target) {
    if (removed.has(target)) return;
    if (!target.startsWith(modules + path.sep)) throw new Error(`Not a local dependency: ${target}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to prune a symbolic link: ${target}`);
    if (stat.isDirectory()) {
        for (const name of fs.readdirSync(target)) remove(path.join(target, name));
        if (!dryRun) fs.rmdirSync(target);
    } else {
        stats.files++;
        stats.bytes += stat.size;
        if (!dryRun) fs.unlinkSync(target);
    }
    removed.add(target);
}

function prune(dir, entries) {
    for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        if (item.name === 'node_modules') continue;
        const target = path.join(dir, item.name);
        const protectedEntry = [...entries].some(entry => entry === target || entry.startsWith(target + path.sep));
        if (item.isDirectory()) {
            if (removableDirs.has(item.name.toLowerCase()) && !protectedEntry) remove(target);
            else prune(target, entries);
        } else if (item.isFile() && removableFile.test(item.name) && !protectedEntry) {
            remove(target);
        }
    }
}

const packages = packagePaths();
for (const dir of packages) {
    if (!dir.startsWith(modules + path.sep) || fs.lstatSync(dir).isSymbolicLink()) {
        throw new Error(`Refusing to prune an external or linked dependency: ${dir}`);
    }
}
for (const dir of packages) prune(dir, entriesFor(dir));
for (const relative of unused) {
    const target = path.join(modules, relative);
    if (fs.existsSync(target)) remove(target);
}
console.log(`${dryRun ? 'Would prune' : 'Pruned'} ${stats.files} non-runtime files (${stats.bytes} bytes).`);
