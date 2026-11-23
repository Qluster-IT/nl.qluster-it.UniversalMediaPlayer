'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function loadApp() {
    const filename = require.resolve('../app');
    const app = new Module(filename, module);
    app.filename = filename;
    app.paths = module.paths;
    app.require = id => id === 'homey' ? {App: class {}} : Module.prototype.require.call(app, id);
    app._compile(fs.readFileSync(filename, 'utf8'), filename);
    return app.exports;
}

test('release notice records its attempt before sending and is not retried on failure', async () => {
    const App = loadApp();
    const app = new App();
    let stored = false;
    let attempts = 0;
    const errors = [];
    app.error = (...args) => errors.push(args);
    app.homey = {
        __: () => 'notice',
        settings: {get: () => stored, set: async () => { stored = true; }},
        notifications: {createNotification: async ({excerpt}) => {
            assert.equal(excerpt, 'notice');
            assert.equal(stored, true);
            attempts++;
            throw new Error('Unavailable');
        }}
    };
    await app._notifyReleaseFeatures();
    await app._notifyReleaseFeatures();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
});

test('release notice does not consume its attempt when the translation is missing', async () => {
    const App = loadApp();
    const app = new App();
    let stored = false;
    let attempts = 0;
    const errors = [];
    app.error = (...args) => errors.push(args);
    app.homey = {
        __: key => key,
        settings: {get: () => stored, set: async () => { stored = true; }},
        notifications: {createNotification: async () => { attempts++; }}
    };
    await app._notifyReleaseFeatures();
    assert.equal(stored, false);
    assert.equal(attempts, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /Missing translation: release\.speaker_playback_notice/);
});

test('release notices exist without corrupted text in every supported language', () => {
    for (const language of ['en', 'nl', 'de', 'fr', 'it', 'es', 'da', 'no', 'sv', 'pl', 'ru', 'ko', 'ar']) {
        const notice = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'locales',
            `${language}.release.json`), 'utf8')).speaker_playback_notice;
        assert.equal(typeof notice, 'string', language);
        assert(notice.length > 50, language);
        assert(!/[?\uFFFD]/.test(notice), language);
    }
});
