'use strict';

const {notifyWidget} = require('../../lib/widget-updates');

const DEFAULT_TARGET = 'announcement_speaker';
const CURRENT_TARGET = 'ump_current_speaker';
const pending = new WeakMap();

function updateTarget(device, update) {
    const result = (pending.get(device) || Promise.resolve()).then(update);
    const tail = result.catch(() => {});
    pending.set(device, tail);
    return result.finally(() => {
        if (pending.get(device) === tail) pending.delete(device);
    });
}

async function listTargets(homey, fresh = false, wait = false) {
    const playback = homey.app.speakerPlayback;
    if (typeof playback?.autocomplete !== 'function') throw new Error(homey.__('targets.unavailable'));
    return wait ? playback.autocomplete('', fresh, true) : playback.autocomplete('', fresh);
}

async function validateTarget(homey, id, previous) {
    if (id === null) return null;
    if (typeof id !== 'string' || !id || id.length > 1024) throw new Error(homey.__('targets.invalid'));
    if (previous?.id === id) return previous;
    const selection = (await listTargets(homey)).find(item => item.id === id)
        || (await listTargets(homey, true)).find(item => item.id === id);
    if (!selection) throw new Error(homey.__('targets.invalid'));
    return selection;
}

async function applyTarget(device, selection) {
    const manager = device.playlistManager;
    if (typeof manager?.setPlaybackTarget === 'function') {
        if (await manager.setPlaybackTarget(selection) !== false) return;
    } else if (!manager?.playing && !manager?.paused) {
        return;
    }
    throw new Error(device.homey.__('targets.apply_failed'));
}

async function saveTarget(device, key, selection, previous, apply) {
    if (selection === previous) return;
    await device.setStoreValue(key, selection);
    try {
        if (apply) await applyTarget(device, key === CURRENT_TARGET ? selection : null);
    } catch (error) {
        try {
            await device.setStoreValue(key, previous);
        } catch (rollbackError) {
            device.error('Unable to roll back playback target:', rollbackError);
        }
        throw error;
    }
    notifyWidget(device);
}

module.exports = {DEFAULT_TARGET, CURRENT_TARGET, updateTarget, listTargets, validateTarget, saveTarget};
