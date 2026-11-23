'use strict';

const LINE_IN_MODELS = /^(?:Sonos\s+)?(?:Play:5|Five|Connect(?::Amp)?|Amp|Port|ZP(?:80|90|100|120))$/i;
const SAMSUNG_KEYS = {tv: 'KEY_TV', hdmi_1: 'KEY_HDMI1', hdmi_2: 'KEY_HDMI2', hdmi_3: 'KEY_HDMI3', hdmi_4: 'KEY_HDMI4'};

const rincon = room => String(room?.id ?? '').replace(/^dlna:uuid:/i, '').toUpperCase();

// Inputs a speaker can switch to. Line-in support is also remembered once the speaker was seen playing its own line-in.
function sonosInputs(room, known = {}) {
    if (room?.protocol !== 'sonos') return [];
    const inputs = [];
    if (room.kind === 'tvSpeaker') inputs.push('tv');
    if (LINE_IN_MODELS.test(String(room.model || '').trim()) || known.lineIn) inputs.push('line_in');
    if (inputs.length) inputs.push('queue');
    return inputs;
}

function samsungInputs(room) {
    return room?.kind === 'tv' && room.samsung ? Object.keys(SAMSUNG_KEYS) : [];
}

function sonosCurrent(room, uri) {
    const id = rincon(room);
    if (typeof uri !== 'string' || !id) return null;
    if (uri.toUpperCase().startsWith(`X-SONOS-HTASTREAM:${id}:`)) return 'tv';
    if (uri.toUpperCase() === `X-RINCON-STREAM:${id}`) return 'line_in';
    if (/^x-rincon-queue:/i.test(uri)) return 'queue';
    return null;
}

// TV audio plays from the soundbar itself; a line-in can be played by the room's whole group.
function sonosUri(room, input) {
    const id = rincon(room);
    return {tv: `x-sonos-htastream:${id}:spdif`, line_in: `x-rincon-stream:${id}`, queue: `x-rincon-queue:${id}#0`}[input];
}

function titles(homey, inputs, samsung = false) {
    return inputs.map(id => ({id, title: homey.__(`speakerDevice.inputs.${samsung && id === 'tv' ? 'samsung_tv' : id}`)}));
}

module.exports = {SAMSUNG_KEYS, rincon, sonosInputs, samsungInputs, sonosCurrent, sonosUri, titles};
