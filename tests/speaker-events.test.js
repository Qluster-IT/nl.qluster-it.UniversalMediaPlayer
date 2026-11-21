'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fetch = require('node-fetch');
const SpeakerEvents = require('../lib/speaker-events');

test('one UPnP subscription refreshes each watched room and unsubscribes on close', async t => {
    let resolveSubscription;
    const subscription = new Promise(resolve => { resolveSubscription = resolve; });
    const sid = 'uuid:mock-speaker';
    let subscriptions = 0;
    let unsubscribed;
    const renderer = http.createServer((req, res) => {
        if (req.method === 'SUBSCRIBE') {
            subscriptions++;
            res.writeHead(200, {SID: sid, TIMEOUT: 'Second-60'}).end();
            resolveSubscription(req.headers.callback.slice(1, -1));
        } else {
            if (req.method === 'UNSUBSCRIBE') unsubscribed = req.headers.sid;
            res.writeHead(200).end();
        }
    });
    await new Promise(resolve => renderer.listen(0, '127.0.0.1', resolve));
    const updates = [];
    let resolveUpdates;
    const received = new Promise(resolve => { resolveUpdates = resolve; });
    const events = new SpeakerEvents({
        cloud: {getLocalAddress: async () => '127.0.0.1'},
        app: {log: (...args) => assert.fail(args.join(' ')), error: (...args) => assert.fail(args.join(' '))},
        api: {realtime: async (name, data) => {
            updates.push([name, data.speaker]);
            if (updates.length === 2) resolveUpdates();
        }}
    });
    t.after(async () => {
        await events.close();
        await new Promise(resolve => renderer.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${renderer.address().port}/events`;
    events.watch('coordinator', endpoint);
    events.watch('member', endpoint);
    const callback = await subscription;
    await events.entries.get(endpoint).pending;
    const notify = async id => (await fetch(callback, {method: 'NOTIFY',
        headers: {SID: id, NT: 'upnp:event', NTS: 'upnp:propchange'}})).status;
    assert.equal(await notify('uuid:wrong'), 412);
    assert.equal(await notify(sid), 200);
    assert.equal(await notify(sid), 200);
    await received;
    assert.equal(subscriptions, 1);
    assert.deepEqual(updates, [['speaker_state_changed', 'coordinator'], ['speaker_state_changed', 'member']]);
    await events.close();
    assert.equal(unsubscribed, sid);
});
