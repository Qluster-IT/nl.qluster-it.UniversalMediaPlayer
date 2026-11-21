'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const localesDir = path.join(root, '.homeycompose', 'locales');

test('speaker group settings are localized for every app language', () => {
    const app = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'app.json'), 'utf8'));
    const languages = Object.keys(app.description);
    const english = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.settings.json'), 'utf8'));
    const requiredKeys = new Set(Object.keys(english));
    const script = fs.readFileSync(path.join(root, 'settings', 'speaker-groups.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'settings', 'index.html'), 'utf8');
    for (const [, key] of script.matchAll(/translate\('([^']+)'\)/g)) requiredKeys.add(key);
    for (const [, key] of html.matchAll(/data-i18n="settings\.([^"]+)"/g)) requiredKeys.add(key);

    for (const language of languages) {
        const localePath = path.join(localesDir, `${language}.settings.json`);
        assert.ok(fs.existsSync(localePath), `missing settings translations for ${language}`);
        const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
        for (const key of requiredKeys) {
            assert.equal(typeof locale[key], 'string', `missing ${language} settings key ${key}`);
        }
        assert.equal(Object.keys(locale).length, Object.keys(english).length,
            `${language} settings keys differ from English`);
        assert.ok(Object.values(locale).every(value => !value.includes('\uFFFD')),
            `${language} settings contain corrupted characters`);
    }
});

test('settings expose accessible tabs, panels, live status and keyboard navigation', () => {
    const html = fs.readFileSync(path.join(root, 'settings', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'settings', 'speaker-groups.js'), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id));
    assert.match(html, /role="tablist"/);
    assert.equal((html.match(/role="tab"/g) || []).length, 2);
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 2);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /class="hy-nostyle/);
    assert.match(script, /ArrowLeft.*ArrowRight.*Home.*End/);
    assert.match(script, /aria-valuetext/);
    for (const [, id] of script.matchAll(/el\('([^']+)'\)/g)) {
        assert.ok(ids.has(id), `settings markup is missing element #${id}`);
    }
});
