'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));

const widget = 'ump-renderer-switching';
const observer = 'ump-renderer-observer';
const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const targets = [
    {id: 'dlna:uuid:66ca30fb-9c0d-4b83-98a8-1c981e8c8e68', name: '[TV] The Frame'},
    {id: 'dlna:uuid:rincon_c438750f709001400', name: 'Tuin'},
    {id: 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac', name: 'QlusterIT-Host'}
];
const musicPath = [
    {id: '21', name: 'Muziek'}, {id: '22', name: 'Op map'}, {id: '22$11961', name: 'Onze muziek'},
    {id: '22$12011', name: 'Acda en de Munnik'}, {id: '22$12019', name: 'Acda & de Munnik - Naar huis'}
];
const rounds = process.argv.includes('--rounds') ? Number(process.argv[process.argv.indexOf('--rounds') + 1]) : 1;
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    assert.equal((await app.get({path: '/api-ready'})).ready, true);
    const state = (speaker, instance = widget) => app.get({
        path: `/widget/media/api/state?player=${player}&widget=${instance}${speaker ? '&speaker=' + encodeURIComponent(speaker) : ''}`
    });
    const control = body => app.post({path: '/widget/media/api/control', body: {player, widget, ...body}});
    const load = (action, item = '22$@10789') => control({
        action, item, folder: '22$12019', path: musicPath, offset: 0, size: 50
    });
    const baseline = new Map();
    for (const target of targets) {
        const native = (await state(target.id)).player;
        assert(native && !native.locked, `${target.name} is unavailable or owned by another active job`);
        if (target.name === 'Tuin') assert((native.roomCount || 1) === 1, 'Tuin is grouped with another room');
        baseline.set(target.id, native);
    }
    if (!process.argv.includes('--run')) {
        console.log('Ready for explicitly authorized switching tests on Frame, Tuin and Host; use --run.');
        return;
    }
    const preferenceKeys = [widget, observer].flatMap(instance =>
        [`widget-target-${instance}-${player}`, `widget-source-${instance}`]);
    const preferences = new Map();
    for (const name of preferenceKeys) {
        try { preferences.set(name, (await api.apps.getAppSetting({id: app.id, name})) ?? undefined); }
        catch (error) {
            if (error.statusCode !== 404) throw error;
            preferences.set(name, undefined);
        }
    }
    let failures = 0;
    let checks = 0;
    async function check(target, round, operation, work) {
        const started = Date.now();
        try {
            await work();
            checks++;
            console.log(JSON.stringify({target: target.name, round, operation, ok: true, ms: Date.now() - started}));
        } catch (error) {
            failures++;
            console.log(JSON.stringify({target: target.name, round, operation, ok: false, error: error.message}));
            if (/too many requests/i.test(error.message)) {
                await delay(60000);
                throw error;
            }
        } finally { await delay(200); }
    }
    try {
        for (let round = 1; round <= rounds; round++) for (let index = 0; index < targets.length; index++) {
            const target = targets[index];
            const other = targets[(index + 1) % targets.length];
            await check(target, round, 'start-own-queue', async () => {
                await control({action: 'setTarget', value: target.id});
                await control({action: 'stop'});
                assert((await load('playFrom')).player.playing);
            });
            await delay(1300);
            const before = (await state(target.id)).player;
            const otherBefore = (await state(other.id)).player;
            await check(target, round, 'select-only-preserves-both-devices', async () => {
                assert.equal((await control({action: 'setTarget', value: other.id})).player.currentTarget.id, other.id);
                await delay(1300);
                const remaining = (await state(target.id)).player;
                assert(remaining.playing);
                assert(remaining.position >= before.position, 'Switch reset the current position');
                assert.equal((await state(other.id)).player.playing, otherBefore.playing, 'Selection changed the other device playback');
            });
            await check(target, round, 'source-owner-and-library', async () => {
                await control({action: 'saveSourcePreference', source: {kind: 'speaker', id: target.id}});
                const source = (await state(target.id)).player;
                assert(source.managed && !source.locked && source.canBrowse);
                assert.equal(source.ownerWidget, widget);
                assert.equal(source.selection.path.at(-1).id, '22$12019');
                const queue = await app.post({path: '/widget/media/api/playlist', body: {speaker: target.id, widget, size: 50}});
                assert.equal(queue.total, 14);
                const library = await app.post({path: '/widget/media/api/browse', body: {
                    speaker: target.id, widget, folder: '22$12019', offset: 0, size: 50
                }});
                assert.equal(library.items.length, 14);
                const rooms = await control({speaker: target.id, action: 'listRooms'});
                assert(Array.isArray(rooms.rooms));
                assert.equal(rooms.roomCount, target.name === 'Tuin' ? 1 : 0);
            });
            await check(target, round, 'second-widget-can-control-owner-without-changing-target', async () => {
                await control({widget: observer, action: 'setTarget', value: target.id});
                assert.equal((await state(undefined, observer)).player.currentTarget.id, target.id);
                assert.equal((await state()).player.currentTarget.id, other.id);
                assert((await control({widget: observer, speaker: target.id, action: 'pause'})).player.paused);
                assert((await control({widget: observer, speaker: target.id, action: 'play'})).player.playing);
            });
            await check(target, round, 'source-queue-control', async () => {
                assert((await control({speaker: target.id, action: 'next'})).player.playing);
                const queue = await app.post({path: '/widget/media/api/playlist', body: {speaker: target.id, widget, size: 50}});
                assert.equal(queue.currentNumber, 2);
            });
            await check(target, round, 'source-volume-updates-owning-context', async () => {
                const source = (await state(target.id)).player;
                const level = Math.min(0.9, source.volume + 0.01);
                const changed = (await control({speaker: target.id, action: 'volume', value: level})).player;
                assert(!changed.controlRejected && Math.abs(changed.volume - level) < 0.011);
                const original = baseline.get(target.id).volume;
                await control({speaker: target.id, action: 'volume', value: original});
            });
            await check(target, round, 'play-other-device-and-return-with-original-queue', async () => {
                assert((await load('playFrom', '22$@10789')).player.playing);
                const selected = (await control({action: 'setTarget', value: target.id})).player;
                assert(selected.playing && selected.canNavigate);
                assert.equal(selected.selection.file.id, '22$@10790');
                assert((await state(other.id)).player.playing);
                await control({action: 'saveSourcePreference', source: {kind: 'player', id: player}});
                assert((await control({action: 'pause'})).player.paused);
                assert((await control({action: 'play'})).player.playing);
            });
            await check(target, round, 'single-track-continues-after-switch', async () => {
                await control({action: 'stop'});
                assert((await load('playFile')).player.playing);
                await delay(1300);
                const beforeSingle = (await state(target.id)).player;
                await control({action: 'setTarget', value: other.id});
                await delay(1300);
                const single = (await state(target.id)).player;
                assert(single.playing && single.position >= beforeSingle.position);
                const returned = (await control({action: 'setTarget', value: target.id})).player;
                assert(returned.playing && !returned.canNavigate);
                assert.equal(returned.selection.file.id, '22$@10789');
                await control({action: 'stop'});
                await control({speaker: other.id, action: 'stop'});
            });
        }
        if (process.argv.includes('--natural-end')) {
            for (const action of ['playFile', 'playFrom']) {
                for (const target of targets) {
                    await control({action: 'setTarget', value: target.id});
                    await control({action: 'stop'});
                    const started = (await load(action)).player;
                    assert(started.playing && started.duration === 226000, 'Natural-end fixture changed');
                }
                await delay(160000);
                for (const target of targets) {
                    const running = (await state(target.id)).player;
                    assert(running.playing && running.position >= 120000, target.name + ': playback stopped early while deselected');
                }
                await delay(70000);
                for (const target of targets) await check(target, 0, action === 'playFile'
                    ? 'complete-single-track-while-deselected' : 'natural-queue-advance-while-deselected', async () => {
                    const selected = (await control({action: 'setTarget', value: target.id})).player;
                    const native = (await state(target.id)).player;
                    if (action === 'playFile') {
                        assert(!selected.playing && !selected.paused && !native.playing, 'Single track did not finish');
                    } else {
                        assert(selected.playing && native.playing, 'Independent queue stopped instead of advancing');
                        assert.equal(selected.selection.file.id, '22$@10790');
                        const queue = await app.post({path: '/widget/media/api/playlist',
                            body: {speaker: target.id, widget, size: 50}});
                        assert.equal(queue.currentNumber, 2);
                    }
                });
            }
        }
    } finally {
        const cleanupErrors = [];
        for (const target of targets) {
            try {
                await control({action: 'setTarget', value: target.id});
                await control({action: 'stop'});
                const original = baseline.get(target.id);
                if (Number.isFinite(original.volume)) await control({action: 'volume', value: original.volume});
                if (typeof original.muted === 'boolean') await control({action: 'mute', value: original.muted});
            } catch (error) {
                console.error('Unable to clean up switching test on ' + target.name + ': ' + error.message);
                cleanupErrors.push(error);
            }
        }
        for (const [name, value] of preferences) {
            try {
                if (value === undefined) await api.apps.unsetAppSetting({id: app.id, name});
                else await api.apps.setAppSetting({id: app.id, name, value});
            } catch (error) {
                console.error('Unable to restore switching test preference: ' + error.message);
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Switching test cleanup failed');
    }
    console.log(JSON.stringify({rounds, checks, failures}));
    process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
