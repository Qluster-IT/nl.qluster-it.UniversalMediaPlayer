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
    const power = document.getElementById('announcementAutoPower');
    const powerStatus = document.getElementById('autoPowerStatus');
    call('get', 'announcementAutoPower').then(value => {
        power.checked = value === true;
        power.disabled = false;
        power.addEventListener('change', async () => {
            const next = power.checked;
            power.disabled = true;
            powerStatus.textContent = '';
            try {
                await call('set', 'announcementAutoPower', next);
                powerStatus.textContent = Homey.__('settings.auto_power_saved');
            } catch {
                power.checked = !next;
                powerStatus.textContent = Homey.__('settings.auto_power_error');
            } finally {
                power.disabled = false;
            }
        });
    }, () => { powerStatus.textContent = Homey.__('settings.auto_power_error'); });
}
