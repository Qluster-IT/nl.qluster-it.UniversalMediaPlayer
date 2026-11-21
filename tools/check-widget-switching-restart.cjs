'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));
const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const widget = 'ump-switching-restart';
const targets = [
    {id: 'dlna:uuid:66ca30fb-9c0d-4b83-98a8-1c981e8c8e68', name: 'Frame'},
    {id: 'dlna:uuid:rincon_c438750f709001400', name: 'Tuin'},
    {id: 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac', name: 'Host'}
];
const musicPath = ['21', '22', '22$11961', '22$12011', '22$12019'].map(id => ({id, name: id}));

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    assert.equal((await app.get({path: '/api-ready'})).ready, true);
    const command = body => app.post({path: '/widget/media/api/control', body: {player, widget, ...body}});
    const state = speaker => app.get({
        path: `/widget/media/api/state?player=${player}&widget=${widget}${speaker ? '&speaker=' + encodeURIComponent(speaker) : ''}`
    });
    const key = `widget-target-${widget}-${player}`;
    const preference = (await api.apps.getAppSetting({id: app.id, name: key})) ?? undefined;
    const before = new Map();
    try {
        for (let index = 0; index < targets.length; index++) {
            const target = targets[index];
            await command({action: 'setTarget', value: target.id});
            await command({action: 'playFrom', item: index === 1 ? '22$@10790' : '22$@10789',
                folder: '22$12019', path: musicPath, offset: 0, size: 50});
        }
        await delay(3000);
        for (const target of targets) {
            const source = (await state(target.id)).player;
            assert(source.managed && source.playing && !source.locked);
            before.set(target.id, source);
        }
        await api.apps.restartApp({id: app.id});
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            await delay(1000);
            try {
                const running = await api.apps.getApp({id: app.id, $skipCache: true});
                if (!running.enabled || running.crashed) continue;
                if ((await running.get({path: '/api-ready'})).ready) { ready = true; break; }
            } catch (error) {
                if (![404, 500, 503].includes(error.statusCode)) throw error;
            }
        }
        assert(ready, 'App did not become ready after restart');
        for (const target of targets) {
            const source = (await state(target.id)).player;
            const original = before.get(target.id);
            assert(source.managed && source.playing && !source.locked, target.name + ': ownership did not recover');
            assert(source.position >= original.position, target.name + ': playback restarted');
            assert.equal(source.contextId, original.contextId);
            assert.equal(source.selection.file.id, original.selection.file.id);
            assert.equal(source.selection.path.at(-1).id, '22$12019');
            const queue = await app.post({path: '/widget/media/api/playlist',
                body: {speaker: target.id, widget, size: 50}});
            assert.equal(queue.total, 14);
            await command({action: 'setTarget', value: target.id});
            assert((await state()).player.playing);
            assert((await command({speaker: target.id, action: 'pause'})).player.paused);
            assert((await command({speaker: target.id, action: 'play'})).player.playing);
            console.log(JSON.stringify({target: target.name, queueRecovered: true, controlRecovered: true, continuousPosition: true}));
        }
    } finally {
        const errors = [];
        for (const target of targets) {
            try {
                await command({action: 'setTarget', value: target.id});
                await command({action: 'stop'});
            } catch (error) {
                console.error('Unable to stop restart test on ' + target.name + ': ' + error.message);
                errors.push(error);
            }
        }
        if (preference === undefined) await api.apps.unsetAppSetting({id: app.id, name: key});
        else await api.apps.setAppSetting({id: app.id, name: key, value: preference});
        if (errors.length) throw new AggregateError(errors, 'Restart test cleanup failed');
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
