'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const compose = path.join(__dirname, '..', '.homeycompose');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(compose, ...parts), 'utf8'));
const languages = Object.keys(read('app.json').description);
const corrupted = /\uFFFD|\?{2,}|(?:^|[\s'’])\?\p{L}|\p{L}\?\p{L}/u;
const tokens = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]).sort();

function checkTranslation(text, original, label) {
    assert.ok(typeof text === 'string' && text.trim(), `${label}: missing translation`);
    assert.doesNotMatch(text, corrupted, `${label}: corrupted translation`);
    assert.deepEqual(tokens(text, /__(\w+)__/g), tokens(original, /__(\w+)__/g), `${label}: interpolation`);
}

test('locale fragments retain the English keys and interpolation tokens without encoding damage', () => {
    function check(actual, english, label) {
        if (typeof english === 'string') return checkTranslation(actual, english, label);
        assert.ok(actual && typeof actual === 'object', `${label}: missing translations`);
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(english).sort(), `${label}: translation keys`);
        for (const [key, value] of Object.entries(english)) check(actual[key], value, `${label}.${key}`);
    }

    for (const file of fs.readdirSync(path.join(compose, 'locales')).filter(name => name.startsWith('en.'))) {
        const english = read('locales', file);
        for (const language of languages) {
            const name = language + file.slice(2);
            check(read('locales', name), english, name);
        }
    }
});

test('notification Flow text is intact and every formatted title includes all arguments', () => {
    const card = read('flow', 'actions', 'upnpplayer_play_notification.json');
    const args = card.args.filter(arg => arg.type !== 'device');
    const argumentNames = args.map(arg => arg.name).sort();
    const strings = [
        card.title, card.hint, card.titleFormatted,
        ...args.flatMap(arg => [arg.title, ...(arg.values ?? []).map(value => value.label)]),
    ];

    for (const language of languages) {
        for (const table of strings) checkTranslation(table[language], table.en, `notification (${language})`);
        assert.deepEqual(tokens(card.titleFormatted[language], /\[\[(\w+)\]\]/g), argumentNames, language);
    }
});
