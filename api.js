'use strict';

function requireReady(homey) {
    if (homey.app.apiReady !== true) {
        throw new Error('Universal Media Player is still starting.');
    }
}

function getComponent(homey, name, method) {
    const component = homey.app[name];
    if (!component || typeof component[method] !== 'function') {
        throw new Error(`The ${name} service is unavailable.`);
    }
    return component;
}

module.exports = {
    async getApiReady({homey}) {
        return {ready: homey.app.apiReady === true};
    },

    async getSpeakerGroups({homey}) {
        requireReady(homey);
        return getComponent(homey, 'speakerGroups', 'list').list();
    },

    async getSpeakers({homey, query = {}}) {
        requireReady(homey);
        return getComponent(homey, 'speakerPlayback', 'listSpeakers').listSpeakers(query.fresh === 'true', query.wait === 'true');
    },

    async saveSpeakerGroup({homey, body}) {
        requireReady(homey);
        return getComponent(homey, 'speakerGroups', 'save').save(body);
    },

    async removeSpeakerGroup({homey, params}) {
        requireReady(homey);
        return getComponent(homey, 'speakerGroups', 'remove').remove(params.id);
    }
};
