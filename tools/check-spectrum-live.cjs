'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));
const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const widget = 'ump-spectrum-check';
const id = 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac';

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    const key = `widget-target-${widget}-${player}`;
    const preference = (await api.apps.getAppSetting({id: app.id, name: key})) ?? undefined;
    const command = body => app.post({path: '/widget/media/api/control', body: {player, widget, ...body}});
    try {
        await command({action: 'setTarget', value: id});
        await command({action: 'playFrom', item: '22$@10789', folder: '22$12019', offset: 0, size: 50,
            path: ['21', '22', '22$11961', '22$12011', '22$12019'].map(id => ({id, name: id}))});
        const state = (await app.get({path: `/widget/media/api/state?player=${player}&widget=${widget}`})).player;
        const item = state.selection.file.id;
        const started = Date.now();
        let offset = 0, chunks = 0, bytes = 0, total;
        while (offset != null) {
            const chunk = await app.post({path: '/widget/media/api/audio', body: {player, widget, item, offset}});
            total = chunk.total;
            bytes += Buffer.from(chunk.data, 'base64').length;
            chunks++;
            offset = chunk.next;
        }
        console.log(JSON.stringify({item, playing: state.playing, chunks, bytes, total, ms: Date.now() - started}));
        assert.equal(bytes, total);
        await assert.rejects(app.post({path: '/widget/media/api/audio', body: {player, widget, item: 'other', offset: 0}}));
    } finally {
        await command({action: 'stop'});
        if (preference === undefined) await api.apps.unsetAppSetting({id: app.id, name: key});
        else await api.apps.setAppSetting({id: app.id, name: key, value: preference});
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
