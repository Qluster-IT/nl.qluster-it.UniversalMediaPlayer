'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api');

function fixture(ready = false) {
    const calls = [];
    const speakerGroups = {
        list() { calls.push(['groups.list']); return [{id: 'group:one'}]; },
        save(input) { calls.push(['groups.save', input]); return {id: 'group:new'}; },
        remove(id) { calls.push(['groups.remove', id]); return []; }
    };
    const speakerPlayback = {
        listSpeakers(fresh, wait) { calls.push(['speakers.list', fresh, wait]); return [{id: 'cast:one'}]; }
    };
    return {
        calls,
        homey: {app: {apiReady: ready, speakerGroups, speakerPlayback}}
    };
}

test('readiness endpoint remains available during startup', async () => {
    const {homey} = fixture();
    assert.deepEqual(await api.getApiReady({homey}), {ready: false});
    homey.app.apiReady = true;
    assert.deepEqual(await api.getApiReady({homey}), {ready: true});
});

test('speaker group endpoints reject calls until app initialization is ready', async () => {
    const {homey, calls} = fixture();
    const actions = [
        () => api.getSpeakerGroups({homey}),
        () => api.getSpeakers({homey}),
        () => api.saveSpeakerGroup({homey, body: {name: 'Room'}}),
        () => api.removeSpeakerGroup({homey, params: {id: 'group:one'}})
    ];
    for (const action of actions) {
        await assert.rejects(action, /still starting/);
    }
    assert.deepEqual(calls, []);
});

test('group and speaker endpoints delegate through the shared runtime contract', async () => {
    const {homey, calls} = fixture(true);
    const input = {name: 'Living room', members: ['cast:one']};

    assert.deepEqual(await api.getSpeakerGroups({homey}), [{id: 'group:one'}]);
    assert.deepEqual(await api.getSpeakers({homey}), [{id: 'cast:one'}]);
    assert.deepEqual(await api.getSpeakers({homey, query: {wait: 'true'}}), [{id: 'cast:one'}]);
    assert.deepEqual(await api.getSpeakers({homey, query: {fresh: 'true'}}), [{id: 'cast:one'}]);
    assert.deepEqual(await api.saveSpeakerGroup({homey, body: input}), {id: 'group:new'});
    assert.deepEqual(await api.removeSpeakerGroup({homey, params: {id: 'group:one'}}), []);
    assert.deepEqual(calls, [
        ['groups.list'],
        ['speakers.list', false, false],
        ['speakers.list', false, true],
        ['speakers.list', true, false],
        ['groups.save', input],
        ['groups.remove', 'group:one']
    ]);
});

test('app compose exposes readiness and speaker-group routes', () => {
    const compose = require('../.homeycompose/app.json');
    assert.deepEqual(compose.api, {
        getApiReady: {method: 'get', path: '/api-ready'},
        getSpeakerGroups: {method: 'get', path: '/speaker-groups'},
        getSpeakers: {method: 'get', path: '/speakers'},
        saveSpeakerGroup: {method: 'post', path: '/speaker-groups'},
        removeSpeakerGroup: {method: 'delete', path: '/speaker-groups/:id'}
    });
});
