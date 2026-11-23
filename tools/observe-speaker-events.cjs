'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {HomeyAPI} = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'node_modules', 'homey-api'));
const {HP2023: config} = require(path.join(process.env.USERPROFILE, '.copilot', 'instructions', 'homey-connections.json')).servers;

const speaker = 'dlna:uuid:rincon_c438750f709001400';
const address = `https://${new URL(config.url).hostname.replace(/\./g, '-')}.homey.homeylocal.com`;

(async () => {
    const login = await fetch(`${address}/api/manager/users/login-local`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...config.localLogin, clientName: 'UMP read-only event observer',
            clientId: '5f03044d9492e57edb845770'}),
        signal: AbortSignal.timeout(10000)
    });
    if (!login.ok) throw new Error(`Local login failed (HTTP ${login.status}).`);
    const token = await login.json();
    assert.equal(typeof token, 'string');
    const api = await HomeyAPI.createLocalAPI({address, token});
    assert.equal(api.id, '63c568cbb329510b96d0ef7c');
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    const state = () => app.get({path: `/widget/media/api/state?speaker=${encodeURIComponent(speaker)}`});
    let pending;
    let count = 0;
    let changed = false;
    let baseline;
    let failure;
    const summary = player => ({
        playing: player.playing, volume: player.volume, muted: player.muted,
        position: player.position, duration: player.duration, roomCount: player.roomCount
    });
    const onEvent = event => {
        if (event.speaker !== speaker) return;
        count++;
        if (pending) return;
        const started = Date.now();
        pending = state().then(result => {
            if (result.error || !result.player) throw new Error(result.error || 'Speaker state missing.');
            const current = summary(result.player);
            if (baseline && ['volume', 'muted', 'playing'].some(key => current[key] !== baseline[key])) changed = true;
            console.log(JSON.stringify({event: count, stateReadMs: Date.now() - started, ...current}));
        }).catch(error => {
            failure = error;
            console.error(`Event state read failed: ${error.message}`);
        }).finally(() => { pending = null; });
    };
    app.on('speaker_state_changed', onEvent);
    try {
        await app.connect();
        const first = await state();
        if (first.error || !first.player) throw new Error(first.error || 'Tuin state missing.');
        baseline = summary(first.player);
        console.log(JSON.stringify({ready: true, readOnly: true, homey: 'HP2023', ...baseline}));
        await delay(120000);
        if (pending) await pending;
        if (failure) throw failure;
        console.log(JSON.stringify({finished: true, events: count, observedControlChange: changed}));
    } finally {
        app.off('speaker_state_changed', onEvent);
        await app.disconnect();
        await api.disconnect();
    }
})().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
