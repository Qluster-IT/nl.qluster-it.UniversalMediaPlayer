'use strict';

const Homey = require('homey');
const {features, capabilities} = require('../../lib/speaker-device');

class SpeakerDriver extends Homey.Driver {
    async onPairListDevices() {
        const playback = this.homey.app.speakerPlayback;
        const speakers = await playback.refresh();
        const names = new Map(playback.pickerChoices(speakers).map(choice => [choice.id, choice.name]));
        const paired = new Set(this.getDevices().map(device => device.getData().id));
        return speakers.filter(speaker => !paired.has(speaker.id)).map(speaker => ({
            name: names.get(speaker.id) || speaker.name,
            data: {id: speaker.id},
            store: {protocol: speaker.protocol, kind: speaker.kind || null},
            capabilities: capabilities(features(speaker.protocol))
        })).sort((a, b) => a.name.localeCompare(b.name));
    }
}

module.exports = SpeakerDriver;
