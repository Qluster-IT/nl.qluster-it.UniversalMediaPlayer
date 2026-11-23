'use strict';

const {isSavedGroup} = require('./speaker-groups');

const READY_MS = 45000;
const POLL_MS = 3000;

function powerDevices(homey) {
    try {
        return homey.drivers.getDriver('playbackdevice').getDevices()
            .filter(device => device.speakerId && device.hasCapability('onoff') && typeof device.autoPowerOn === 'function');
    } catch {
        return [];
    }
}

// Announcements only: a direct target uses its device setting, a saved group its per-member flag
// and All speakers the app setting. Every switch is off by default; the no-TV "all" targets never power anything.
function candidates(homey, selection) {
    const id = selection?.id;
    if (id === 'all_no_tvs' || id === 'all_no_tv_speakers') return [];
    const devices = powerDevices(homey);
    if (isSavedGroup(id)) {
        const group = homey.app.speakerPlayback?.groups?.().find(item => item.id === id);
        const members = new Set((group?.members || []).filter(member => member.autoPower === true).map(member => member.id));
        return devices.filter(device => members.has(device.speakerId));
    }
    if (id === 'all') return homey.settings.get('announcementAutoPower') === true ? devices : [];
    return devices.filter(device => device.speakerId === id && device.getSetting('auto_power') === true);
}

// A TV's renderer is discoverable some time after its screen reports on.
async function waitForSpeakers(homey, ids) {
    const playback = homey.app.speakerPlayback;
    if (!playback?.refresh) return;
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
        const speakers = await playback.refresh().catch(() => []);
        if (ids.every(id => speakers.some(speaker => speaker.id === id || speaker.aliases?.includes(id)))) return;
        await new Promise(resolve => homey.setTimeout(resolve, POLL_MS));
    }
}

// Returns the power-off step: only devices UMP switched on for this announcement are switched off again.
async function prepare(homey, selection, log = () => {}) {
    const results = await Promise.all(candidates(homey, selection).map(async device => {
        try {
            return await device.autoPowerOn() ? device : null;
        } catch (error) {
            log('Automatic power-on failed:', error.message);
            return null;
        }
    }));
    const switched = results.filter(Boolean);
    if (switched.length) await waitForSpeakers(homey, switched.map(device => device.speakerId));
    return async () => {
        await Promise.all(switched.map(device => device.autoPowerOff().catch(error =>
            log('Automatic power-off failed:', error.message))));
    };
}

module.exports = {prepare, candidates};
