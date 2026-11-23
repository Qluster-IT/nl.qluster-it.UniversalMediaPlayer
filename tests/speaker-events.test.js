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

test('an address change replaces the callback subscription and still delivers updates', {timeout: 5000}, async t => {
    let address = '127.0.0.1';
    const requests = [];
    let subscriptions = 0;
    const renderer = http.createServer((req, res) => {
        requests.push({method: req.method, sid: req.headers.sid, callback: req.headers.callback});
        if (req.method === 'SUBSCRIBE') {
            if (!req.headers.sid) subscriptions++;
            res.writeHead(200, {SID: req.headers.sid || `uuid:subscription-${subscriptions}`, TIMEOUT: 'Second-60'}).end();
        } else res.writeHead(200).end();
    });
    await new Promise(resolve => renderer.listen(0, '127.0.0.1', resolve));
    let resolveUpdate;
    const updated = new Promise(resolve => { resolveUpdate = resolve; });
    const events = new SpeakerEvents({
        cloud: {getLocalAddress: async () => address},
        app: {log: (...args) => assert.fail(args.join(' ')), error: (...args) => assert.fail(args.join(' '))},
        api: {realtime: async (name, data) => resolveUpdate([name, data.speaker])}
    });
    t.after(async () => {
        await events.close();
        await new Promise(resolve => renderer.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${renderer.address().port}/events`;
    const renew = async () => {
        events.entries.get(endpoint).retryAt = 0;
        events.watch('room', endpoint);
        await events.entries.get(endpoint).pending;
    };
    events.watch('room', endpoint);
    await events.entries.get(endpoint).pending;
    const original = requests[0].callback.slice(1, -1);
    await renew();
    assert.deepEqual(requests[1], {method: 'SUBSCRIBE', sid: 'uuid:subscription-1', callback: undefined});

    address = '127.0.0.2:80';
    await renew();
    assert.equal(requests[2].method, 'UNSUBSCRIBE');
    assert.equal(requests[2].sid, 'uuid:subscription-1');
    assert.equal(requests[3].method, 'SUBSCRIBE');
    assert.equal(requests[3].sid, undefined);
    const callback = requests[3].callback.slice(1, -1);
    assert.equal(new URL(callback).hostname, '127.0.0.2');
    assert.equal(new URL(callback).port, new URL(original).port);

    const notify = async sid => (await fetch(callback, {method: 'NOTIFY',
        headers: {SID: sid, NT: 'upnp:event', NTS: 'upnp:propchange'}})).status;
    assert.equal(await notify('uuid:subscription-1'), 412);
    const started = Date.now();
    assert.equal(await notify('uuid:subscription-2'), 200);
    assert.deepEqual(await updated, ['speaker_state_changed', 'room']);
    assert.ok(Date.now() - started < 1000, 'push update should arrive without waiting for fallback polling');
    await renew();
    assert.deepEqual(requests[4], {method: 'SUBSCRIBE', sid: 'uuid:subscription-2', callback: undefined});
});

test('a renewal the speaker no longer recognises subscribes again immediately', {timeout: 5000}, async t => {
    const requests = [];
    let known = new Set();
    const renderer = http.createServer((req, res) => {
        requests.push({sid: req.headers.sid, callback: req.headers.callback});
        if (req.headers.sid && !known.has(req.headers.sid)) return res.writeHead(412).end();
        const sid = req.headers.sid || `uuid:subscription-${requests.length}`;
        known.add(sid);
        res.writeHead(200, {SID: sid, TIMEOUT: 'Second-60'}).end();
    });
    await new Promise(resolve => renderer.listen(0, '127.0.0.1', resolve));
    const events = new SpeakerEvents({
        cloud: {getLocalAddress: async () => '127.0.0.1'},
        app: {log: (...args) => assert.fail(args.join(' ')), error: (...args) => assert.fail(args.join(' '))},
        api: {realtime: async () => {}}
    });
    t.after(async () => {
        await events.close();
        await new Promise(resolve => renderer.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${renderer.address().port}/events`;
    events.watch('room', endpoint);
    await events.entries.get(endpoint).pending;
    known = new Set();
    events.entries.get(endpoint).retryAt = 0;
    events.watch('room', endpoint);
    await events.entries.get(endpoint).pending;
    assert.equal(requests[1].sid, 'uuid:subscription-1');
    assert.equal(requests[2].sid, undefined);
    assert.equal(requests[2].callback, requests[0].callback);
    assert.equal(events.entries.get(endpoint).sid, 'uuid:subscription-3');
});
