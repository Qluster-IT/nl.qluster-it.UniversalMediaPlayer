'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const DirectSpeakerSession = require('../lib/direct-speaker-session');
const AthomApi = require(path.join(process.env.APPDATA, 'npm', 'node_modules', 'homey', 'lib', 'AthomApi'));
const player = '533b3d17-0d76-4292-bd02-b114292b7c77';
const widget = 'ump-host-natural-end';
const id = 'dlna:uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac';
const endpoint = 'http://192.168.1.238:2869/upnphost/udhisapi.dll?control=uuid:3f42b36f-216d-4c03-9f09-3654495fe5ac+urn:upnp-org:serviceId:AVTransport';
const first = 'http://192.168.1.100:50002/m/NDLNA/10789.mp3';
const second = 'http://192.168.1.100:50002/m/NDLNA/10790.mp3';
const rounds = process.argv.includes('--rounds') ? Number(process.argv[process.argv.indexOf('--rounds') + 1]) : 1;
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);

(async () => {
    const homey = await new AthomApi().getHomey('63c568cbb329510b96d0ef7c');
    assert.equal(homey.name, 'HP2023');
    const api = await homey.authenticate({strategy: ['localSecure', 'local']});
    const app = await api.apps.getApp({id: 'nl.qluster-it.UniversalMediaPlayer'});
    assert.equal((await app.get({path: '/api-ready'})).ready, true);
    const command = body => app.post({path: '/widget/media/api/control', body: {player, widget, ...body}});
    const state = () => app.get({path: `/widget/media/api/state?player=${player}&widget=${widget}`});
    const key = `widget-target-${widget}-${player}`;
    const preference = (await api.apps.getAppSetting({id: app.id, name: key})) ?? undefined;
    const transport = DirectSpeakerSession.controller.adapter({id, protocol: 'dlna', endpoint,
        service: 'urn:schemas-upnp-org:service:AVTransport:1'});
    try {
        for (let round = 1; round <= rounds; round++) {
            await command({action: 'setTarget', value: id});
            await command({action: 'stop'});
            await command({action: 'playFrom', item: '22$@10789', folder: '22$12019', offset: 0, size: 50,
                path: ['21', '22', '22$11961', '22$12011', '22$12019'].map(id => ({id, name: id}))});
            assert.equal((await transport.read()).uri, first, 'Do not seek an unrelated source');
            await transport.seek(220000);
            const observations = [];
            for (let tick = 0; tick < 25; tick++) {
                await delay(1000);
                const native = await transport.read();
                const local = (await state()).player;
                const observation = {round, tick, state: native.state, position: native.position.RelTime,
                    duration: native.position.TrackDuration, first: native.uri === first, second: native.uri === second,
                    localPlaying: local.playing, localPaused: local.paused, interrupted: local.interrupted,
                    item: local.selection?.file?.id};
                observations.push(observation);
                if (rounds === 1) console.log(JSON.stringify(observation));
            }
            assert.equal((await transport.read()).uri, second, 'Host did not load the next queue item after EOF');
            const advanced = (await state()).player;
            if (!advanced.playing || advanced.selection?.file?.id !== '22$@10790') {
                console.error(JSON.stringify({round, observations: observations.slice(-12)}));
            }
            assert(advanced.playing && advanced.selection.file.id === '22$@10790');
            console.log(JSON.stringify({round, windowsEofAdvance: true}));
        }
    } finally {
        await command({action: 'stop'});
        if (preference === undefined) await api.apps.unsetAppSetting({id: app.id, name: key});
        else await api.apps.setAppSetting({id: app.id, name: key, value: preference});
        transport.close();
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
