'use strict';

const {randomUUID} = require('node:crypto');

const STORE_KEY = 'AnnouncementSpeakerGroups';
const GROUP_ID = /^group:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SPEAKER_ID = /^(?:cast:|dlna:uuid:)[^\s]{1,200}$/;
const MAX_GROUPS = 50;
const MAX_MEMBERS = 50;

function listGroups(settings) {
    const groups = settings.get(STORE_KEY);
    if (groups == null) return [];
    if (!Array.isArray(groups) || groups.length > MAX_GROUPS) throw new Error('Saved speaker groups are invalid.');
    const ids = new Set();
    const names = new Set();
    for (const group of groups) {
        if (!group || typeof group.id !== 'string' || !GROUP_ID.test(group.id)
            || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80
            || !Array.isArray(group.members) || !group.members.length || group.members.length > MAX_MEMBERS) {
            throw new Error('Saved speaker groups are invalid.');
        }
        const name = group.name.trim().toLowerCase();
        if (ids.has(group.id) || names.has(name)) throw new Error('Saved speaker groups are invalid.');
        ids.add(group.id);
        names.add(name);
        const members = new Set();
        for (const member of group.members) {
            if (!member || typeof member.id !== 'string' || !SPEAKER_ID.test(member.id)
                || typeof member.name !== 'string' || !member.name.trim() || members.has(member.id)
                || (member.volumeOffset !== undefined && (!Number.isInteger(member.volumeOffset)
                    || member.volumeOffset < -100 || member.volumeOffset > 100))
                || (member.maxVolume !== undefined && (!Number.isInteger(member.maxVolume)
                    || member.maxVolume < 0 || member.maxVolume > 100))) {
                throw new Error('Saved speaker groups are invalid.');
            }
            members.add(member.id);
        }
    }
    return groups;
}

function memberId(member) {
    return typeof member === 'string' ? member : member?.id;
}

function prepareGroup(settings, input, speakers) {
    const groups = listGroups(settings);
    const existing = groups.find(group => group.id === input?.id);
    if (input?.id != null && !existing) throw new Error('This speaker group no longer exists.');
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new Error('Enter a group name of 1–80 characters.');
    if (groups.some(group => group.id !== existing?.id && group.name.trim().toLowerCase() === name.toLowerCase())) {
        throw new Error('A speaker group already uses that name.');
    }
    if (!existing && groups.length >= MAX_GROUPS) throw new Error('You can save up to 50 speaker groups.');
    if (!Array.isArray(input.members) || !input.members.length || input.members.length > MAX_MEMBERS) {
        throw new Error('Select between 1 and 50 individual speakers.');
    }
    if (!Array.isArray(speakers) || speakers.some(speaker => typeof speaker?.id !== 'string'
        || typeof speaker.name !== 'string' || !speaker.name.trim())) {
        throw new Error('The speaker discovery result is invalid.');
    }
    const known = new Map([...(existing?.members || []), ...speakers].map(speaker => [speaker.id, speaker.name]));
    const members = new Map();
    for (const member of input.members) {
        const id = memberId(member);
        if (typeof id !== 'string' || !SPEAKER_ID.test(id)) {
            throw new Error('Select between 1 and 50 individual speakers.');
        }
        if (!known.has(id)) throw new Error('A selected speaker is no longer available. Refresh the speaker list.');
        if (members.has(id)) throw new Error('A speaker can only be added once.');
        const volumeOffset = typeof member === 'string' || member.volumeOffset === undefined ? 0 : member.volumeOffset;
        const maxVolume = typeof member === 'string' || member.maxVolume === undefined ? 100 : member.maxVolume;
        if (!Number.isInteger(volumeOffset) || volumeOffset < -100 || volumeOffset > 100
            || !Number.isInteger(maxVolume) || maxVolume < 0 || maxVolume > 100) {
            throw new Error('Volume adjustment must be from -100 to 100 and maximum volume from 0 to 100.');
        }
        members.set(id, {
            id, name: known.get(id),
            ...(volumeOffset === 0 ? {} : {volumeOffset}),
            ...(maxVolume === 100 ? {} : {maxVolume})
        });
    }
    const group = {id: existing?.id || `group:${randomUUID()}`, name, members: [...members.values()]};
    return {group, groups: existing ? groups.map(item => item === existing ? group : item) : [...groups, group]};
}

class SpeakerGroups {
    constructor(settings, discover) {
        this.settings = settings;
        this.discover = discover;
        this.pending = Promise.resolve();
    }

    list() {
        return listGroups(this.settings);
    }

    save(input) {
        return this.write(async () => {
            const existing = this.list().find(group => group.id === input?.id);
            const oldIds = new Set((existing?.members || []).map(member => member.id));
            const needsDiscovery = Array.isArray(input?.members) && input.members.some(member => !oldIds.has(memberId(member)));
            const speakers = needsDiscovery ? await this.discover() : [];
            const {group, groups} = prepareGroup(this.settings, input, speakers);
            await this.settings.set(STORE_KEY, groups);
            return group;
        });
    }

    remove(id) {
        return this.write(async () => {
            const groups = this.list();
            const next = groups.filter(group => group.id !== id);
            if (next.length === groups.length) throw new Error('This speaker group no longer exists.');
            await this.settings.set(STORE_KEY, next);
            return next;
        });
    }

    write(operation) {
        const previous = this.pending;
        let release;
        this.pending = new Promise(resolve => { release = resolve; });
        const result = previous.then(operation).finally(release);
        return result;
    }
}

function memberVolume(volume, member) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('Volume must be from 0 to 100.');
    const offset = member.volumeOffset === undefined ? 0 : member.volumeOffset;
    const maximum = member.maxVolume === undefined ? 100 : member.maxVolume;
    if (!Number.isInteger(offset) || offset < -100 || offset > 100
        || !Number.isInteger(maximum) || maximum < 0 || maximum > 100) {
        throw new Error('Volume adjustment must be from -100 to 100 and maximum volume from 0 to 100.');
    }
    return volume === 0 ? 0 : Math.min(maximum, Math.max(0, volume + offset));
}

module.exports = {SpeakerGroups, memberVolume, isSavedGroup: id => typeof id === 'string' && GROUP_ID.test(id)};
