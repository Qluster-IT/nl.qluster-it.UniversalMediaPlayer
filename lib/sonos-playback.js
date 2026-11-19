'use strict';

const {isIPv4} = require('node:net');
const fetch = require('node-fetch');
const {parseStringPromise, processors} = require('xml2js');

const XML_OPTIONS = {explicitArray: false, tagNameProcessors: [processors.stripPrefix]};

function validateAddress(address) {
    if (typeof address !== 'string' || !isIPv4(address)) throw new Error('Enter the Sonos speaker IPv4 address.');
    const [a, b] = address.split('.').map(Number);
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
        throw new Error('The Sonos speaker must have a private local IPv4 address.');
    }
}

async function soap(address, service, action, args = '', request = fetch) {
    const response = await request(`http://${address}:1400/${service === 'AVTransport' ? 'MediaRenderer/AVTransport' : service}/Control`, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`
        },
        body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${args}</u:${action}></s:Body></s:Envelope>`,
        timeout: 5000,
        size: 262144,
        redirect: 'error'
    });
    if (!response.ok) throw new Error(`Sonos ${action} failed (${response.status}).`);
    const xml = await parseStringPromise(await response.text(), XML_OPTIONS);
    const result = xml?.Envelope?.Body?.[`${action}Response`];
    if (!result) throw new Error(`Invalid Sonos ${action} response.`);
    return result;
}

async function readPlayback(address, request = fetch, visited = new Set()) {
    validateAddress(address);
    if (visited.has(address) || visited.size >= 3) throw new Error('Unable to resolve the Sonos group coordinator.');
    visited.add(address);
    const [position, transport] = await Promise.all([
        soap(address, 'AVTransport', 'GetPositionInfo', '<InstanceID>0</InstanceID>', request),
        soap(address, 'AVTransport', 'GetTransportInfo', '<InstanceID>0</InstanceID>', request)
    ]);
    if (typeof position.TrackURI !== 'string' || typeof transport.CurrentTransportState !== 'string') {
        throw new Error('The Sonos playback response is incomplete.');
    }
    if (position.TrackURI.startsWith('x-rincon:')) {
        const topology = await soap(address, 'ZoneGroupTopology', 'GetZoneGroupState', '', request);
        const state = await parseStringPromise(topology.ZoneGroupState, XML_OPTIONS);
        const groups = state.ZoneGroups?.ZoneGroup || state.ZoneGroupState?.ZoneGroups?.ZoneGroup;
        const coordinator = position.TrackURI.slice('x-rincon:'.length);
        const members = [groups].flat().filter(Boolean).flatMap(group => [group.ZoneGroupMember].flat()).filter(Boolean);
        const member = members.find(member => member.$?.UUID === coordinator);
        if (!member?.$?.Location) throw new Error('The Sonos group coordinator is unavailable.');
        const location = new URL(member.$.Location);
        if (location.protocol !== 'http:' || location.port !== '1400' || location.username || location.password) {
            throw new Error('Invalid Sonos coordinator address.');
        }
        return readPlayback(location.hostname, request, visited);
    }
    const url = position.TrackURI.replace(/^x-rincon-mp3radio:\/\/(?=https?:\/\/)/, '');
    return {url, state: transport.CurrentTransportState};
}

async function syncPlayback(player, address, read = readPlayback) {
    const playlist = player.playlistManager;
    const revision = playlist.playbackRevision;
    const request = player.speakerSyncRevision = (player.speakerSyncRevision || 0) + 1;
    try {
        validateAddress(address);
        const snapshot = await read(address);
        if (request !== player.speakerSyncRevision || revision !== playlist.playbackRevision || playlist.playbackPending) return;
        await playlist.ReportSpeakerPlayback(snapshot);
    } catch (error) {
        player.error('Unable to synchronize Sonos playback:', error);
        throw new Error(player.homey.__('playback.sonosSyncFailed'), {cause: error});
    }
}

module.exports = {readPlayback, syncPlayback};
