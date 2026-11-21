'use strict';

// Preload with node --require to record dependency accesses during local tests.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

if (!process.env.UMP_DEPENDENCY_TRACE) throw new Error('Set UMP_DEPENDENCY_TRACE to a local output file.');
const modules = path.resolve(__dirname, '..', 'node_modules') + path.sep;
const used = new Set();
function note(file) {
    if (typeof file !== 'string') return;
    const resolved = path.resolve(file);
    if (resolved.startsWith(modules)) used.add(resolved);
}
for (const method of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'existsSync', 'statSync', 'readdirSync']) {
    const original = fs[method];
    fs[method] = function (file, ...args) {
        note(file);
        return original.call(this, file, ...args);
    };
}
const readFile = fs.promises.readFile;
fs.promises.readFile = function (file, ...args) {
    note(file);
    return readFile.call(this, file, ...args);
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
    note(Module._resolveFilename(request, parent, isMain));
    return load.apply(this, arguments);
};
process.on('exit', () => {
    fs.appendFileSync(process.env.UMP_DEPENDENCY_TRACE, JSON.stringify([...used].sort()) + '\n');
});
