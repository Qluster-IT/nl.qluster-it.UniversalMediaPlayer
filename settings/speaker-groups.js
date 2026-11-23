'use strict';

function initSpeakerGroups(Homey) {
    const el = id => document.getElementById(id);
    const tabs = [el('generalTab'), el('groupsTab')];
    const selector = el('speakerGroupSelect');
    const name = el('speakerGroupName');
    const memberList = el('speakerGroupMembers');
    const groupStatus = el('speakerGroupStatus');
    const discoveryStatus = el('groupDiscoveryStatus');
    const validationStatus = el('groupValidationStatus');
    const call = (method, ...args) => new Promise((resolve, reject) => {
        Homey[method](...args, (error, value) => error ? reject(error) : resolve(value));
    });
    const translate = (key, tokens = {}) => Homey.__(`settings.${key}`)
        .replace(/__(\w+)__/g, (match, token) => tokens[token] ?? match);
    let groups = null;
    let speakers = [];
    let draft = null;
    let busy = false;
    let discovering = false;

    function errorText(error) {
        if (typeof error === 'string') return error;
        if (error && typeof error.message === 'string') return error.message;
        return '';
    }

    function showTab(index, focus = false) {
        tabs.forEach((tab, tabIndex) => {
            const active = tabIndex === index;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            el(tab.getAttribute('aria-controls')).hidden = !active;
            el(tabIndex === 0 ? 'generalActions' : 'groupsActions').hidden = !active;
        });
        if (focus) tabs[index].focus();
        if (index === 1 && groups === null && !busy) void loadGroups();
    }

    document.title = translate('settings_title');
    for (const element of document.querySelectorAll('[data-i18n^="settings."]')) {
        element.textContent = Homey.__(element.dataset.i18n);
    }
    el('settingsTabs').setAttribute('aria-label', translate('navigation'));
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => showTab(index));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            showTab(next, true);
        });
    });
    el('openGroups').addEventListener('click', () => showTab(1, true));

    function isDirty() {
        if (!draft || !Array.isArray(groups)) return false;
        const saved = groups.find(group => group.id === draft.id);
        if (!saved) return true;
        return draft.name !== saved.name || draft.members.size !== saved.members.length ||
            saved.members.some(member => {
                const current = draft.members.get(member.id);
                return !current || (current.volumeOffset ?? 0) !== (member.volumeOffset ?? 0) ||
                    (current.maxVolume ?? 100) !== (member.maxVolume ?? 100) ||
                    Boolean(current.autoPower) !== Boolean(member.autoPower);
            });
    }

    function validationMessage() {
        if (!draft || !Array.isArray(groups)) return '';
        const groupName = draft.name.trim();
        if (!groupName) return translate('group_name_required');
        if (groupName.length > 80) return translate('group_name_too_long');
        if (groups.some(group => group.id !== draft.id && group.name.trim().toLowerCase() === groupName.toLowerCase())) {
            return translate('group_duplicate_name');
        }
        if (!draft.members.size) return translate('group_select_members');
        if (draft.members.size > 50) return translate('group_too_many_members');
        if (!draft.id && groups.length >= 50) return translate('groups_limit');
        return '';
    }

    function isValid() {
        return Boolean(draft && !validationMessage());
    }

    function updateButtons() {
        validationStatus.textContent = validationMessage();
        const loading = groups === null;
        selector.disabled = busy || loading || groups.length === 0;
        el('speakerGroupAdd').disabled = busy || loading || groups.length >= 50;
        el('speakerGroupDelete').disabled = busy || !draft?.id;
        el('speakerGroupSave').disabled = busy || !isDirty() || !isValid();
        el('speakerGroupRefresh').disabled = busy || discovering || !draft;
        el('speakerGroupLoadRetry').hidden = !loading || busy;
        el('groupMemberFields').disabled = busy || (discovering && !speakers.length) || !draft;
        name.disabled = busy || !draft;
    }

    function renderGroups() {
        selector.textContent = '';
        selector.add(new Option(translate(groups.length ? 'group_choose' : 'groups_empty'), ''));
        for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
            selector.add(new Option(group.name, group.id));
        }
    }

    function renderMembers() {
        memberList.textContent = '';
        if (!draft) return;
        const saved = groups.find(group => group.id === draft.id);
        const options = new Map((saved?.members ?? []).map(member => [member.id, {...member, unavailable: true}]));
        for (const speaker of speakers) options.set(speaker.id, speaker);
        for (const [id, speaker] of draft.members) {
            if (!options.has(id)) options.set(id, {...speaker, unavailable: true});
        }

        for (const speaker of options.values()) {
            const row = document.createElement('div');
            row.className = 'group-speaker-row';
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'hy-nostyle';
            checkbox.checked = draft.members.has(speaker.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) draft.members.set(speaker.id, {id: speaker.id, name: speaker.name});
                else draft.members.delete(speaker.id);
                fields.hidden = !checkbox.checked;
                if (checkbox.checked) resetSliders.forEach(reset => reset());
                updateButtons();
            });
            label.append(checkbox, document.createTextNode(speaker.unavailable
                ? translate('group_member_unavailable', {name: speaker.name})
                : speaker.name));

            const fields = document.createElement('div');
            fields.className = 'group-volume-fields';
            fields.hidden = !checkbox.checked;
            const resetSliders = [
                ['volumeOffset', 'group_volume_offset', -100, 0],
                ['maxVolume', 'group_max_volume', 0, 100]
            ].map(([key, title, min, fallback]) => {
                const field = document.createElement('label');
                field.className = 'group-volume-slider';
                const heading = document.createElement('span');
                heading.className = 'group-volume-heading';
                const value = document.createElement('span');
                value.className = 'group-volume-value';
                value.setAttribute('aria-hidden', 'true');
                heading.append(document.createTextNode(translate(title)), value);
                const input = document.createElement('input');
                input.type = 'range';
                input.className = 'hy-nostyle';
                input.min = String(min);
                input.max = '100';
                input.step = '1';
                input.value = String(draft.members.get(speaker.id)?.[key] ?? fallback);
                const updateValue = () => {
                    const number = input.valueAsNumber;
                    value.textContent = key === 'maxVolume' ? `${number}%` : `${number > 0 ? '+' : ''}${number}`;
                    input.setAttribute('aria-valuetext', value.textContent);
                };
                updateValue();
                input.addEventListener('input', () => {
                    const member = draft.members.get(speaker.id);
                    if (!member) return;
                    member[key] = input.valueAsNumber;
                    updateValue();
                    updateButtons();
                });
                field.append(heading, input);
                fields.append(field);
                return () => {
                    input.value = String(fallback);
                    updateValue();
                };
            });
            const power = document.createElement('label');
            power.className = 'checkbox-label group-auto-power';
            const powerBox = document.createElement('input');
            powerBox.type = 'checkbox';
            powerBox.className = 'hy-nostyle';
            powerBox.checked = draft.members.get(speaker.id)?.autoPower === true;
            powerBox.addEventListener('change', () => {
                const member = draft.members.get(speaker.id);
                if (!member) return;
                if (powerBox.checked) member.autoPower = true;
                else delete member.autoPower;
                updateButtons();
            });
            const powerText = document.createElement('span');
            powerText.textContent = translate('group_auto_power');
            power.title = translate('group_auto_power_help');
            power.append(powerBox, powerText);
            fields.append(power);
            resetSliders.push(() => { powerBox.checked = false; });
            row.append(label, fields);
            memberList.append(row);
        }
    }

    function selectGroup(group, makeNew = false) {
        draft = group
            ? {id: group.id, name: group.name, members: new Map(group.members.map(member => [member.id, {...member}]))}
            : makeNew ? {name: '', members: new Map()} : null;
        selector.value = draft?.id ?? '';
        el('speakerGroupEditor').hidden = !draft;
        name.value = draft?.name ?? '';
        renderMembers();
        updateButtons();
        if (makeNew) name.focus();
    }

    async function refreshSpeakers(fresh = false) {
        if (!draft || busy || discovering) return;
        discovering = true;
        updateButtons();
        discoveryStatus.textContent = translate('group_scanning');
        try {
            const show = result => {
                if (!Array.isArray(result)) throw new Error(translate('group_scan_failed'));
                speakers = result;
                renderMembers();
            };
            show(await call('api', 'GET', fresh ? '/speakers?fresh=true' : '/speakers', null));
            if (!fresh) {
                updateButtons();
                show(await call('api', 'GET', '/speakers?wait=true', null));
            }
            discoveryStatus.textContent = speakers.length ? '' : translate('group_no_speakers');
        } catch (error) {
            const detail = errorText(error);
            discoveryStatus.textContent = `${translate('group_scan_failed')}${detail ? ` ${detail}` : ''}`;
        } finally {
            discovering = false;
            updateButtons();
        }
    }

    const confirm = message => call('confirm', message, 'warning');

    async function loadGroups() {
        busy = true;
        updateButtons();
        groupStatus.textContent = translate('groups_loading');
        try {
            const readiness = await call('api', 'GET', '/api-ready', null);
            if (readiness?.ready !== true) {
                groupStatus.textContent = translate('groups_starting');
                return;
            }
            const result = await call('api', 'GET', '/speaker-groups', null);
            if (!Array.isArray(result)) throw new Error(translate('groups_load_failed'));
            groups = result;
            renderGroups();
            groupStatus.textContent = '';
            selectGroup(null);
        } catch (error) {
            const detail = errorText(error);
            groupStatus.textContent = `${translate('groups_load_failed')}${detail ? ` ${detail}` : ''}`;
        } finally {
            busy = false;
            updateButtons();
        }
    }

    async function switchEditor(next, add = false) {
        selector.value = draft?.id ?? '';
        try {
            if (isDirty() && !await confirm(translate('group_discard'))) return;
            groupStatus.textContent = '';
            selectGroup(next, add);
            if (draft) void refreshSpeakers();
        } catch (error) {
            const detail = errorText(error);
            groupStatus.textContent = detail || String(error);
        }
    }

    selector.addEventListener('change', () => {
        void switchEditor(groups.find(group => group.id === selector.value));
    });
    el('speakerGroupAdd').addEventListener('click', () => void switchEditor(null, true));
    el('speakerGroupRefresh').addEventListener('click', () => void refreshSpeakers(true));
    el('speakerGroupLoadRetry').addEventListener('click', () => void loadGroups());
    name.addEventListener('input', () => {
        if (!draft) return;
        draft.name = name.value;
        groupStatus.textContent = '';
        updateButtons();
    });

    async function saveOrDelete(remove) {
        if (!draft || busy) return;
        busy = true;
        updateButtons();
        groupStatus.textContent = '';
        try {
            if (remove) {
                const saved = groups.find(group => group.id === draft.id);
                if (!saved || !await confirm(translate('group_delete_confirm', {name: saved.name}))) return;
                const result = await call('api', 'DELETE', `/speaker-groups/${encodeURIComponent(saved.id)}`, null);
                groups = Array.isArray(result) ? result : await call('api', 'GET', '/speaker-groups', null);
                renderGroups();
                selectGroup(null);
                groupStatus.textContent = translate('group_deleted');
            } else {
                const members = [...draft.members.values()].map(({id, volumeOffset, maxVolume, autoPower}) => ({
                    id, ...(volumeOffset === undefined ? {} : {volumeOffset}),
                    ...(maxVolume === undefined ? {} : {maxVolume}),
                    ...(autoPower === true ? {autoPower} : {})
                }));
                const saved = await call('api', 'POST', '/speaker-groups', {
                    id: draft.id, name: draft.name, members
                });
                groups = [...groups.filter(group => group.id !== saved.id), saved];
                renderGroups();
                selectGroup(saved);
                groupStatus.textContent = translate('group_saved');
            }
        } catch (error) {
            const detail = errorText(error);
            const message = translate(remove ? 'group_delete_failed' : 'group_save_failed');
            groupStatus.textContent = `${message}${detail ? ` ${detail}` : ''}`;
        } finally {
            busy = false;
            updateButtons();
        }
    }

    el('speakerGroupSave').addEventListener('click', () => void saveOrDelete(false));
    el('speakerGroupDelete').addEventListener('click', () => void saveOrDelete(true));
}
