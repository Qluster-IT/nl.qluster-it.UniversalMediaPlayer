'use strict';

const {DEFAULT_TARGET, CURRENT_TARGET, updateTarget, listTargets, validateTarget, saveTarget} = require('./playback-target');

module.exports = function registerPlayerSetup(driver, session, device) {
    const {homey} = driver;
    const manifest = require('../../app.json').drivers.find(item => item.id === 'upnpplayer');
    if (!manifest || !Array.isArray(manifest.settings)) throw new Error('UPnP Player settings are unavailable.');
    const language = homey.i18n.getLanguage();
    const label = value => typeof value === 'string' ? value : value?.[language] || value?.en || '';
    const flatten = fields => fields.flatMap(field => field.type === 'group' ? flatten(field.children) : [field]);
    const fields = flatten(manifest.settings).filter(field => field.type !== 'label' && (device || field.id !== 'ip'));
    const defaults = Object.fromEntries(fields.map(field => [field.id, field.value]));
    let settings = Object.fromEntries(fields.map(field => [field.id, device?.getSetting(field.id) ?? field.value]));
    const pairChanges = {};
    let speaker = device?.getStoreValue(DEFAULT_TARGET) ?? null;

    session.setHandler('get_player_setup', () => ({
        settings,
        speaker,
        next: device ? null : 'list_devices',
        fields: fields.map(({id, type, label: title, hint, min, max, values}) => ({
            id, type, label: label(title), hint: label(hint), min, max,
            values: values?.map(option => ({id: option.id, label: label(option.label)})), readOnly: id === 'ip'
        }))
    }));
    session.setHandler('list_playback_targets', ({fresh, wait} = {}) => listTargets(homey, fresh === true, wait === true));

    async function save(input) {
        const draft = input?.settings;
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error(homey.__('targets.invalid_settings'));
        const changes = {};
        const before = {};
        for (const [id, value] of Object.entries(draft)) {
            const field = fields.find(entry => entry.id === id && id !== 'ip');
            const valid = field?.type === 'checkbox' ? typeof value === 'boolean'
                : field?.type === 'dropdown' ? field.values?.some(option => option.id === value)
                : field?.type === 'number' && Number.isInteger(value) &&
                    (field.min === undefined || value >= field.min) &&
                    (field.max === undefined || value <= field.max) &&
                    (id !== 'recentFolderLimit' || (value >= 0 && value <= 100));
            if (!valid) throw new Error(homey.__('targets.invalid_settings'));
            const current = device?.getSetting(id) ?? settings[id];
            if (value !== current) {
                before[id] = current;
                changes[id] = value;
            }
        }
        const previous = device ? device.getStoreValue(DEFAULT_TARGET) ?? null : speaker;
        const selection = await validateTarget(homey, input.speaker, previous);
        if (device) {
            const settingsChanged = Object.keys(changes).length > 0;
            if (settingsChanged) await device.setSettings(changes);
            try {
                await saveTarget(device, DEFAULT_TARGET, selection, previous, device.getStoreValue(CURRENT_TARGET) == null);
            } catch (error) {
                if (settingsChanged) {
                    try {
                        await device.setSettings(before);
                    } catch (rollbackError) {
                        driver.error('Unable to roll back player settings:', rollbackError);
                    }
                }
                throw error;
            }
        }
        if (!device) Object.assign(pairChanges, draft);
        settings = {...settings, ...changes};
        speaker = selection;
    }

    session.setHandler('save_player_setup', input => device ? updateTarget(device, () => save(input)) : save(input));
    return devices => devices.map(item => ({
        ...item, settings: {...defaults, ...item.settings, ...pairChanges}, store: {...item.store, [DEFAULT_TARGET]: speaker}
    }));
};
