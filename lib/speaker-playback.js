'use strict';

const { isIPv4 } = require('net');
const fetch = require('node-fetch');
const { parseStringPromise, processors } = require('xml2js');
const { isSavedGroup } = require('./speaker-groups');

const renderer = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const zonePlayer = 'urn:schemas-upnp-org:device:ZonePlayer:1';
const avTransport = /^urn:schemas-upnp-org:service:AVTransport:\d+$/;
const zoneTopology = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';
const searchMs = 2200;
const cacheMs = 30000;
const controlRefreshMs = 10 * 60 * 1000;
const sonosId = /^dlna:uuid:rincon_[0-9a-f]{12}\d{5}$/i;
const sonosAddressesKey = 'AnnouncementSonosAddresses';
const speakerPickerKey = 'SpeakerPickerCache';
const rendererAddressesKey = 'RendererAddresses';
// A malformed reply (HPE_* parser error) still came from the device, so it doesn't mean the address is stale.
const isConnectionError = error => ['system', 'request-timeout', 'body-timeout'].includes(error?.type) && !/^HPE_/.test(error?.code) ||
  ['SONOS_CONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code);
const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[char]);
const asArray = value => [].concat(value ?? []);
const descriptionXml = { explicitArray: false, ignoreAttrs: true, trim: true, tagNameProcessors: [processors.stripPrefix] };
const topologyXml = { explicitArray: false, mergeAttrs: true, trim: true, tagNameProcessors: [processors.stripPrefix],
  attrNameProcessors: [name => `@_${name}`] };
// Some devices send a bare "&" in names, which a strict XML parser rejects.
const parseXml = (text, options) =>
  parseStringPromise(text.replace(/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;'), options);

function deviceLists(device) {
  if (!device || typeof device !== 'object') return device;
  if (device.serviceList?.service) device.serviceList.service = asArray(device.serviceList.service);
  if (device.deviceList?.device) device.deviceList.device = asArray(device.deviceList.device).map(deviceLists);
  return device;
}
const speakerId = uuid => `dlna:uuid:${uuid.toLowerCase()}`;
const speakerGroups = new Set(['all', 'all_no_tvs', 'all_no_tv_speakers']);
const pickerLabels = {
  stereo: 'Stereo', left: 'Left', right: 'Right', all: 'All speakers',
  all_help: 'All currently discoverable speakers',
  all_no_tvs: 'All speakers (no TVs)', all_no_tvs_help: 'Skip recognized TVs and video Cast receivers',
  all_no_tv_speakers: 'All speakers (no TVs or TV speakers)',
  all_no_tv_speakers_help: 'Also skip recognized soundbars and home theater speakers',
  saved_group: 'Saved speaker group'
};

function isTvSpeaker(value) {
  return /\b(?:sound[\s-]*bar|home[\s-]+theat(?:er|re))\b/i.test(value);
}

function findService(device, matches) {
  const service = device?.serviceList?.service?.find(matches);
  if (service) return service;
  for (const child of device?.deviceList?.device || []) {
    const nested = findService(child, matches);
    if (nested) return nested;
  }
}

function isTv(value) {
  return /\b(?:television|smart[\s-]*tv|android[\s-]+tv|google[\s-]+tv|hdtv|dtv|bravia|qled|samsung tv)\b|^\s*(?:\[TV\]|TV\b)|\bTV\s*$/i.test(value);
}

function castKind(model, capabilities, name) {
  if (isTvSpeaker(model)) return 'tvSpeaker';
  // Cast's mDNS capability mask uses bit 0 for video output.
  if ((Number(capabilities) & 1) || isTv(model)) return 'tv';
  if ((capabilities == null || !/^\d+$/.test(capabilities)) &&
    /^(?:chromecast(?: (?:hd|ultra))?|eureka dongle|(?:google )?nest hub(?: max)?)$/i.test(String(model).trim())) return 'tv';
  if (isTvSpeaker(name)) return 'tvSpeaker';
  if (isTv(name)) return 'tv';
}

function rendererKind(item, transport, sonos) {
  if (sonos) {
    return /^(?:Sonos\s+)?(?:Arc(?: Ultra| SL)?|Beam(?: \(Gen [12]\))?|Ray|Playbar|Playbase|Amp)$/i.test(String(item.modelName).trim())
      ? 'tvSpeaker' : undefined;
  }
  const devices = [...new Set([item, transport])];
  const product = devices.flatMap(device => [device.modelName, device.modelDescription]);
  if (product.some(isTvSpeaker)) return 'tvSpeaker';
  if (devices.some(device => /^samsung\b/i.test(device.manufacturer) && /^(?:QE|QN|UE|UN|UA)\d{2}[A-Z]/i.test(device.modelName))) return 'tv';
  if (product.some(isTv) || devices.some(device =>
    /:device:(?:tvdevice|television|maintvserver):\d+$/i.test(device.deviceType))) return 'tv';
  const names = devices.map(device => device.friendlyName);
  if (names.some(isTvSpeaker)) return 'tvSpeaker';
  if (names.some(isTv)) return 'tv';
}

function isLan(ip) {
  return isIPv4(ip) && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
}

function deviceUrl(value, host, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'http:' || url.hostname !== host || url.username || url.password) {
    throw new Error('The DLNA speaker advertised an unsupported address.');
  }
  return url.href;
}

async function discoverCast() {
  const { Bonjour } = require('bonjour-service');
  return new Promise((resolve, reject) => {
    const speakers = new Map();
    let timer;
    let browser;
    let done = false;
    const bonjour = new Bonjour({}, error => finish(error));
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser?.stop();
      bonjour.destroy();
      if (error) reject(error);
      else resolve([...speakers.values()]);
    }
    browser = bonjour.find({ type: 'googlecast' }, service => {
      const host = service.addresses?.find(isLan);
      const { id, fn, md, ca } = service.txt || {};
      if (!host || typeof id !== 'string' || !id || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return;
      const name = typeof fn === 'string' && fn.trim() ? fn : service.name;
      if (typeof name !== 'string' || !name.trim()) return;
      speakers.set(id, { id: `cast:${id}`, name, host, port: service.port, protocol: 'cast', kind: castKind(md, ca, name) });
    });
    timer = setTimeout(finish, searchMs);
  });
}

function discoverRenderers() {
  return new Promise((resolve, reject) => {
    const socket = require('dgram').createSocket('udp4');
    const devices = new Map();
    let done = false;
    const timer = setTimeout(finish, searchMs);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve([...devices.values()]);
    }
    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      if (!isLan(remote.address) || message.length > 8192 || devices.size >= 24) return;
      const text = message.toString();
      if (!/^HTTP\/1\.[01] 200\b/.test(text)) return;
      const id = /^USN:\s*(uuid:[^:\r\n]+)::/im.exec(text)?.[1];
      const location = /^LOCATION:\s*(https?:\/\/[^\s]+)/im.exec(text)?.[1];
      if (!id || !location || devices.has(id.toLowerCase())) return;
      try {
        const key = id.toLowerCase();
        devices.set(key, { id: `dlna:${key}`, host: remote.address, location: deviceUrl(location, remote.address) });
      } catch {
        // Ignore advertisements that point away from the responding device.
      }
    });
    for (const target of [renderer, zonePlayer, 'urn:schemas-upnp-org:service:AVTransport:1']) {
      const query = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${target}\r\n\r\n`;
      socket.send(query, 1900, '239.255.255.250', error => { if (error && error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') finish(error); });
    }
  });
}

function findTransport(device, matchesDevice) {
  if (device && matchesDevice(device)) {
    const service = device.serviceList?.service?.find(item =>
      typeof item?.serviceType === 'string' && avTransport.test(item.serviceType) && typeof item.controlURL === 'string');
    if (service) return { device, service };
  }
  for (const child of device?.deviceList?.device || []) {
    const transport = findTransport(child, matchesDevice);
    if (transport) return transport;
  }
}

async function describeRenderer(device, log, timeout = 2000) {
  const response = await fetch(device.location, { redirect: 'error', timeout, size: 128 * 1024 });
  if (!response.ok) throw new Error(`DLNA description returned HTTP ${response.status}.`);
  const root = (await parseXml(await response.text(), descriptionXml))?.root;
  const item = deviceLists(root?.device);
  const sonos = item?.deviceType === zonePlayer && /^Sonos\b/i.test(item.manufacturer);
  const transport = findTransport(item, candidate => sonos || candidate === item ||
    (typeof candidate.UDN === 'string' && `dlna:${candidate.UDN.toLowerCase()}` === device.id));
  const service = transport?.service;
  const name = sonos ? item.roomName || item.friendlyName : transport?.device.friendlyName;
  if (!service?.controlURL || typeof name !== 'string' || !name.trim()) {
    throw new Error('No named DLNA AVTransport renderer found.');
  }
  const base = root.URLBase ? deviceUrl(root.URLBase, device.host, device.location) : device.location;
  const rootId = typeof item.UDN === 'string' && /^uuid:[a-z0-9_-]+$/i.test(item.UDN)
    ? `dlna:${item.UDN.toLowerCase()}` : device.id;
  const speaker = { ...device, id: sonos ? rootId : device.id, identity: item.UDN,
    rendererIdentity: transport.device.UDN, name, endpoint: deviceUrl(service.controlURL, device.host, base),
    service: service.serviceType, protocol: sonos ? 'sonos' : 'dlna', aliases: [device.id],
    kind: rendererKind(item, transport.device, sonos) };
  if (!sonos && /^Microsoft(?: Corporation)?$/i.test(transport.device.manufacturer || item.manufacturer) &&
      (transport.device.modelName || item.modelName) === 'Windows Digital Media Renderer') speaker.windowsRenderer = true;
  if (speaker.kind === 'tv') {
    const model = transport.device.modelName || item.modelName;
    if (typeof model === 'string') speaker.model = model.trim();
    speaker.samsung = [item, transport.device].some(candidate => /^samsung\b/i.test(candidate.manufacturer));
  }
  const eventUrl = value => {
    if (!value) return null;
    try { return deviceUrl(value, device.host, base); }
    catch (error) { log('Invalid speaker event endpoint:', error.message); return null; }
  };
  speaker.events = eventUrl(service.eventSubURL);
  try {
    if (service.SCPDURL) speaker.scpd = deviceUrl(service.SCPDURL, device.host, base);
  } catch {
    // Invalid optional descriptions must not hide an otherwise playable renderer.
  }
  const rendering = transport.device.serviceList?.service?.find(item =>
    /^urn:schemas-upnp-org:service:RenderingControl:\d+$/.test(item.serviceType) && item.controlURL);
  if (rendering) {
    try {
      const scpd = rendering.SCPDURL && deviceUrl(rendering.SCPDURL, device.host, base);
      speaker.rendering = { endpoint: deviceUrl(rendering.controlURL, device.host, base), service: rendering.serviceType, scpd };
      speaker.rendering.events = eventUrl(rendering.eventSubURL);
    } catch {
      // An invalid optional volume service does not prevent normal playback.
    }
  }
  if (sonos) {
    if (typeof item.modelName === 'string') speaker.model = item.modelName.trim();
    for (const [field, type, namespace = 'upnp-org'] of [['directory', 'ContentDirectory'], ['properties', 'DeviceProperties'],
      ['groupRendering', 'GroupRenderingControl'], ['queue', 'Queue', 'sonos-com']]) {
      const advertised = findService(item, service =>
        service.serviceType === `urn:schemas-${namespace}:service:${type}:1` && typeof service.controlURL === 'string');
      if (!advertised) continue;
      try {
        speaker[field] = {endpoint: deviceUrl(advertised.controlURL, device.host, base), service: advertised.serviceType,
          events: eventUrl(advertised.eventSubURL)};
      } catch (error) {
        log(`Invalid Sonos ${type} endpoint:`, error.message);
      }
    }
    const topology = item.serviceList?.service?.find(item => item.serviceType === zoneTopology);
    if (topology?.controlURL) {
      try {
        speaker.topology = deviceUrl(topology.controlURL, device.host, base);
        speaker.topologyEvents = eventUrl(topology.eventSubURL);
      } catch {
        // An invalid optional topology endpoint must not hide a playable speaker.
        speaker.invalidTopology = true;
      }
    }
  }
  return speaker;
}

async function readSonosMembers(speaker, timeout = 1500) {
  const action = 'GetZoneGroupState';
  const response = await fetch(speaker.topology, {
    method: 'POST', redirect: 'error', timeout, size: 256 * 1024,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${zoneTopology}#${action}"` },
    body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${zoneTopology}"/></s:Body></s:Envelope>`
  });
  if (!response.ok) {
    response.body?.destroy();
    throw new Error(`Sonos topology returned HTTP ${response.status}.`);
  }
  const envelope = await parseXml(await response.text(), topologyXml);
  // SOAP returns the topology as escaped XML text, which the parser has already unescaped.
  const state = envelope?.Envelope?.Body?.GetZoneGroupStateResponse?.ZoneGroupState;
  if (typeof state !== 'string') throw new Error('Sonos did not return zone topology.');
  const groups = (await parseXml(state, topologyXml))?.ZoneGroupState?.ZoneGroups;
  if (groups == null) throw new Error('Sonos returned invalid zone topology.');
  return asArray(groups.ZoneGroup).flatMap(group =>
    asArray(group.ZoneGroupMember).flatMap(member => [
      member, ...asArray(member.Satellite).map(satellite => ({ ...satellite, '@_Invisible': '1' }))
    ]));
}

function readStereoPair(speaker, members) {
  const primary = members.find(member =>
    typeof member['@_UUID'] === 'string' && speakerId(member['@_UUID']) === speaker.id);
  if (primary?.['@_Invisible'] === '1') return { hidden: true };
  const channelMap = primary?.['@_ChannelMapSet'];
  if (!primary || ![undefined, '0'].includes(primary['@_Invisible']) || typeof channelMap !== 'string') return;
  const entries = channelMap.split(';').filter(Boolean);
  if (entries.length !== 2) return;
  const pair = {};
  for (const entry of entries) {
    const channel = /^(RINCON_[a-z0-9_]+):(LF|RF)(?:,\2)*$/i.exec(entry);
    if (channel) pair[channel[2].toUpperCase() === 'LF' ? 'left' : 'right'] = speakerId(channel[1]);
  }
  const secondary = pair.left === speaker.id ? pair.right : pair.right === speaker.id ? pair.left : undefined;
  if (secondary && secondary !== speaker.id && members.some(member => member['@_Invisible'] === '1' &&
    typeof member['@_UUID'] === 'string' && speakerId(member['@_UUID']) === secondary)) return { ...pair, secondary };
}

async function discoverDlna(log, known = [], observed = () => {}) {
  const advertised = await discoverRenderers().catch(error => {
    if (!known.length) throw error;
    log('DLNA discovery failed; checking known Sonos rooms:', error.message);
    return [];
  });
  const locations = new Set(advertised.map(device => device.location));
  const previouslySeen = new Set(known);
  const renderers = [...advertised, ...known.filter(device => !locations.has(device.location)).slice(0, 24)];
  const speakers = [];
  for (let i = 0; i < renderers.length; i += 8) {
    const batch = await Promise.allSettled(renderers.slice(i, i + 8).map(async device => {
      const speaker = await describeRenderer(device, log);
      if (previouslySeen.has(device) && (speaker.protocol !== 'sonos' || speaker.id !== device.id)) {
        throw new Error('The address no longer belongs to the known Sonos room.');
      }
      return speaker;
    }));
    for (const result of batch) {
      if (result.status === 'fulfilled') speakers.push(result.value);
      else log('Could not read a DLNA renderer description:', result.reason.message);
    }
  }
  const unique = new Map();
  for (const speaker of speakers) {
    const existing = unique.get(speaker.id);
    if (existing) existing.aliases.push(...speaker.aliases);
    else unique.set(speaker.id, speaker);
  }
  const sonos = [...unique.values()].filter(speaker => speaker.protocol === 'sonos');
  const topologies = new Map();
  for (let i = 0; i < sonos.length; i += 8) {
    const batch = await Promise.all(sonos.slice(i, i + 8).map(async speaker => {
      if (speaker.invalidTopology) log('Ignoring a Sonos topology endpoint with an unsupported address.');
      if (!speaker.topology) return;
      try {
        return [speaker.id, await readSonosMembers(speaker)];
      } catch (error) {
        log('Could not read Sonos stereo topology:', error.message);
      }
    }));
    for (const result of batch.filter(Boolean)) topologies.set(...result);
  }
  // A reachable room can miss SSDP replies but still be listed by its Sonos household.
  const missing = new Map();
  for (const members of topologies.values()) {
    for (const member of members) {
      const uuid = member['@_UUID'];
      const location = member['@_Location'];
      if (member['@_Invisible'] === '1' || member['@_IsZoneBridge'] === '1' ||
        typeof uuid !== 'string' || !/^RINCON_[a-z0-9_]+$/i.test(uuid) || typeof location !== 'string') continue;
      const id = speakerId(uuid);
      if (unique.has(id) || missing.has(id) || missing.size >= 24) continue;
      const match = /^http:\/\/([\d.]+):1400\/xml\/device_description\.xml$/.exec(location);
      if (match && isLan(match[1])) missing.set(id, { members, device: { id, host: match[1], location } });
    }
  }
  const candidates = [...missing.values()];
  for (let i = 0; i < candidates.length; i += 8) {
    await Promise.all(candidates.slice(i, i + 8).map(async ({ members, device }) => {
      try {
        const speaker = await describeRenderer(device, log);
        if (speaker.protocol !== 'sonos' || speaker.id !== device.id) {
          throw new Error('The Sonos room description does not match the household topology.');
        }
        unique.set(speaker.id, speaker);
        topologies.set(speaker.id, members);
      } catch (error) {
        log('Could not read a Sonos household room description:', error.message);
      }
    }));
  }
  const pairs = [...topologies].flatMap(([id, members]) => {
    const speaker = unique.get(id);
    const pair = readStereoPair(speaker, members);
    return pair ? [{ speaker, pair }] : [];
  });
  for (const { speaker, pair } of pairs) {
    if (pair.hidden) continue;
    // Keep individual entries if competing topology reports claim the same device.
    if (pairs.some(other => !other.pair.hidden && other.speaker !== speaker &&
      (other.pair.secondary === pair.secondary || other.pair.secondary === speaker.id || other.speaker.id === pair.secondary))) continue;
    const secondary = unique.get(pair.secondary);
    if (secondary && secondary.protocol !== 'sonos') continue;
    speaker.stereo = { left: unique.get(pair.left)?.model, right: unique.get(pair.right)?.model };
    speaker.aliases.push(pair.secondary, ...(secondary?.aliases || []));
    unique.delete(pair.secondary);
  }
  for (const { speaker, pair } of pairs) {
    if (pair.hidden) unique.delete(speaker.id);
  }
  // Without topology, a Sonos room might be a bonded satellite.
  for (const speaker of sonos) {
    if (!topologies.has(speaker.id)) unique.delete(speaker.id);
  }
  const visible = [...unique.values()];
  const hidden = [...new Set([...topologies.values()].flatMap(members => members.filter(member =>
    member['@_Invisible'] === '1' || member['@_IsZoneBridge'] === '1').map(member =>
    typeof member['@_UUID'] === 'string' ? speakerId(member['@_UUID']) : '').filter(Boolean)))];
  observed(visible, hidden);
  return visible;
}

function playCast(speaker, media) {
  const { Client, DefaultMediaReceiver } = require('castv2-client');
  return new Promise((resolve, reject) => {
    const client = new Client();
    let done = false;
    const timer = setTimeout(() => finish(new Error('Google Cast did not respond.')), 8000);
    function finish(error, disconnected = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!disconnected) client.close();
      if (error) reject(new Error('Could not start the announcement on the Google Cast speaker.'));
      else resolve();
    }
    client.on('error', finish);
    client.on('close', () => finish(new Error('Google Cast disconnected.'), true));
    client.connect({ host: speaker.host, port: speaker.port }, () => {
      if (done) return;
      client.launch(DefaultMediaReceiver, (error, player) => {
        if (error || done) return finish(error);
        player.load({ contentId: media.url, contentType: media.type, streamType: 'BUFFERED' },
          { autoplay: true }, error => finish(error));
      });
    });
  });
}

async function playDlna(speaker, media) {
  const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(media.name || 'Universal Media Player')}</dc:title><upnp:class>object.item.audioItem</upnp:class><res protocolInfo="http-get:*:${escapeXml(media.type)}:*">${escapeXml(media.url)}</res></item></DIDL-Lite>`;
  for (const [action, args] of [
    ['SetAVTransportURI', `<CurrentURI>${escapeXml(media.url)}</CurrentURI><CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`],
    ['Play', '<Speed>1</Speed>']
  ]) {
    const response = await fetch(speaker.endpoint, {
      method: 'POST', redirect: 'error', timeout: 5000,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${speaker.service}#${action}"` },
      body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${speaker.service}"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`
    }).catch(error => {
      if (action === 'SetAVTransportURI' && error.syscall === 'connect' && isConnectionError(error)) {
        error.beforePlayback = true;
      }
      throw error;
    });
    response.body?.destroy();
    if (!response.ok) throw new Error(`${speaker.protocol === 'sonos' ? 'Sonos' : 'DLNA'} speaker rejected ${action} (HTTP ${response.status}).`);
  }
}

class SpeakerPlayback {
  static isSpeakerGroup(id) { return speakerGroups.has(id) || isSavedGroup(id); }
  static isConnectionError(error) { return isConnectionError(error); }

  constructor(log, translate = key => pickerLabels[key], report = error => log('Restoring speaker state failed:', error.message), groups = () => [], settings) {
    this.log = log;
    this.translate = translate;
    this.report = report;
    this.groups = groups;
    this.settings = settings;
    this.controlRooms = new Map();
    this.controlChecks = new Map();
    this.addressChecks = new Map();
    this.controlRevisions = new Map();
    this.controlRevision = 0;
  }

  rendererAddresses() {
    const records = this.settings?.get(rendererAddressesKey);
    return Array.isArray(records) ? records.slice(0, 100).filter(record =>
      /^dlna:uuid:[\w-]{1,200}$/i.test(record?.id ?? '') && isLan(record.host) &&
      typeof record.location === 'string' && record.location.length <= 2048) : [];
  }

  // Last known LAN details of a renderer; callers must verify the identity before relying on them.
  speakerInfo(id) {
    const live = (this.speakers || []).find(speaker => speaker.id === id) || this.controlRooms.get(id);
    if (isLan(live?.host)) return { host: live.host, model: live.model || null, samsung: Boolean(live.samsung) };
    const host = this.rendererAddresses().find(record => record.id === id)?.host;
    return host ? { host, model: null, samsung: false } : null;
  }

  async rememberRendererAddresses(speakers) {
    if (!this.settings) return;
    const known = this.rendererAddresses();
    const current = speakers.filter(s => s.protocol === 'dlna' && isLan(s.host) &&
      typeof s.location === 'string' && this.matchesRendererIdentity(s, s.id))
      .map(({id, host, location}) => ({id, host, location}));
    if (!current.length) return;
    const replaced = new Set(current.map(room => room.id));
    const next = [...current, ...known.filter(room => !replaced.has(room.id))].slice(0, 100)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(known) !== JSON.stringify(next)) {
      try { await this.settings.set(rendererAddressesKey, next); }
      catch (error) { this.log('Unable to remember DLNA addresses:', error.message); }
    }
  }

  matchesRendererIdentity(room, id) {
    return [room.identity, room.rendererIdentity].some(identity =>
      typeof identity === 'string' && `dlna:${identity.toLowerCase()}` === id);
  }

  updateControlRoom(id, room, revision, failedHost) {
    const previous = this.controlRevisions.get(id);
    if (previous?.revision > revision) {
      if (!room || !previous.failedHost || previous.failedHost === room.host) return;
      revision = previous.revision;
    }
    this.controlRevisions.delete(id);
    this.controlRevisions.set(id, {revision, failedHost});
    this.controlRooms.delete(id);
    if (room) this.controlRooms.set(id, room);
    while (this.controlRevisions.size > 100) {
      const oldest = this.controlRevisions.keys().next().value;
      this.controlRevisions.delete(oldest);
      this.controlRooms.delete(oldest);
    }
  }

  rememberControlRooms(speakers, revision = ++this.controlRevision) {
    for (const room of speakers) {
      if (room.protocol !== 'dlna' && room.protocol !== 'sonos') continue;
      this.updateControlRoom(room.id, room, revision);
    }
  }

  async verifyControlAddress(id) {
    if (sonosId.test(id)) return (await this.verifyKnownSonos([id]))?.[0];
    const record = this.rendererAddresses().find(room => room.id === id);
    if (!record) return;
    try {
      const location = deviceUrl(record.location, record.host);
      const room = await describeRenderer({...record, location}, this.log, 850);
      if (room.protocol !== 'dlna' || !this.matchesRendererIdentity(room, id)) {
        throw new Error('Stored address no longer identifies this renderer.');
      }
      return room;
    } catch (error) {
      this.log('Unable to verify saved DLNA address; using discovery:', error.message);
    }
  }

  controlConnectionFailed(room, error) {
    if (!isConnectionError(error)) return;
    const remembered = this.controlRooms.get(room.id);
    if (remembered?.host === room.host && remembered?.endpoint === room.endpoint) {
      this.updateControlRoom(room.id, null, ++this.controlRevision, room.host);
    }
    this.refreshInBackground(true);
  }

  async rediscoverSonosEndpoint(room, error) {
    if (room.protocol !== 'sonos' || !sonosId.test(room.id) || !isConnectionError(error)) return;
    this.controlConnectionFailed(room, error);
    const replacement = () => {
      const current = this.controlRooms.get(room.id);
      return current && current !== room && current.protocol === 'sonos' && current.id === room.id ? current : undefined;
    };
    if (replacement()) return replacement();
    try { await (this.pending || this.refresh()); }
    catch (scanError) { this.log('Sonos rediscovery before playback failed:', scanError.message); }
    const found = replacement();
    if (!found) this.log('Could not rediscover the same Sonos room before playback:', room.id);
    return found;
  }

  async beforePlaybackRetry(room, attempt, safeToRetry) {
    try { return await attempt(room); }
    catch (error) {
      if (safeToRetry(error) && isConnectionError(error) && room.protocol === 'sonos' && sonosId.test(room.id)) {
        const replacement = await this.rediscoverSonosEndpoint(room, error);
        if (replacement) {
          try { return await attempt(replacement); }
          catch (retryError) {
            this.controlConnectionFailed(replacement, retryError);
            throw retryError;
          }
        }
      } else this.controlConnectionFailed(room, error);
      throw error;
    }
  }

  knownSonosAddresses() {
    const records = this.settings?.get(sonosAddressesKey);
    return Array.isArray(records) ? records.slice(0, 100).filter(record =>
      typeof record?.id === 'string' && sonosId.test(record.id) && isLan(record.host)) : [];
  }

  async rememberSonosAddresses(speakers) {
    if (!this.settings) return;
    const current = speakers.filter(s => s.protocol === 'sonos' && sonosId.test(s.id) && isLan(s.host))
      .map(s => ({id: s.id, host: s.host, aliases: [...new Set((s.aliases || []).filter(id => id !== s.id && sonosId.test(id)))].sort()}));
    if (!current.length) return;
    const known = this.knownSonosAddresses();
    const replaced = new Set(current.flatMap(room => [room.id, ...room.aliases]));
    const next = [...current, ...known.filter(room => !replaced.has(room.id))].slice(0, 100)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(known) !== JSON.stringify(next)) {
      try { await this.settings.set(sonosAddressesKey, next); }
      catch (error) { this.log('Unable to remember Sonos announcement addresses:', error.message); }
    }
  }

  async verifyKnownSonos(ids) {
    if (!ids.length || !ids.every(id => sonosId.test(id))) return;
    const known = this.knownSonosAddresses();
    const records = ids.map(id => known.find(room => room.id === id) ||
      known.find(room => Array.isArray(room.aliases) && room.aliases.includes(id)));
    if (records.some(room => !room)) return;
    const unique = [...new Set(records)];
    const targets = [];
    for (let offset = 0; offset < unique.length; offset += 8) {
      const verified = await Promise.all(unique.slice(offset, offset + 8).map(record => this.verifySonosAddress(record)));
      if (verified.some(room => !room)) return;
      targets.push(...verified);
    }
    if (ids.every(id => targets.some(room => room.id === id || room.aliases.includes(id)))) return targets;
  }

  verifySonosAddress({id, host}) {
    const key = `${id}@${host}`;
    if (this.addressChecks.has(key)) return this.addressChecks.get(key);
    const revision = ++this.controlRevision;
    const check = (async () => {
        try {
          const room = await describeRenderer({id, host, location: `http://${host}:1400/xml/device_description.xml`}, this.log, 850);
          if (room.protocol !== 'sonos' || typeof room.identity !== 'string' || `dlna:${room.identity.toLowerCase()}` !== id || !room.topology) {
            throw new Error('Stored address no longer identifies this room.');
          }
          const members = await readSonosMembers(room, 850);
          const own = members.find(member => typeof member['@_UUID'] === 'string' && speakerId(member['@_UUID']) === id);
          const pair = readStereoPair(room, members);
          if (!own || pair?.hidden || own['@_IsZoneBridge'] === '1') throw new Error('Room is not a visible Sonos player.');
          room.aliases = pair?.secondary ? [pair.secondary] : [];
          this.updateControlRoom(id, room, revision);
          return this.controlRooms.get(id);
        } catch (error) {
          if (this.controlRooms.get(id)?.host === host) this.updateControlRoom(id, null, revision, host);
          this.log('Unable to verify saved Sonos address; using discovery:', error.message);
          return null;
        }
    })().finally(() => this.addressChecks.delete(key));
    this.addressChecks.set(key, check);
    return check;
  }

  async refresh() {
    if (!this.pending) {
      this.discoveryAttemptedAt = Date.now();
      const revision = ++this.controlRevision;
      const knownSonos = (this.speakers || []).filter(device => device.protocol === 'sonos' && device.location);
      this.pending = Promise.allSettled([discoverCast(), discoverDlna(this.log, knownSonos, (visible, hidden) => {
        for (const id of hidden) this.updateControlRoom(id, null, revision);
        this.rememberControlRooms(visible, revision);
      })]).then(async results => {
        const speakers = [];
        for (const result of results) {
          if (result.status === 'fulfilled') speakers.push(...result.value);
          else this.log('Speaker discovery failed:', result.reason.message);
        }
        if (results.every(result => result.status === 'rejected')) throw new Error('Unable to discover speakers on the local network.');
        this.speakers = speakers;
        this.discoveredAt = Date.now();
        this.rememberControlRooms(speakers, revision);
        const choices = this.pickerChoices(speakers).slice(0, 100);
        if (this.settings && results.every(result => result.status === 'fulfilled') &&
            JSON.stringify(this.settings.get(speakerPickerKey)) !== JSON.stringify(choices)) {
          try { await this.settings.set(speakerPickerKey, choices); }
          catch (error) { this.log('Unable to save the speaker picker cache:', error.message); }
        }
        await this.rememberSonosAddresses(speakers);
        await this.rememberRendererAddresses(speakers);
        return speakers;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  refreshInBackground(force = false) {
    if (this.pending || Date.now() - (this.discoveryAttemptedAt ?? -Infinity) < (force ? 5000 : cacheMs)) return;
    if (!force && Date.now() - this.discoveredAt < cacheMs) return;
    void this.refresh().catch(error => this.log('Background speaker discovery failed:', error.message));
  }

  async listSpeakers(fresh = false, wait = false) {
    let choices;
    try { choices = await this.discoveredSpeakers(fresh, wait); }
    catch (error) {
      const paired = this.withPaired([]);
      if (!paired.length) throw error;
      this.log('Speaker discovery failed; listing paired speakers only:', error.message);
      return paired;
    }
    return this.withPaired(choices);
  }

  // Paired Playback Devices use their Homey name and stay selectable while discovery misses them.
  withPaired(choices) {
    let paired;
    try { paired = this.paired?.() || []; }
    catch (error) {
      this.log('Unable to read paired speakers:', error.message);
      return choices;
    }
    if (!paired.length) return choices;
    const names = new Map(paired.map(device => [device.id, device]));
    const labels = { cast: 'Google Cast', dlna: 'UPnP / DLNA', sonos: 'Sonos' };
    const result = choices.map(choice => names.has(choice.id) ? { ...choice, name: names.get(choice.id).name } : choice);
    for (const device of paired) {
      if (!result.some(choice => choice.id === device.id)) {
        result.push({ id: device.id, name: device.name, description: labels[device.protocol] || '' });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description));
  }

  async discoveredSpeakers(fresh = false, wait = false) {
    if (fresh) return this.pickerChoices(await this.refresh());
    if (wait) {
      if (this.pending) return this.pickerChoices(await this.pending);
      if (!this.speakers || Date.now() - this.discoveredAt >= cacheMs) return this.pickerChoices(await this.refresh());
    }
    this.refreshInBackground();
    if (this.speakers) return this.pickerChoices(this.speakers);
    const saved = this.settings?.get(speakerPickerKey);
    if (Array.isArray(saved)) return saved.slice(0, 100).filter(item =>
      typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.description === 'string')
      .map(({id, name, description}) => ({id, name, description}));
    return this.pickerChoices(await (this.pending || this.refresh()));
  }

  pickerChoices(speakers) {
    const labels = { cast: 'Google Cast', dlna: 'UPnP / DLNA', sonos: 'Sonos' };
    return speakers.map(({ id, name, protocol, stereo }) => {
      if (!stereo) return { id, name, description: labels[protocol] };
      const details = ['left', 'right'].filter(side => stereo[side])
        .map(side => `${this.translate(side)}: ${stereo[side]}`);
      return { id, name: `${name} (${this.translate('stereo')})`, description: ['Sonos', ...details].join(' · ') };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description));
  }

  async autocomplete(query, fresh = false, wait = false) {
    const filter = (query || '').trim().toLowerCase();
    const matches = choice => `${choice.name} ${choice.description}`.toLowerCase().includes(filter);
    const groups = [...speakerGroups].map(id => ({
      id, name: this.translate(id), description: this.translate(`${id}_help`)
    }));
    const saved = this.groups().map(({ id, name }) => ({ id, name, description: this.translate('saved_group') }))
      .sort((a, b) => a.name.localeCompare(b.name));
    let choices;
    try { choices = await this.listSpeakers(fresh, wait); }
    catch (error) {
      if (!saved.some(matches)) throw error;
      this.log('Individual speaker discovery failed while listing saved groups:', error.message);
      choices = [];
    }
    return [...groups, ...saved, ...choices].filter(matches);
  }

  async selectForControl(value) {
    const id = value?.id;
    if (typeof id !== 'string' || !id.startsWith('dlna:uuid:')) return this.select(value);
    const matches = room => room.id === id || room.aliases?.includes(id);
    const remembered = this.controlRooms.get(id) || [...this.controlRooms.values()].find(matches);
    if (remembered) {
      // Playback Devices poll often; connection failures already force discovery, so only refresh stale data here.
      if (Date.now() - (this.discoveredAt ?? 0) >= controlRefreshMs) this.refreshInBackground();
      return remembered;
    }
    if (!this.controlChecks.has(id)) {
      const check = (async () => {
        const verified = await this.verifyControlAddress(id);
        const found = verified || (await (this.pending || this.refresh())).find(matches);
        const latest = found && this.controlRooms.get(found.id);
        const room = latest || found;
        const failed = room && this.controlRevisions.get(room.id);
        const invalidated = failed && !latest && (!failed.failedHost || failed.failedHost === room.host);
        if (!room || !matches(room) || invalidated) throw new Error('The selected speaker is not available on the local network.');
        if (!this.controlRooms.has(room.id)) this.rememberControlRooms([room]);
        if (verified) this.refreshInBackground();
        return room;
      })().finally(() => this.controlChecks.delete(id));
      this.controlChecks.set(id, check);
    }
    return this.controlChecks.get(id);
  }

  async select(value, preferKnownSonos = false) {
    if (typeof value?.id !== 'string') throw new Error('Select a speaker from the list.');
    if (isSavedGroup(value.id)) {
      const group = this.groups().find(item => item.id === value.id);
      if (!group) throw new Error('The selected speaker group no longer exists. Choose another speaker or group.');
      const members = new Map(group.members.map(member => [member.id, member]));
      const verified = preferKnownSonos && await this.verifyKnownSonos([...members.keys()]);
      const speakers = verified || await this.refresh();
      const targets = speakers.flatMap(speaker => {
        const member = members.get(speaker.id) ?? speaker.aliases?.map(id => members.get(id)).find(Boolean);
        if (!member) return [];
        const { volumeOffset, maxVolume } = member;
        return [volumeOffset !== undefined || maxVolume !== undefined ? { ...speaker, volumeOffset, maxVolume } : speaker];
      });
      if (!targets.length) throw new Error(`No speakers in "${group.name}" are currently available.`);
      return { id: group.id, targets, restrictSonosToTargets: true };
    }
    if (SpeakerPlayback.isSpeakerGroup(value.id)) {
      const speakers = await this.refresh();
      if (!speakers.length) throw new Error('No speakers are currently available on the local network.');
      const excluded = value.id === 'all' ? [] : speakers.filter(speaker =>
        speaker.kind === 'tv' || (value.id === 'all_no_tv_speakers' && speaker.kind === 'tvSpeaker'));
      const targets = speakers.filter(speaker => !excluded.includes(speaker));
      if (!targets.length) throw new Error('No speakers match the selected TV exclusions.');
      return { id: value.id, targets, excludedSonos: excluded.filter(speaker => speaker.protocol === 'sonos') };
    }
    const matches = item => item.id === value.id || item.aliases?.includes(value.id);
    if (preferKnownSonos && sonosId.test(value.id)) {
      return this.selectForControl(value);
    }
    if (this.pending) {
      const speaker = (await this.pending).find(matches);
      if (!speaker) throw new Error('The selected speaker is not available on the local network.');
      return speaker;
    }
    let speaker = Date.now() - this.discoveredAt < cacheMs && this.speakers.find(matches);
    if (!speaker) speaker = (await this.refresh()).find(matches);
    if (!speaker) throw new Error('The selected speaker is not available on the local network.');
    return speaker;
  }

  async playSingle(speaker, media) {
    return speaker.protocol === 'cast' ? playCast(speaker, media) :
      this.beforePlaybackRetry(speaker, target => playDlna(target, media), error => error.beforePlayback === true);
  }
}

module.exports = SpeakerPlayback;
