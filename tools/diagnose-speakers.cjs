'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {setTimeout: delay} = require('node:timers/promises');
const {performance} = require('node:perf_hooks');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));

const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const musicPath = [
    {id: '21', name: 'Muziek'}, {id: '22', name: 'Op map'}, {id: '22$11961', name: 'Onze muziek'},
    {id: '22$12011', name: 'Acda en de Munnik'}, {id: '22$12019', name: 'Acda & de Munnik - Naar huis'}
];
const targets = [
    {id: 'dlna:uuid:66ca30fb-9c0d-4b83-98a8-1c981e8c8e68', name: '[TV] The Frame'},
    {id: 'dlna:uuid:rincon_c438750f709001400', name: 'Tuin'},
    {id: 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac', name: 'QlusterIT-Host'}
];
const valueAfter = option => process.argv[process.argv.indexOf(option) + 1];
const rounds = process.argv.includes('--rounds') ? Number(valueAfter('--rounds')) : 1;
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
const video = process.argv.includes('--video-fixture')
    ? JSON.parse(fs.readFileSync(valueAfter('--video-fixture'), 'utf8')) : null;

function summary(result) {
    const state = result?.player;
    if (!state) return result?.items ? {count: result.items.length, next: result.next} : result;
    return {
        error: result.error, name: state.name, protocol: state.protocol, playing: state.playing,
        paused: state.paused, locked: state.locked, volume: state.volume, muted: state.muted,
        shuffle: state.shuffle, repeat: state.repeat, position: state.position,
        trackNumber: state.trackNumber, trackTotal: state.trackTotal, duration: state.duration,
        canPlay: state.canPlay, canNavigate: state.canNavigate, actions: state.actions,
        controlRejected: state.controlRejected, defaultTarget: state.defaultTarget, currentTarget: state.currentTarget
    };
}

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    assert.equal((await app.get({path: '/api-ready'})).ready, true);
    const state = id => app.get({path: `/widget/media/api/state?player=${player}${id ? `&speaker=${encodeURIComponent(id)}` : ''}`});
    const control = body => app.post({path: '/widget/media/api/control', body: {player, ...body}});
    const before = await state();
    const savedTarget = before.player.currentTarget;
    const baseline = new Map();
    const selected = process.argv.includes('--target') ? targets.filter(t => t.name === valueAfter('--target')) : targets;
    assert(selected.length);
    for (const target of selected) baseline.set(target.id, (await state(target.id)).player);
    let failures = 0;
    async function measure(target, round, operation, run, check = () => {}) {
        const started = performance.now();
        try {
            const result = await run();
            check(result);
            console.log(JSON.stringify({target: target.name, round, operation, ms: Math.round(performance.now() - started), ok: true, result: summary(result)}));
            return result;
        } catch (error) {
            console.log(JSON.stringify({target: target.name, round, operation, ms: Math.round(performance.now() - started), ok: false, error: error.message}));
            failures++;
            if (/too many requests/i.test(error.message)) {
                await delay(60000);
                throw error;
            }
        } finally {
            await delay(200);
        }
    }
    if (!process.argv.includes('--run')) {
        for (const target of selected) console.log(JSON.stringify({target: target.name, baseline: summary({player: baseline.get(target.id)})}));
        return;
    }
    const players = (await app.get({path: '/widget/media/api/state'})).players;
    for (const other of players.filter(item => item.id !== player)) {
        const current = (await app.get({path: `/widget/media/api/state?player=${other.id}`})).player;
        const target = current?.currentTarget || current?.defaultTarget;
        if ((current?.playing || current?.paused) && targets.some(item => item.id === target?.id)) {
            console.log(JSON.stringify({operation: 'release-other-UMP-test-owner', player: other.name, target: target.name}));
            await app.post({path: '/widget/media/api/control', body: {player: other.id, action: 'stop'}});
        }
    }
    try {
        for (let round = 1; round <= rounds; round++) for (const target of selected) {
            await measure(target, round, 'stop-fixture', () => control({action: 'stop'}));
            const applied = await measure(target, round, 'target', () => control({action: 'setTarget', value: target.id}),
                r => assert.equal(r.player?.currentTarget?.id, target.id));
            if (!applied) continue;
            await measure(target, round, 'folder-play', () => control({
                action: 'playFrom', item: '22$@10789', folder: '22$12019', offset: 0, size: 50, path: musicPath
            }), r => assert(r.player?.playing, 'UMP did not confirm playing'));
            await delay(600);
            await measure(target, round, 'native-state', () => state(target.id), r => assert(r.player?.playing, 'Renderer did not confirm playing'));
            await measure(target, round, 'native-source-queue', () => app.post({
                path: '/widget/media/api/playlist', body: {speaker: target.id, offset: 0, size: 50}
            }), r => assert.equal(r.items?.length, 14));
            await measure(target, round, 'UMP-queue', () => app.post({path: '/widget/media/api/playlist', body: {player, offset: 0, size: 50}}),
                r => assert(r.items?.length > 1));
            await measure(target, round, 'volume', () => control({action: 'volume', value: 0.08}));
            await measure(target, round, 'native-volume', () => app.post({
                path: '/widget/media/api/control', body: {speaker: target.id, action: 'volume', value: 0.09}
            }), r => assert.equal(r.player?.volume, 0.09));
            for (const [action, value] of [['volumeUp', 0.10], ['volumeDown', 0.09]]) {
                await measure(target, round, `native-${action}`, () => app.post({
                    path: '/widget/media/api/control', body: {speaker: target.id, action, step: 1}
                }), r => assert(Math.abs(r.player.volume - value) < 0.001));
            }
            for (const value of [true, false]) {
                await measure(target, round, value ? 'native-mute' : 'native-unmute', () => app.post({
                    path: '/widget/media/api/control', body: {speaker: target.id, action: 'mute', value}
                }), r => assert.equal(r.player?.muted, value));
            }
            await measure(target, round, 'pause', () => control({action: 'pause'}), r => assert(r.player?.paused));
            await measure(target, round, 'resume', () => control({action: 'play'}), r => assert(r.player?.playing));
            for (const value of [true, false]) {
                await measure(target, round, value ? 'shuffle-on' : 'shuffle-off', () => control({action: 'shuffle', value}),
                    r => assert.equal(r.player?.shuffle, value));
            }
            for (const value of ['playlist', 'none']) {
                await measure(target, round, `repeat-${value}`, () => control({action: 'repeat', value}),
                    r => assert.equal(r.player?.repeat, value));
            }
            await measure(target, round, 'next', () => control({action: 'next'}));
            await measure(target, round, 'previous', () => control({action: 'previous'}));
            await measure(target, round, 'native-source-queue-play', () => app.post({
                path: '/widget/media/api/control', body: {speaker: target.id, action: 'playQueueItem', number: 2, item: '22$@10790'}
            }), r => assert(r.player?.playing));
            await measure(target, round, 'stop', () => control({action: 'stop'}));
            await measure(target, round, 'stopped-state', () => state(target.id), r => assert(!r.player?.playing, 'Renderer is still playing'));
            await measure(target, round, 'single-file', () => control({
                action: 'playFile', item: '22$@10789', folder: '22$12019', offset: 0, size: 50, path: musicPath
            }), r => assert(r.player?.playing));
            await measure(target, round, 'single-stop', () => control({action: 'stop'}));
            if (video && target.name !== 'Tuin') {
                const started = await measure(target, round, 'video-play', () => control({
                    action: 'playFile', item: video.item, folder: video.folder, path: video.path, offset: 0, size: 25
                }), r => assert(r.player?.playing, 'UMP did not confirm video playback'));
                if (started) {
                    await delay(2500);
                    await measure(target, round, 'video-native-state', () => state(target.id),
                        r => {
                            assert(r.player?.playing, 'Renderer did not retain video playback');
                            assert(r.player.position > 0, 'Renderer did not report advancing video position');
                        });
                    await measure(target, round, 'video-pause', () => control({action: 'pause'}), r => assert(r.player?.paused));
                    await measure(target, round, 'video-resume', () => control({action: 'play'}), r => assert(r.player?.playing));
                }
                await measure(target, round, 'video-stop', () => control({action: 'stop'}));
                await measure(target, round, 'video-stopped-state', () => state(target.id), r => assert(!r.player?.playing));
            }
        }
    } finally {
        await control({action: 'stop'});
        await control({action: 'shuffle', value: before.player.shuffle});
        await control({action: 'repeat', value: before.player.repeat});
        await control({action: 'setTarget', value: savedTarget?.id ?? null});
        for (const target of selected) {
            const original = baseline.get(target.id);
            if (original?.actions?.volume && Number.isFinite(original.volume)) {
                await measure(target, 0, 'restore-volume', () => app.post({
                    path: '/widget/media/api/control', body: {speaker: target.id, action: 'volume', value: original.volume}
                }));
            }
            if (typeof original?.muted === 'boolean') {
                await measure(target, 0, 'restore-mute', () => app.post({
                    path: '/widget/media/api/control', body: {speaker: target.id, action: 'mute', value: original.muted}
                }));
            }
        }
    }
    console.log(JSON.stringify({rounds, failures}));
    return failures;
})().then(failures => process.exit(failures ? 1 : 0), error => { console.error(error.message); process.exit(1); });
