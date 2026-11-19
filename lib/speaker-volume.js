'use strict';

const {notifyWidget} = require('./widget-updates');
const isVolume = value => Number.isFinite(value) && value >= 0 && value <= 1;
const VOLUME_STEP = 5;

async function requestVolume(player, capability, value) {
    const volume = capability === 'volume_set';
    const valid = volume ? isVolume(value) : capability === 'volume_mute' && typeof value === 'boolean';
    if (!valid) throw new Error(player.homey.__('widget.invalidAction'));

    await player.setCapabilityValue(capability, value);
    notifyWidget(player);
    if (!volume) await player.driver.Triggers.mute_requested.Card.trigger(player, {muted: value});
}

async function stepVolume(player, direction, step = VOLUME_STEP) {
    if (!Number.isFinite(step) || step < 1 || step > 100) {
        throw new Error(player.homey.__('widget.invalidAction'));
    }
    const current = player.getCapabilityValue('volume_set');
    if (!isVolume(current)) throw new Error(player.homey.__('playback.volumeUnknown'));

    const percent = current * 100 + direction * step;
    const next = Math.round(Math.max(0, Math.min(100, percent)) * 100) / 10000;
    if (next !== current) await requestVolume(player, 'volume_set', next);
}

async function reportVolume(player, {volume, muted}) {
    const hasVolume = volume != null && volume !== '';
    const hasMute = muted != null && muted !== '';
    // Flow text fields can supply Boolean tags as strings.
    if (muted === 'true' || muted === 'false') muted = muted === 'true';
    if ((!hasVolume && !hasMute) || (hasVolume && !isVolume(volume))
        || (hasMute && typeof muted !== 'boolean')) {
        throw new Error(player.homey.__('widget.invalidAction'));
    }

    let changed = false;
    try {
        if (hasVolume && player.getCapabilityValue('volume_set') !== volume) {
            await player.setCapabilityValue('volume_set', volume);
            changed = true;
        }
        if (hasMute && player.getCapabilityValue('volume_mute') !== muted) {
            await player.setCapabilityValue('volume_mute', muted);
            changed = true;
        }
    } finally {
        if (changed) notifyWidget(player);
    }
}

module.exports = {requestVolume, reportVolume, stepVolume};
