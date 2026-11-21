'use strict';

const {createHash} = require('node:crypto');
const PlaylistManager = require('./playlistmanager');
const {DEFAULT_TARGET, CURRENT_TARGET} = require('../drivers/upnpplayer/playback-target');
const {controller} = require('./direct-speaker-session');
const STORE = 'widgetPlaybackContextsV1';
const contexts = new WeakMap();
const owners = new WeakMap();
const writes = new WeakMap();
const stores = new WeakMap();

function widgetKey(homey, player, widget) {
    if (typeof widget !== 'string' || !/^[\w-]{1,128}$/.test(widget)) {
        throw new Error(homey.__('widget.invalidAction'));
    }
    return `widget-target-${widget}-${player.getData().id}`;
}

function records(player) {
    if (stores.has(player)) return stores.get(player);
    const saved = player.getStoreValue(STORE);
    if (saved == null) {
        const empty = {version: 1, targets: {}};
        stores.set(player, empty);
        return empty;
    }
    if (saved.version !== 1 || !saved.targets || typeof saved.targets !== 'object' || Array.isArray(saved.targets)) {
        throw new Error('The widget playback context store is invalid.');
    }
    stores.set(player, saved);
    return saved;
}

function persist(player, saved) {
    const run = (writes.get(player) || Promise.resolve()).then(() => player.setStoreValue(STORE, saved));
    writes.set(player, run.catch(() => {}));
    return run;
}

function registry(homey) {
    if (!owners.has(homey)) owners.set(homey, new Map());
    return owners.get(homey);
}

function owned(homey, id) {
    if (typeof id !== 'string') return;
    const protocol = id.startsWith('cast:') ? 'cast' : /^dlna:uuid:rincon_/i.test(id) ? 'sonos' : 'dlna';
    const owner = controller.getOwner({id, protocol});
    const contextual = registry(homey).get(owner);
    const player = contextual || homey.drivers.getDriver('upnpplayer').getDevices()
        .find(device => device.getData().id === owner);
    if (player?.getAvailable() && player.playlistManager &&
        !player.getStoreValue('directSpeakerSessionV1')?.notification &&
        !player.playlistManager.directSession?.journal?.notification) return player;
}

async function context(player, target) {
    if (!target) return player;
    const existingOwner = owned(player.homey, target.id);
    if (existingOwner) return existingOwner;
    if (player.playlistManager.PlaybackTarget?.()?.id === target.id) return player;
    if (!contexts.has(player)) contexts.set(player, new Map());
    const cache = contexts.get(player);
    if (cache.has(target.id)) return cache.get(target.id);
    const loading = createContext(player, target);
    cache.set(target.id, loading);
    try { return await loading; }
    catch (error) {
        cache.delete(target.id);
        throw error;
    }
}

async function createContext(parent, target) {
    const saved = records(parent);
    const entry = saved.targets[target.id] ?? {target, store: {}, capabilities: {}};
    if (entry.target?.id !== target.id || !entry.store || typeof entry.store !== 'object' || Array.isArray(entry.store) ||
        !entry.capabilities || typeof entry.capabilities !== 'object' || Array.isArray(entry.capabilities)) {
        throw new Error('The saved widget playback context is invalid.');
    }
    saved.targets[target.id] = entry;
    const parentId = parent.getData().id;
    const id = `${parentId}-widget-${createHash('sha256').update(target.id).digest('hex').slice(0, 16)}`;
    const device = {
        homey: parent.homey,
        driver: parent.driver,
        widgetPlayerId: parentId,
        widgetTargetId: target.id,
        get server() { return parent.server; },
        getData: () => ({...parent.getData(), id}),
        getName: () => parent.getName(),
        getAvailable: () => parent.getAvailable(),
        getSetting: key => parent.getSetting(key),
        getCapabilityValue: key => entry.capabilities[key] ?? parent.getCapabilityValue(key),
        async setCapabilityValue(key, value) {
            entry.capabilities[key] = value;
            if (key === 'volume_set' || key === 'volume_mute') await persist(parent, saved);
        },
        getStoreValue(key) {
            if (key === DEFAULT_TARGET || key === CURRENT_TARGET) return entry.target;
            return entry.store[key];
        },
        async setStoreValue(key, value) {
            entry.store[key] = value;
            await persist(parent, saved);
        },
        setAlbumArtImage: async () => {},
        log: (...args) => parent.log(...args),
        error: (...args) => parent.error(...args)
    };
    device.playlistManager = new PlaylistManager({homey: parent.homey, uPnPPlayer: device});
    registry(parent.homey).set(id, device);
    try {
        device.playlistManager.RestorePlayback();
        await device.playlistManager.RecoverDirect();
        await persist(parent, saved);
    } catch (error) {
        await device.playlistManager.Dispose();
        registry(parent.homey).delete(id);
        throw error;
    }
    return device;
}

async function get(player, widget) {
    if (widget == null) return player;
    widgetKey(player.homey, player, widget);
    if (player.widgetPlayerId) return player;
    return context(player, selection(player, widget));
}

async function select(player, widget, target) {
    const key = widgetKey(player.homey, player, widget);
    const selected = await context(player, target || player.getStoreValue(DEFAULT_TARGET));
    await player.homey.settings.set(key, {target});
    return selected;
}

async function restore(player) {
    for (const entry of Object.values(records(player).targets)) {
        if (typeof entry?.target?.id !== 'string') throw new Error('A saved widget destination is invalid.');
        await context(player, entry.target);
    }
}

async function dispose(player) {
    const cache = contexts.get(player);
    if (!cache) return;
    for (const pending of cache.values()) {
        const device = await pending;
        await device.playlistManager.Dispose();
        registry(player.homey).delete(device.getData().id);
        controller.abandonOwnership(device.getData().id);
    }
    contexts.delete(player);
    await writes.get(player);
    stores.delete(player);
}

function preference(player, widget) {
    return widget == null ? null : player.homey.settings.get(widgetKey(player.homey, player, widget));
}

function selection(player, widget) {
    const saved = preference(player, widget);
    return saved ? saved.target || player.getStoreValue?.(DEFAULT_TARGET)
        : player.getStoreValue?.(CURRENT_TARGET) || player.getStoreValue?.(DEFAULT_TARGET);
}

async function claim(player, widget) {
    if (widget == null) return;
    widgetKey(player.homey, player, widget);
    if (player.getStoreValue('widgetPlaybackController')?.widget !== widget) {
        await player.setStoreValue('widgetPlaybackController', {widget});
    }
}

module.exports = {get, select, owned, restore, dispose, preference, selection, claim,
    byOwner: (homey, id) => registry(homey).get(id)};
