'use strict';

function onHomeyReady(Homey) {
    Homey.ready();
    initSpeakerGroups(Homey);
    const select = document.getElementById('sonosAnnouncementMode');
    const status = document.getElementById('sonosModeStatus');
    const call = (method, ...args) => new Promise((resolve, reject) => {
        Homey[method](...args, (error, value) => error ? reject(error) : resolve(value));
    });
    call('get', 'sonosAnnouncementMode').then(value => {
        let current = value === 'selected' ? 'selected' : 'sync';
        select.value = current;
        select.disabled = false;
        select.addEventListener('change', async () => {
            const next = select.value;
            select.disabled = true;
            status.textContent = '';
            try {
                await call('set', 'sonosAnnouncementMode', next);
                current = next;
                status.textContent = Homey.__('settings.sonos_saved');
            } catch {
                select.value = current;
                status.textContent = Homey.__('settings.sonos_save_error');
            } finally {
                select.disabled = false;
            }
        });
    }, () => { status.textContent = Homey.__('settings.sonos_load_error'); });
}
