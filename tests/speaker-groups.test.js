'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {SpeakerGroups, memberVolume, isSavedGroup} = require('../lib/speaker-groups');

function fixture() {
    let stored;
    let scans = 0;
    const speakers = [{id: 'cast:first', name: 'First'}, {id: 'dlna:uuid:second', name: 'Second'}];
    const settings = {
        get: () => stored,
        set: async (_, value) => { stored = structuredClone(value); }
    };
    const groups = new SpeakerGroups(settings, async () => { scans++; return speakers; });
    return {groups, speakers, scans: () => scans, setStored: value => {stored = value;}};
}

test('speaker groups persist member volume rules and preserve offline members on edit', async () => {
    const {groups, scans, speakers} = fixture();
    const saved = await groups.save({name: ' Living room ', members: [
        {id: 'cast:first', volumeOffset: -10, maxVolume: 0}, 'dlna:uuid:second'
    ]});
    assert(isSavedGroup(saved.id));
    assert.equal(saved.name, 'Living room');
    assert.deepEqual(saved.members, [
        {id: 'cast:first', name: 'First', volumeOffset: -10, maxVolume: 0},
        {id: 'dlna:uuid:second', name: 'Second'}
    ]);
    assert.equal(scans(), 1);
    speakers.length = 0;
    await groups.save({...saved, name: 'Evening'});
    assert.equal(scans(), 1);
    assert.equal(groups.list()[0].members[0].name, 'First');
    await groups.remove(saved.id);
    assert.deepEqual(groups.list(), []);
});

test('group validation rejects duplicate names, unknown speakers, groups and invalid volume rules', async () => {
    const {groups} = fixture();
    const original = await groups.save({name: 'Kitchen', members: ['cast:first']});
    await assert.rejects(groups.save({name: ' kitchen ', members: ['cast:first']}), /already uses/);
    await assert.rejects(groups.save({name: 'Other', members: ['cast:unknown']}), /no longer available/);
    await assert.rejects(groups.save({name: 'Other', members: ['all']}), /individual speakers/);
    await assert.rejects(groups.save({name: 'Other', members: [original.id]}), /individual speakers/);
    await assert.rejects(groups.save({name: 'Other', members: ['cast:first', 'cast:first']}), /only be added once/);
    for (const member of [{id: 'cast:first', volumeOffset: -101}, {id: 'cast:first', maxVolume: 101},
        {id: 'cast:first', maxVolume: null}]) {
        await assert.rejects(groups.save({name: 'Other', members: [member]}), /Volume adjustment/);
    }
    assert.deepEqual(groups.list(), [original]);
});

test('speaker volume respects adjustments, maximum and explicit silence', () => {
    assert.equal(memberVolume(50, {volumeOffset: 20, maxVolume: 60}), 60);
    assert.equal(memberVolume(5, {volumeOffset: -10}), 0);
    assert.equal(memberVolume(0, {volumeOffset: 20}), 0);
    assert.equal(memberVolume(50, {maxVolume: 0}), 0);
    assert.throws(() => memberVolume(101, {}), /Volume must/);
});

test('concurrent group writes are serialized and a failed write does not block later changes', async () => {
    const {groups} = fixture();
    const first = groups.save({name: 'One', members: ['cast:first']});
    const second = groups.save({name: 'Two', members: ['dlna:uuid:second']});
    await Promise.all([first, second]);
    assert.deepEqual(groups.list().map(group => group.name), ['One', 'Two']);
    await assert.rejects(groups.remove('group:missing'), /no longer exists/);
    await groups.save({name: 'Three', members: ['cast:first']});
    assert.equal(groups.list().length, 3);
});

test('invalid saved group storage is reported rather than silently discarded', async () => {
    const {groups, setStored} = fixture();
    const valid = {id: 'group:00000000-0000-0000-0000-000000000000', name: 'Room',
        members: [{id: 'cast:first', name: 'First'}]};
    for (const invalid of [
        {unexpected: true},
        [null],
        [{...valid, name: null}],
        [{...valid, members: [{id: 'cast:first', name: 'First', maxVolume: 101}]}],
        [{...valid, members: [valid.members[0], valid.members[0]]}],
        [valid, {...valid, id: 'group:00000001-0000-0000-0000-000000000000', name: ' room '}]
    ]) {
        setStored(invalid);
        assert.throws(() => groups.list(), /invalid/);
        await assert.rejects(groups.save({name: 'Other', members: ['cast:first']}), /invalid/);
        await assert.rejects(groups.remove(valid.id), /invalid/);
    }
});

test('group limits and failed discovery leave stored groups unchanged', async () => {
    let stored = [];
    const groups = new SpeakerGroups({
        get: () => stored,
        set: async (_, value) => { stored = value; }
    }, async () => { throw new Error('Discovery failed'); });
    await assert.rejects(groups.save({name: 'Room', members: ['cast:first']}), /Discovery failed/);
    assert.deepEqual(stored, []);
    stored = Array.from({length: 50}, (_, index) => ({
        id: `group:${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`,
        name: `Room ${index}`, members: [{id: 'cast:first', name: 'First'}]
    }));
    await assert.rejects(groups.save({name: 'Room 51', members: []}), /up to 50/);
    assert.equal(stored.length, 50);
});
