'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));
const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const widget = 'ump-switching-saved-flow';
const fixture = '68239d44-1709-4ea8-ab5f-9eb6a7e6d1d5';
const targets = [
    {id: 'dlna:uuid:66ca30fb-9c0d-4b83-98a8-1c981e8c8e68', name: 'Frame'},
    {id: 'dlna:uuid:rincon_c438750f709001400', name: 'Tuin'},
    {id: 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac', name: 'Host'}
];

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    assert.equal((await app.get({path: '/api-ready'})).ready, true);
    const saved = await api.flow.getAdvancedFlow({id: fixture});
    assert.equal(saved.cards.playFile.id, 'homey:device:ec4094de-f3a0-45de-ad75-d94f860aafb7:upnpplayer_get_file');
    assert(saved.cards.playFile.args.file && typeof saved.cards.playFile.args.file === 'object', 'Saved picker selection is required');
    for (const key of ['waitPlay', 'waitPause', 'waitResume']) {
        const {number, multiplier} = saved.cards[key].args.delay;
        assert.equal(Number(number) * multiplier, 6);
    }
    const state = () => app.get({path: '/widget/media/api/state?player=' + player});
    const command = body => app.post({path: '/widget/media/api/control', body: {player, ...body}});
    const original = (await state()).player.currentTarget?.id ?? null;
    const key = `widget-target-${widget}-${player}`;
    const preference = (await api.apps.getAppSetting({id: app.id, name: key})) ?? undefined;
    try {
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            await command({action: 'setTarget', value: target.id});
            await api.flow.triggerAdvancedFlow({id: fixture});
            await delay(5000);
            assert((await state()).player.playing, target.name + ': saved Flow did not start playback');
            await command({widget, action: 'setTarget', value: targets[(i + 1) % targets.length].id});
            const source = await app.get({path: '/widget/media/api/state?speaker=' + encodeURIComponent(target.id)});
            assert(source.player.managed && source.player.canBrowse && source.player.playing);
            await delay(6000);
            assert((await state()).player.paused, target.name + ': Flow pause lost ownership after widget switch');
            await delay(6000);
            assert((await state()).player.playing, target.name + ': Flow resume lost ownership after widget switch');
            await delay(6000);
            const stopped = (await state()).player;
            assert(!stopped.playing && !stopped.paused, target.name + ': Flow did not stop');
            console.log(JSON.stringify({target: target.name, savedPickerFlow: true, widgetSelectionPreservesFlowControl: true}));
        }
    } finally {
        await command({action: 'stop'});
        await command({action: 'setTarget', value: original});
        if (preference === undefined) await api.apps.unsetAppSetting({id: app.id, name: key});
        else await api.apps.setAppSetting({id: app.id, name: key, value: preference});
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
