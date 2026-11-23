'use strict';

const ORDER = ['speaker_playing', 'speaker_prev', 'speaker_stop', 'speaker_next', 'speaker_shuffle', 'speaker_repeat',
    'speaker_track', 'speaker_artist', 'speaker_album', 'speaker_position', 'speaker_duration',
    'volume_set', 'volume_up', 'volume_down', 'volume_mute'];
const BASE = new Set(['speaker_playing', 'speaker_stop', 'speaker_track', 'speaker_artist', 'speaker_album',
    'speaker_position', 'speaker_duration']);
const FEATURES = {
    speaker_prev: 'navigate', speaker_next: 'navigate', speaker_shuffle: 'shuffle', speaker_repeat: 'repeat',
    volume_set: 'volume', volume_up: 'volume', volume_down: 'volume', volume_mute: 'mute'
};

// Support is remembered once observed, so capabilities don't flicker when a speaker is idle.
function features(protocol, state, known = {}) {
    const found = {...known};
    if (protocol === 'sonos') found.navigate = found.shuffle = found.repeat = true;
    if (protocol === 'cast') found.navigate = true;
    if (state) {
        const actions = state.actions || {};
        if (state.volume != null) found.volume = true;
        if (state.muted != null) found.mute = true;
        if (actions.next || actions.previous) found.navigate = true;
        if (actions.shuffle) found.shuffle = true;
        if (actions.repeat) found.repeat = true;
    }
    return found;
}

function capabilities(found) {
    return ORDER.filter(capability => BASE.has(capability) || found[FEATURES[capability]]);
}

function seconds(ms) {
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

function values(state) {
    return {
        speaker_playing: Boolean(state.playing),
        speaker_track: state.track || '',
        speaker_artist: state.artist || '',
        speaker_album: state.album || '',
        speaker_position: seconds(state.position),
        speaker_duration: seconds(state.duration),
        speaker_shuffle: Boolean(state.shuffle),
        speaker_repeat: ['none', 'track', 'playlist'].includes(state.repeat) ? state.repeat : 'none',
        volume_set: Number.isFinite(state.volume) ? Math.round(state.volume * 100) / 100 : null,
        volume_mute: typeof state.muted === 'boolean' ? state.muted : null
    };
}

module.exports = {ORDER, features, capabilities, values};
