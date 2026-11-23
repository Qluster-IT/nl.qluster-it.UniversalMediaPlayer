(function () {
    'use strict';

    const app = angular.module('umpMedia', []);
    app.directive('mediaArtwork', function () {
        return {
            link: function (scope, element) {
                function failed() {
                    scope.$applyAsync(function () { scope.vm.artworkFailed(); });
                }
                element.on('error', failed);
                scope.$on('$destroy', function () { element.off('error', failed); });
            }
        };
    });
    app.directive('mediaVolumeTrack', function () {
        return {
            require: 'ngModel',
            link: function (scope, element, attrs, model) {
                function paint() {
                    element[0].style.setProperty('--media-volume-level', element[0].value + '%');
                }
                const render = model.$render;
                model.$render = function () {
                    render.call(model);
                    paint();
                };
                element.on('input change', paint);
                scope.$on('$destroy', function () { element.off('input change', paint); });
            }
        };
    });
    app.directive('mediaNativeSeek', function () {
        return {link(scope, element) {
            let dragging = false;
            const start = () => { dragging = true; };
            const end = () => { dragging = false; };
            const paint = () => {
                if (!dragging) element[0].value = scope.vm.position || 0;
            };
            const seek = () => {
                const position = element[0].valueAsNumber;
                end();
                scope.$applyAsync(() => scope.vm.command('seek', position));
            };
            const unwatch = scope.$watchGroup(['vm.position', 'vm.player.duration'], () => scope.$$postDigest(paint));
            element.on('pointerdown', start);
            element.on('pointerup pointercancel blur', end);
            element.on('change', seek);
            scope.$on('$destroy', () => {
                unwatch();
                element.off('pointerdown', start);
                element.off('pointerup pointercancel blur', end);
                element.off('change', seek);
            });
        }};
    });
    // Shows icon-only buttons when the full labels don't fit on one line in this language and width.
    app.directive('mediaFitLabels', function () {
        return {link(scope, element) {
            const row = element[0];
            let frame = 0;
            const fit = () => {
                frame = 0;
                row.classList.remove('icons-only');
                if (row.scrollWidth > row.clientWidth) row.classList.add('icons-only');
            };
            const schedule = () => { if (!frame) frame = requestAnimationFrame(fit); };
            const observer = new ResizeObserver(schedule);
            observer.observe(row);
            const unwatch = scope.$watch(() => row.textContent, () => scope.$$postDigest(schedule));
            scope.$on('$destroy', () => {
                unwatch();
                observer.disconnect();
                cancelAnimationFrame(frame);
            });
        }};
    });
    app.directive('mediaSpectrum', function () {
        return {link(scope, element) {
            const canvas = element[0];
            const context = canvas.getContext('2d');
            const profile = scope.vm.spectrumProfile;
            const bands = profile.bands;
            const levels = new Float32Array(bands);
            const heights = new Float32Array(bands);
            const peaks = new Float32Array(bands);
            const interval = 1000 / profile.drawFps;
            let frame;
            let status;
            let color;
            let settled = false;
            let last = 0;
            function schedule(wait) {
                frame = wait <= 0 && profile.drawFps >= 60 ? {raf: requestAnimationFrame(draw)} : {timer: setTimeout(draw, wait)};
            }
            function draw() {
                const now = performance.now();
                const elapsed = last ? Math.min(250, now - last) / 1000 : 0;
                last = now;
                const vm = scope.vm;
                if (vm.spectrumStatus() !== status) {
                    status = vm.spectrumStatus();
                    scope.$applyAsync();
                }
                const ratio = Math.min(profile.maxRatio, window.devicePixelRatio || 1);
                const width = Math.round(canvas.clientWidth * ratio);
                const height = Math.round(canvas.clientHeight * ratio);
                if (!width || !height) return schedule(250);
                if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width;
                    canvas.height = height;
                    color = getComputedStyle(canvas).color;
                    settled = false;
                }
                const active = Boolean(vm.player?.playing) && vm.spectrumLevels(levels);
                const fall = 2.1 * elapsed;
                let moving = false;
                for (let band = 0; band < bands; band++) {
                    const value = active ? levels[band] : 0;
                    const next = value > heights[band] ? value : Math.max(value, heights[band] - fall);
                    const peak = Math.max(next, peaks[band] - fall * 0.35);
                    moving ||= next !== heights[band] || (profile.peaks && peak !== peaks[band]);
                    heights[band] = next;
                    peaks[band] = peak;
                }
                // Idle widgets only poll occasionally for the next track or status change.
                if (!moving && settled) return schedule(active ? interval : 500);
                settled = !moving;
                const inset = Math.round(Math.min(width, height) * 0.14);
                const gap = Math.max(1, Math.round(width / bands * 0.25));
                const bar = (width - inset * 2 - gap * (bands - 1)) / bands;
                const room = height - inset * 2;
                const cap = Math.max(1, Math.round(2 * ratio));
                context.clearRect(0, 0, width, height);
                context.fillStyle = color;
                for (let band = 0; band < bands; band++) {
                    const size = Math.max(2 * ratio, heights[band] * room);
                    const x = inset + band * (bar + gap);
                    context.fillRect(x, height - inset - size, bar, size);
                    if (profile.peaks && peaks[band] * room > size + cap) {
                        context.fillRect(x, height - inset - peaks[band] * room, bar, cap);
                    }
                }
                schedule(Math.max(0, interval - (performance.now() - now)));
            }
            schedule(0);
            scope.$on('$destroy', () => {
                if (frame?.raf) cancelAnimationFrame(frame.raf);
                clearTimeout(frame?.timer);
            });
        }};
    });
    app.controller('MediaController', ['$scope', '$window', '$interval', function ($scope, $window, $interval) {
        const vm = this;
        const Homey = $window.umpHomey;
        const settings = Homey.getSettings();
        const widget = Homey.getWidgetInstanceId?.();
        vm.restoringSource = Boolean(widget);
        let savingSource = Promise.resolve();
        const volumeSteps = [];
        let steppingVolume = false;
        const realtime = typeof Homey.on === 'function';
        let timer;
        let refreshPending = false;
        let disposed = false;
        let revision = 0;
        let browseRevision = 0;
        let retryFolder;
        let browseFailed = false;
        let revealOnRefresh = true;
        let positionTimer;
        let positionSampleAt;
        let targetRequest = 0;
        let sourceRequest = 0;
        let nativeTimer;
        let roomRequest = 0;
        let deviceRequest = 0;
        let confirmedInput = null;
        const menuTriggers = {source: 'player', speaker: 'speaker-picker', sleep: 'sleep-timer'};
        let retryTimer;
        let errorTimer;
        let stateError;
        let retries = 0;
        let queueRevision = 0;
        let queueTarget;
        const browsingHistory = new Map();
        const contextViews = new Map();
        const pageSize = Number.isInteger(settings.pageSize) && settings.pageSize >= 1 && settings.pageSize <= 200
            ? settings.pageSize : 50;
        const queuePageSize = 50;
        const keys = ['player', 'selectPlayer', 'playing', 'paused', 'stopped', 'pause', 'nothingPlaying', 'duration',
            'controls', 'shuffle', 'previous', 'stop', 'play', 'next', 'repeat', 'startFlow',
            'noPlayers', 'retry', 'loadError', 'controlError', 'library', 'browsing',
            'emptyFolder', 'more', 'volume', 'volumeUp', 'volumeDown', 'mute', 'unmute', 'playFile', 'playFrom',
            'playlist', 'filter', 'clearFilter', 'previousPage', 'nextPage', 'details', 'close', 'stale',
            'loading', 'emptyPlaylist', 'noMatches', 'interrupted', 'recent', 'recentFolders', 'playNext',
            'sleepTimer', 'sleepOff', 'sleep15', 'sleep30', 'sleep60', 'sleepTrack', 'sleepDeferred', 'trackActions', 'config',
            'showSpectrum', 'showArtwork', 'spectrumUnavailable', 'spectrumLoading'];
        vm.labels = Object.fromEntries(keys.map(function (key) { return [key, Homey.__('widget.' + key)]; }));
        vm.labels.back = Homey.__('browse.back');
        vm.labels.selectFolder = Homey.__('browse.selectFolder');
        vm.labels.browseError = Homey.__('browse.browseError');
        for (const key of ['umpPlayers', 'speakerSources', 'queueUnavailable', 'groupRooms', 'groupCoordinator', 'groupMember',
            'inOtherGroup', 'joinRoom', 'leaveRoom', 'controllerLocked', 'seek', 'noRooms', 'tvInput', 'lineInInput',
            'groupVolume', 'roomVolume', 'roomCount', 'tvDetails', 'tvOn', 'tvOff', 'tvStandby',
            'tvWired', 'tvWireless', 'tvFirmware', 'tvFrame', 'tvVoice', 'tvGamepad', 'deviceInput', 'devicePower', 'powerOn', 'powerOff']) {
            vm.labels[key] = Homey.__('widget.' + key);
        }
        for (const key of ['speaker', 'flow_only', 'device_default', 'reload', 'unavailable', 'apply_failed']) {
            vm.labels[key] = Homey.__('targets.' + key);
        }
        vm.large = settings.layout === 'large';
        vm.alwaysOpen = settings.library === 'open';
        vm.browserOpen = vm.alwaysOpen;
        vm.playerId = settings.player && settings.player.id || '';
        vm.players = [];
        vm.player = null;
        vm.loading = false;
        vm.busy = false;
        vm.stale = true;
        vm.disabled = function () { return vm.busy || vm.stale || !vm.player; };
        vm.controlDisabled = function (action) {
            const audio = ['volume', 'volumeUp', 'volumeDown', 'mute'].includes(action);
            const supported = audio && action !== 'mute' ? vm.player?.actions?.volume : vm.player?.actions?.[action];
            return vm.disabled() || Boolean((vm.speakerId || vm.player?.observing) &&
                ((!audio && vm.player.locked) || !supported));
        };
        vm.sourcePayload = function () {
            return {...(vm.speakerId ? {speaker: vm.speakerId, player: vm.player?.libraryPlayer || vm.playerId}
                : {player: vm.playerId, ...(vm.player?.observing ? {observing: vm.player.observing} : {})}),
                ...(widget ? {widget} : {})};
        };
        vm.canBrowse = function () { return Boolean(vm.player && (!vm.speakerId || vm.player.canBrowse)); };
        const spectrumKey = widget ? 'ump-spectrum-' + widget : null;
        vm.visualizer = ['off', 'light', 'normal', 'heavy'].includes(settings.visualizer) ? settings.visualizer : 'normal';
        vm.spectrumProfile = $window.UmpSpectrum.PROFILES[vm.visualizer] || null;
        const spectrum = new $window.UmpSpectrum(({item, offset}) =>
            Homey.api('POST', '/audio', {...vm.sourcePayload(), item, offset}), vm.visualizer);
        try {
            vm.spectrum = Boolean(spectrumKey && vm.spectrumProfile) && $window.localStorage.getItem(spectrumKey) === '1';
        } catch (error) { vm.spectrum = false; }
        function spectrumItem() {
            return vm.player && !vm.player.activeInput ? vm.player.selection?.file?.id : null;
        }
        function syncSpectrum() {
            const item = spectrumItem();
            if (!vm.spectrum || !item || document.hidden) spectrum.cancel();
            else spectrum.load(vm.player.contextId + '\n' + item, item, vm.player.duration, vm.livePosition);
        }
        vm.toggleSpectrum = function () {
            if (!vm.spectrumProfile) return;
            vm.spectrum = !vm.spectrum;
            try {
                if (spectrumKey) $window.localStorage.setItem(spectrumKey, vm.spectrum ? '1' : '0');
            } catch (error) { /* Storage can be unavailable in private views. */ }
            syncSpectrum();
        };
        vm.spectrumStatus = function () {
            if (!vm.spectrum || !vm.player?.canPlay) return '';
            if (!spectrumItem() || spectrum.status === 'unavailable') return vm.labels.spectrumUnavailable;
            return spectrum.status === 'loading' ? vm.labels.spectrumLoading : '';
        };
        vm.spectrumLevels = function (levels) {
            return Boolean(spectrumItem()) && spectrum.levels(vm.livePosition(), levels);
        };
        vm.livePosition = function () {
            if (!vm.player) return 0;
            const position = (vm.player.position || 0) + (vm.player.playing ? Math.max(0, Date.now() - positionSampleAt) : 0);
            return vm.player.duration ? Math.min(position, vm.player.duration) : position;
        };
        vm.playbackBlocked = function () { return vm.player?.sleep?.mode === 'deferred'; };
        vm.inputLabel = function () {
            return vm.player.activeInput === 'tv' ? vm.labels.tvInput : vm.labels.lineInInput;
        };
        vm.playbackStatus = function () {
            return vm.player?.interrupted ? vm.labels.interrupted : vm.player?.playing ? vm.labels.playing
                : vm.player?.paused ? vm.labels.paused : vm.labels.stopped;
        };
        vm.tvPower = function () {
            const power = vm.player?.televisionInfo?.power;
            return power === 'on' ? vm.labels.tvOn : power === 'off' ? vm.labels.tvOff : power === 'standby' ? vm.labels.tvStandby : '';
        };
        vm.tvDisplay = function () {
            const info = vm.player?.televisionInfo;
            return [info?.os, info?.resolution].filter(Boolean).join(' · ');
        };
        vm.tvFeatures = function () {
            const info = vm.player?.televisionInfo;
            return [info?.frame && vm.labels.tvFrame, info?.voice && vm.labels.tvVoice,
                info?.gamepad && vm.labels.tvGamepad].filter(Boolean).join(' · ');
        };
        vm.sourceName = function () {
            return (vm.speakerId ? vm.speakerName : vm.players.find(player => player.id === vm.playerId)?.name) || vm.labels.selectPlayer;
        };
        const menuItems = menu => [...menu.querySelectorAll('button:not(:disabled)')];
        function positionMenu() {
            const menu = document.getElementById('widget-menu');
            const trigger = document.getElementById(vm.menuTrigger());
            if (!menu || !trigger) return;
            const frame = menu.parentElement.getBoundingClientRect();
            const anchor = trigger.getBoundingClientRect();
            const top = anchor.top - frame.top - 4;
            const bottom = anchor.bottom - frame.top + 4;
            const padding = 6;
            const above = top - padding;
            const below = frame.height - bottom - padding;
            const wanted = Math.min(280, menu.scrollHeight + 2);
            const upward = below < wanted && above > below;
            menu.style.top = upward ? 'auto' : `${bottom}px`;
            menu.style.bottom = upward ? `${frame.height - top}px` : 'auto';
            menu.style.maxHeight = `${Math.max(0, Math.min(280, upward ? above : below))}px`;
        }
        function updateMenu(focus = false) {
            const kind = vm.menu;
            $scope.$$postDigest(function () {
                if (kind !== vm.menu) return;
                positionMenu();
                if (!focus) return;
                const menu = document.getElementById('widget-menu');
                if (!menu) return;
                const items = menuItems(menu);
                (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0] || menu).focus();
            });
        }
        vm.menuTrigger = function () { return menuTriggers[vm.menu]; };
        vm.closeMenu = function (restoreFocus = true) {
            const trigger = document.getElementById(vm.menuTrigger());
            const menu = document.getElementById('widget-menu');
            const focus = restoreFocus && (menu?.contains(document.activeElement) || document.activeElement === document.body);
            if (focus) $scope.$$postDigest(() => trigger?.focus());
            if (vm.menu === 'speaker') {
                ++targetRequest;
                vm.targetLoading = false;
            }
            vm.menu = null;
        };
        vm.toggleMenu = function (kind) {
            if (vm.menu === kind) return vm.closeMenu();
            if (vm.menu) vm.closeMenu(false);
            vm.menu = kind;
            if (kind === 'source') vm.loadSources(false);
            if (kind === 'speaker') {
                vm.targetChoices ??= vm.player.currentTarget ? [vm.player.currentTarget] : [];
                vm.reloadTargets(false);
            }
            updateMenu(true);
        };
        function rememberSource(kind, id) {
            if (!widget) return;
            savingSource = savingSource.then(() => Homey.api('POST', '/control', {
                action: 'saveSourcePreference', widget, source: {kind, id}
            })).catch(error => {
                console.error('Unable to remember widget source:', error);
                update(() => showError(vm.labels.apply_failed));
            });
        }
        vm.chooseSource = function (id) {
            vm.closeMenu();
            if (vm.busy || (!vm.speakerId && id === vm.playerId)) return;
            rememberView();
            vm.speakerId = null;
            vm.playerId = id;
            rememberSource('player', id);
            vm.selectPlayer();
        };
        vm.chooseSpeaker = function (source) {
            vm.closeMenu();
            if (source.id === vm.speakerId || vm.busy) return;
            rememberView();
            vm.speakerId = source.id;
            vm.speakerName = source.name;
            rememberSource('speaker', source.id);
            vm.selectPlayer();
        };
        vm.loadSources = function (fresh) {
            if (vm.sourcesLoading) return;
            const menu = document.getElementById('widget-menu');
            if (fresh && menu?.contains(document.activeElement)) menu.focus();
            const request = ++sourceRequest;
            vm.sourcesLoading = true;
            discoveryList({action: 'listSources', fresh}, ({sources}) => {
                if (request === sourceRequest) vm.speakerSources = sources;
            }, () => request === sourceRequest && vm.menu === 'source').catch(error => {
                console.error('Unable to discover speaker sources:', error);
                update(() => { if (request === sourceRequest) showError(vm.labels.unavailable); });
            }).finally(() => update(() => {
                if (request !== sourceRequest) return;
                vm.sourcesLoading = false;
                if (vm.menu === 'source') updateMenu(Boolean(menu && document.activeElement === menu));
            }));
        };
        async function discoveryList(payload, apply, stillOpen) {
            const result = await Homey.api('POST', '/control', payload);
            update(() => {
                apply(result);
                if (stillOpen()) updateMenu(document.activeElement === document.getElementById('widget-menu'));
            });
            if (result.refreshing && stillOpen()) {
                const refreshed = await Homey.api('POST', '/control', {...payload, fresh: false, wait: true});
                update(() => apply(refreshed));
            }
        }
        vm.menuKey = function (event) {
            if (!vm.menu) return;
            const menu = document.getElementById('widget-menu');
            const trigger = document.getElementById(vm.menuTrigger());
            if (!menu || (!menu.contains(event.target) && event.target !== trigger)) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                vm.closeMenu();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                const items = menuItems(menu);
                if (!items.length) return;
                event.preventDefault();
                const index = items.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
                        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next].focus();
            } else if (event.key === 'Tab') {
                trigger?.focus();
                vm.closeMenu(false);
            }
        };
        function resetBrowser() {
            ++browseRevision;
            vm.path = [{id: '0', name: vm.labels.library}];
            vm.entries = [];
            vm.nextPage = null;
            vm.filter = '';
            vm.browsing = false;
        }
        resetBrowser();
        vm.showDetails = function () { document.getElementById('track-details').showModal(); };
        vm.closeDetails = function () { document.getElementById('track-details').close(); };
        vm.targetName = function () {
            return (vm.player?.currentTarget || vm.player?.defaultTarget)?.name || vm.labels.flow_only;
        };
        vm.reloadTargets = function (fresh) {
            if (vm.targetLoading || vm.busy) return;
            const request = ++targetRequest;
            const playerId = vm.playerId;
            const menu = document.getElementById('widget-menu');
            if (fresh && menu?.contains(document.activeElement)) menu.focus();
            vm.targetLoading = true;
            updateMenu();
            discoveryList({player: playerId, widget, action: 'listTargets', fresh}, ({targets}) => {
                if (request !== targetRequest || playerId !== vm.playerId) return;
                const saved = vm.player?.currentTarget;
                vm.targetChoices = saved && !targets.some(target => target.id === saved.id)
                    ? [...targets, saved] : targets;
            }, () => request === targetRequest && playerId === vm.playerId && vm.menu === 'speaker')
                .catch(function (error) {
                    console.error('Unable to discover playback targets:', error);
                    update(function () {
                        if (request === targetRequest && playerId === vm.playerId) showError(vm.labels.unavailable);
                    });
                }).finally(function () {
                    update(function () {
                        if (request !== targetRequest || playerId !== vm.playerId) return;
                        vm.targetLoading = false;
                        updateMenu(document.activeElement === menu && Boolean(menu));
                    });
                });
        };
        vm.chooseTarget = function (id, event) {
            if (vm.disabled()) return;
            if (id === (vm.player.currentTarget?.id ?? null)) return vm.closeMenu();
            rememberView();
            sendCommand({action: 'setTarget', value: id}, event);
        };
        vm.sleepOptions = [
            {id: 'deferred', label: vm.labels.sleepDeferred}, {id: 'off', label: vm.labels.sleepOff},
            {id: '15', label: vm.labels.sleep15}, {id: '30', label: vm.labels.sleep30},
            {id: '60', label: vm.labels.sleep60}, {id: 'track', label: vm.labels.sleepTrack}
        ];
        vm.sleepLabel = function () {
            return vm.sleepOptions.find(option => option.id === vm.sleepChoice)?.label || vm.labels.sleepOff;
        };
        vm.duration = function (ms) {
            const seconds = Math.floor(ms / 1000);
            return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        };
        let lastHeight = 0;
        function awaitingList() {
            return (vm.playlistOpen && vm.queueLoading) ||
                (vm.browserOpen && (vm.browsing || (revealOnRefresh && vm.loading)));
        }
        function height() {
            // A temporary shrink while swapping lists can clamp the dashboard's scroll position.
            if (disposed || (lastHeight && awaitingList())) return;
            const nextHeight = Math.ceil(document.querySelector('main').getBoundingClientRect().height);
            if (nextHeight === lastHeight) return;
            lastHeight = nextHeight;
            Homey.setHeight(nextHeight)
                .catch(function (error) { console.error('Unable to resize media widget:', error); });
        }
        function update(callback) {
            if (disposed) return;
            $scope.$evalAsync(function () {
                if (!disposed) callback();
            });
        }
        function dismissError() {
            clearTimeout(errorTimer);
            vm.errorPopup = null;
        }
        function showError(message, retry, error, background = false) {
            if (background && vm.errorPopup && !vm.errorPopup.background) return;
            const detail = (typeof error === 'string' ? error : error?.message)?.trim().slice(0, 360);
            const popup = {message, detail: detail !== message ? detail : '', retry, background};
            clearTimeout(errorTimer);
            vm.errorPopup = popup;
            errorTimer = setTimeout(() => update(() => {
                if (vm.errorPopup === popup) dismissError();
            }), 10000);
        }
        function showStateError(message) {
            if (message && stateError !== message) {
                showError(message, () => {
                    stateError = '';
                    vm.refresh();
                }, null, true);
            }
            stateError = message;
        }
        function dismissOnClick(event) {
            if (!vm.errorPopup || event.target.closest?.('[data-error-retry]')) return;
            const popup = vm.errorPopup;
            update(() => { if (vm.errorPopup === popup) dismissError(); });
        }
        vm.dismissError = dismissError;
        vm.retryError = function () {
            const retry = vm.errorPopup?.retry;
            dismissError();
            retry?.();
        };
        function stopPositionTimer() {
            if (positionTimer) $interval.cancel(positionTimer);
            positionTimer = null;
        }
        function applyPlayer(player) {
            const previousRoom = vm.roomTarget();
            const previousDevice = vm.deviceTarget();
            const contextChanged = player?.contextId && player.contextId !== vm.player?.contextId;
            if (player?.volume !== vm.player?.volume || player?.id !== vm.player?.id) {
                vm.volumeDraft = player?.volume == null ? 50 : Math.round(player.volume * 100);
            }
            vm.player = player;
            if (contextChanged) {
                const view = contextViews.get(player.contextId);
                const browserOpen = vm.browserOpen;
                resetBrowser();
                if (view?.path) vm.path = view.path.slice();
                else if (player.selection) vm.path.push(...player.selection.path);
                ++queueRevision;
                vm.queue = [];
                vm.queueOffset = 0;
                vm.queueNext = null;
                vm.queueLoading = false;
                vm.browserOpen = vm.canBrowse() && (view?.browserOpen ?? (browserOpen || vm.alwaysOpen));
                vm.playlistOpen = view?.playlistOpen ?? false;
                revealOnRefresh = vm.browserOpen;
            }
            if (previousRoom !== vm.roomTarget()) {
                resetRooms();
                vm.loadRooms();
            }
            if (previousDevice !== vm.deviceTarget()) {
                resetDevice();
                vm.loadDevice();
            }
            vm.sleepChoice = sleepChoice(player);
            positionSampleAt = Date.now();
            updatePosition();
            syncSpectrum();
            if (player?.playing && !document.hidden) {
                if (!positionTimer) positionTimer = $interval(updatePosition, 1000);
            } else stopPositionTimer();
            const artwork = player && player.artwork;
            if (artwork !== vm.requestedArtwork) {
                vm.requestedArtwork = artwork;
                vm.artwork = artwork;
                vm.artFailed = false;
            }
            vm.artworkFailed = function () {
                const fallback = vm.player?.artworkFallback;
                if (fallback && fallback !== vm.artwork) vm.artwork = fallback;
                else vm.artFailed = true;
            };
            function updatePosition() {
                if (!vm.player) {
                    vm.position = 0;
                    return;
                }
                const elapsed = Math.max(0, Date.now() - positionSampleAt);
                const position = (vm.player.position || 0) + (vm.player.playing ? elapsed : 0);
                vm.position = vm.player.duration ? Math.min(position, vm.player.duration) : position;
            }
        }
        function sleepChoice(player) {
            return player?.sleep?.mode === 'time' ? String(player.sleep.minutes)
                : player?.sleep?.mode === 'track' ? 'track' : player?.sleep?.mode === 'deferred' ? 'deferred' : 'off';
        }
        function revealPlayback() {
            if (!vm.browserOpen || !vm.canBrowse() || !revealOnRefresh || vm.playlistOpen) return;
            revealOnRefresh = false;
            const selection = vm.player && vm.player.selection;
            const view = contextViews.get(vm.player.contextId);
            vm.path = view?.path || [{id: '0', name: vm.labels.library}, ...(selection ? selection.path : [])];
            restoreFolder();
        }
        vm.folderPlaying = function () {
            const selection = vm.player && vm.player.selection;
            return Boolean(vm.player?.playing && selection && selection.folder && selection.path.at(-1)?.id === vm.folder().id);
        };
        vm.filePlaying = function (entry) {
            const selection = vm.player && vm.player.selection;
            return Boolean(selection && !entry.folder && entry.id === selection.file.id
                && (selection.path.at(-1)?.id ?? '0') === vm.folder().id);
        };
        vm.pinnedFile = function () {
            const file = vm.player && vm.player.selection && vm.player.selection.file;
            return file && !vm.filter && !vm.browsing && vm.filePlaying(file)
                && !vm.entries.some(vm.filePlaying) ? file : null;
        };
        function schedule() {
            clearTimeout(timer);
            if (refreshPending && !disposed && !document.hidden && !vm.loading && !vm.busy) {
                timer = setTimeout(vm.refresh, 50);
            }
        }
        function stateChanged(event) {
            if (disposed || document.hidden || !event?.player) return;
            if (vm.speakerId) {
                if (event.speaker !== vm.speakerId && event.player !== vm.player?.libraryPlayer) return;
            } else if (!event.playersChanged && vm.playerId && event.player !== vm.playerId) return;
            if (refreshPending) return;
            refreshPending = true;
            schedule();
        }
        function speakerChanged(event) {
            if (disposed || document.hidden || !event?.speaker) return;
            if (vm.speakerId === event.speaker) {
                refreshPending = true;
                schedule();
            } else if (vm.roomTarget() === event.speaker) {
                update(vm.loadRooms);
            }
        }
        vm.refresh = function () {
            if (disposed || vm.loading || vm.busy) return;
            clearTimeout(timer);
            clearTimeout(retryTimer);
            clearTimeout(nativeTimer);
            refreshPending = false;
            vm.loading = true;
            const request = ++revision;
            const id = vm.playerId;
            const speaker = vm.speakerId;
            const query = new URLSearchParams();
            if (speaker) query.set('speaker', speaker);
            else if (id) query.set('player', id);
            if (widget) query.set('widget', widget);
            Homey.api('GET', '/state' + (query.size ? '?' + query.toString() : ''), {})
                .then(function (state) {
                    update(function () {
                        if (request !== revision) return;
                        vm.players = state.players;
                        if (vm.menu) updateMenu();
                        if (state.player || !vm.player) applyPlayer(state.player);
                        if (speaker && state.player?.name) vm.speakerName = state.player.name;
                        vm.stale = Boolean(state.error);
                        if (vm.stale) stopPositionTimer();
                        showStateError(state.error);
                        retries = 0;
                        if (!speaker && !vm.playerId && vm.players.length === 1) {
                            vm.playerId = vm.players[0].id;
                        }
                        revealPlayback();
                        if (!speaker || vm.playlistOpen) refreshQueue();
                        if (!vm.roomsError) vm.loadRooms();
                        vm.loadDevice();
                    });
                }).catch(function (error) {
                    console.error('Unable to load media widget:', error);
                    update(function () {
                        if (request !== revision) return;
                        showStateError(vm.labels.loadError);
                        vm.stale = true;
                        stateError = '';
                        stopPositionTimer();
                        if (!speaker && retries < 3 && !document.hidden) {
                            retryTimer = setTimeout(vm.refresh, 2000 * 2 ** retries++);
                        }
                    });
                }).finally(function () {
                    update(function () {
                        if (request !== revision) return;
                        vm.loading = false;
                        schedule();
                        if (speaker && !document.hidden) nativeTimer = setTimeout(vm.refresh, vm.stale ? 2000 : 10000);
                    });
                });
        };
        vm.selectPlayer = function () {
            if (vm.menu) vm.closeMenu(false);
            ++revision;
            vm.loading = false;
            applyPlayer(null);
            vm.stale = true;
            resetBrowser();
            resetRooms();
            resetDevice();
            vm.configOpen = false;
            vm.recentOpen = false;
            vm.browserOpen = !vm.speakerId && vm.alwaysOpen;
            vm.playlistOpen = false;
            ++queueRevision;
            retries = 0;
            revealOnRefresh = true;
            refreshPending = true;
            vm.refresh();
        };
        function sendCommand(payload, event) {
            if (vm.busy || (!vm.playerId && !vm.speakerId)) return;
            const playerId = vm.playerId;
            const speakerId = vm.speakerId;
            let targetApplied = false;
            const pressed = event?.currentTarget;
            pressed?.classList.add('command-pending');
            pressed?.setAttribute('aria-busy', 'true');
            const enabledControls = document.querySelectorAll('.media :is(button, input):enabled');
            enabledControls.forEach(function (control) { control.classList.add('command-pending-enabled'); });
            clearTimeout(timer);
            ++revision;
            vm.loading = false;
            vm.busy = true;
            steppingVolume = payload.action === 'volumeUp' || payload.action === 'volumeDown';
            Homey.api('POST', '/control', Object.assign(vm.sourcePayload(), payload))
                .then(function (state) {
                    update(function () {
                        if (playerId !== vm.playerId || speakerId !== vm.speakerId) return;
                        applyPlayer(state.player);
                        targetApplied = payload.action === 'setTarget';
                        if (payload.action === 'volume') vm.volumeDraft = Math.round(state.player.volume * 100);
                        if (state.player?.controlRejected) {
                            showError(vm.labels.controlError);
                            volumeSteps.length = 0;
                        }
                        vm.stale = false;
                        revealPlayback();
                        if (!steppingVolume) refreshQueue();
                    });
                }).catch(function (error) {
                    console.error('Media widget control failed:', error);
                    update(function () {
                        if (playerId !== vm.playerId || speakerId !== vm.speakerId) return;
                        if (payload.action === 'setTarget') {
                            showError(vm.labels.apply_failed, null, error);
                            refreshPending = true;
                            return;
                        }
                        if (payload.action === 'volume') {
                            vm.volumeDraft = vm.player?.volume == null ? 50 : Math.round(vm.player.volume * 100);
                        }
                        if (payload.action === 'sleep') vm.sleepChoice = sleepChoice(vm.player);
                        showError(vm.labels.controlError, null, error);
                        vm.stale = true;
                        refreshPending = true;
                        volumeSteps.length = 0;
                    });
                }).finally(function () {
                    update(function () {
                        vm.busy = false;
                        steppingVolume = false;
                        enabledControls.forEach(function (control) { control.classList.remove('command-pending-enabled'); });
                        pressed?.classList.remove('command-pending');
                        pressed?.removeAttribute('aria-busy');
                        const next = volumeSteps.shift();
                        if (next && !vm.stale) {
                            sendCommand(next.payload, {currentTarget: next.button});
                            return;
                        }
                        if (payload.action === 'setTarget' && playerId === vm.playerId && vm.menu === 'speaker') {
                            if (targetApplied) vm.closeMenu();
                            else updateMenu(true);
                        }
                        schedule();
                        if (vm.speakerId && !document.hidden) {
                            clearTimeout(nativeTimer);
                            nativeTimer = setTimeout(vm.refresh, vm.stale ? 1000 : 10000);
                        }
                    });
                });
        };
        vm.volumeStepDisabled = function (action) {
            if (vm.stale || vm.player?.volume == null || vm.busy && !steppingVolume ||
                (vm.speakerId || vm.player.observing) && !vm.player.actions?.volume) return true;
            return !steppingVolume && (action === 'volumeUp' ? vm.player.volume >= 1 : vm.player.volume <= 0);
        };
        vm.command = function (action, value, event) {
            const payload = {action, value};
            if (action === 'volumeUp' || action === 'volumeDown') {
                if (vm.volumeStepDisabled(action)) return;
                payload.step = settings.volumeStep ?? 5;
                if (steppingVolume) volumeSteps.push({payload, button: event?.currentTarget});
                else sendCommand(payload, event);
            } else if (!vm.controlDisabled(action)) {
                sendCommand(payload, event);
            }
        };
        vm.setSleep = function (choice) {
            if (vm.disabled() || choice === 'deferred' || (choice === 'track' && !vm.player.duration)) return;
            vm.closeMenu();
            const value = choice === 'off' ? null : choice === 'track' ? 'track' : Number(choice);
            vm.command('sleep', value);
        };
        vm.folder = function () { return vm.path[vm.path.length - 1]; };
        function historyKey() { return (vm.player?.contextId || vm.playerId) + ':' + JSON.stringify(vm.path.map(item => item.id)); }
        function rememberView() {
            if (!vm.player?.contextId) return;
            if (vm.browserOpen) rememberFolder();
            contextViews.delete(vm.player.contextId);
            contextViews.set(vm.player.contextId, {path: vm.path.slice(), browserOpen: vm.browserOpen, playlistOpen: vm.playlistOpen});
            if (contextViews.size > 30) contextViews.delete(contextViews.keys().next().value);
        }
        function rememberFolder() {
            const filter = document.querySelector('#media-library input[type="search"]');
            if (filter) angular.element(filter).controller('ngModel')?.$commitViewValue();
            const list = document.querySelector('#media-library .library-list');
            browsingHistory.delete(historyKey());
            browsingHistory.set(historyKey(), {
                filter: vm.filter, scroll: list?.scrollTop || 0
            });
            if (browsingHistory.size > 30) browsingHistory.delete(browsingHistory.keys().next().value);
        }
        function restoreFolder() {
            const saved = browsingHistory.get(historyKey());
            vm.filter = saved?.filter || '';
            fetchFolder(0, saved?.scroll);
        }
        function fetchFolder(offset, scroll, append = false) {
            const request = ++browseRevision;
            const folder = vm.folder().id;
            retryFolder = () => fetchFolder(offset, scroll, append);
            browseFailed = false;
            if (!append) {
                vm.entries = [];
                vm.nextPage = null;
            }
            vm.browsing = true;
            Homey.api('POST', '/browse', {...vm.sourcePayload(), folder: folder, offset: offset, size: pageSize, filter: vm.filter})
                .then(function (result) {
                    update(function () {
                        if (request !== browseRevision) return;
                        vm.entries = append ? vm.entries.concat(result.items) : result.items;
                        vm.nextPage = result.next;
                    });
                }).catch(function (error) {
                    console.error('Unable to browse the UPnP server:', error);
                    update(function () {
                        if (request !== browseRevision) return;
                        browseFailed = true;
                        showError(vm.labels.browseError, vm.retryBrowse);
                    });
                }).finally(function () {
                    update(function () {
                        if (request !== browseRevision) return;
                        vm.browsing = false;
                        $scope.$$postDigest(function () {
                            const list = document.querySelector('#media-library .library-list');
                            if (request !== browseRevision || !vm.browserOpen || !list) return;
                            if (scroll != null) list.scrollTop = scroll;
                            else if (!append) scrollToCurrent(list);
                            if (vm.nextPage != null && (list.scrollHeight <= list.clientHeight ||
                                (scroll != null && list.scrollTop < scroll))) {
                                update(() => loadMoreFolder(scroll));
                            }
                        });
                    });
                });
        }
        vm.toggleBrowser = function () {
            vm.configOpen = false;
            vm.playlistOpen = false;
            vm.recentOpen = false;
            ++queueRevision;
            vm.browserOpen = vm.alwaysOpen || !vm.browserOpen;
            if (vm.browserOpen) {
                revealOnRefresh = true;
                if (vm.stale) vm.refresh();
                else revealPlayback();
            } else {
                ++browseRevision;
                vm.browsing = false;
            }
        };
        vm.back = function () { vm.jumpTo(vm.path.length - 2); };
        vm.openRecent = function (recent) {
            vm.recentOpen = false;
            vm.browserOpen = true;
            vm.path = [{id: '0', name: vm.labels.library}, ...recent.path];
            restoreFolder();
        };
        vm.folderPath = () => vm.path.map(crumb => crumb.name).join(' / ');
        vm.jumpTo = function (index) {
            if (index < 0 || index >= vm.path.length - 1) return;
            rememberFolder();
            vm.path = vm.path.slice(0, index + 1);
            restoreFolder();
        };
        function loadMoreFolder(scroll) {
            if (vm.browserOpen && vm.nextPage != null && !vm.browsing && !browseFailed) fetchFolder(vm.nextPage, scroll, true);
        }
        vm.filterChanged = function () {
            fetchFolder(0);
        };
        vm.clearFilter = function () { vm.filter = ''; vm.filterChanged(); };
        vm.retryBrowse = function () { retryFolder?.(); };
        vm.openEntry = function (entry, event) {
            if (entry.folder) {
                rememberFolder();
                vm.path.push(entry);
                restoreFolder();
            } else if (entry.playable) {
                sendCommand({action: 'playFrom', item: entry.id, folder: vm.folder().id, offset: entry.offset, size: entry.size, path: vm.path.slice(1)}, event);
            }
        };
        vm.playFile = function (entry, event) {
            sendCommand({action: 'playFile', item: entry.id, folder: vm.folder().id, offset: entry.offset, size: entry.size, path: vm.path.slice(1)}, event);
        };
        vm.playNext = function (entry, event) {
            sendCommand({action: 'playNext', item: entry.id, folder: vm.folder().id, offset: entry.offset, size: entry.size, path: vm.path.slice(1)}, event);
        };
        vm.showTrackActions = function (entry) {
            vm.actionEntry = entry;
            document.getElementById('track-actions').showModal();
        };
        vm.closeTrackActions = function () { document.getElementById('track-actions').close(); };
        vm.runTrackAction = function (action, event) {
            vm.closeTrackActions();
            if (action === 'next') vm.playNext(vm.actionEntry, event);
            else vm.playFile(vm.actionEntry, event);
        };
        vm.playFolder = function (event) {
            const current = vm.folder();
            const parent = vm.path[vm.path.length - 2];
            if (parent) sendCommand({action: 'playFolder', item: current.id, folder: parent.id, offset: current.offset, size: current.size, path: vm.path.slice(1, -1)}, event);
        };
        function refreshQueue() {
            if (!vm.playlistOpen || vm.queueLoading) return;
            const current = !vm.queueLoading && vm.queue?.find(item => item.current);
            const follow = current && queueCurrentVisible() ? {id: current.id, number: current.number} : null;
            fetchQueue(follow ? 'current' : vm.queueOffset, false, follow);
        }
        function scrollToCurrent(list, center = false) {
            const current = list.querySelector('[aria-current="true"]');
            if (!current) return;
            const top = list.getBoundingClientRect().top + list.clientTop;
            const row = current.getBoundingClientRect();
            if (center) list.scrollTop += row.top - top - (list.clientHeight - row.height) / 2;
            else if (row.top < top) list.scrollTop += row.top - top;
            else if (row.bottom > top + list.clientHeight) list.scrollTop += row.bottom - top - list.clientHeight;
        }
        function queueCurrentVisible() {
            const list = document.querySelector('.playlist-list');
            const current = list?.querySelector('[aria-current="true"]');
            if (!current) return false;
            const bounds = list.getBoundingClientRect();
            const row = current.getBoundingClientRect();
            const top = bounds.top + list.clientTop;
            return row.top >= top && row.bottom <= top + list.clientHeight;
        }
        function fetchQueue(offset, navigate, follow, extend = false) {
            const request = ++queueRevision;
            queueTarget = () => fetchQueue(offset, navigate, follow, extend);
            vm.queueLoading = true;
            if (navigate) {
                vm.queueError = '';
            }
            Homey.api('POST', '/playlist', {...vm.sourcePayload(), offset, size: queuePageSize})
                .then(function (result) {
                    update(function () {
                        if (request !== queueRevision) return;
                        if (follow && !queueCurrentVisible()) {
                            fetchQueue(vm.queueOffset || 0, false);
                            return;
                        }
                        const nextCurrent = result.items.find(item => item.current);
                        const currentChanged = follow && nextCurrent
                            && (follow.id !== nextCurrent.id || follow.number !== result.currentNumber);
                        const list = document.querySelector('.playlist-list');
                        const oldTop = list?.scrollTop || 0;
                        const oldHeight = list?.scrollHeight || 0;
                        const start = vm.queueOffset;
                        const end = start + vm.queue.length;
                        const incomingEnd = result.offset + result.items.length;
                        const merge = vm.queue.length && result.items.length && result.total === vm.queueTotal &&
                            result.shuffle === vm.queueShuffle && result.offset <= end && incomingEnd >= start &&
                            result.items.every(item => !vm.queue[item.number - start - 1] ||
                                vm.queue[item.number - start - 1].id === item.id);
                        const before = merge ? vm.queue.slice(0, Math.max(0, result.offset - start)) : [];
                        const after = merge ? vm.queue.slice(Math.max(0, incomingEnd - start)) : [];
                        vm.queue = before.concat(result.items, after).map(item =>
                            ({...item, current: item.number === result.currentNumber}));
                        vm.queueUnavailable = Boolean(result.unavailable);
                        vm.queueNext = after.length ? vm.queueNext : result.next;
                        vm.queueOffset = merge ? Math.min(start, result.offset) : result.offset;
                        vm.queueTotal = result.total;
                        vm.queueShuffle = result.shuffle;
                        vm.queueError = '';
                        $scope.$$postDigest(function () {
                            if (request !== queueRevision || !vm.playlistOpen) return;
                            const list = document.querySelector('.playlist-list');
                            if (!list) return;
                            if (merge && vm.queueOffset < start) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
                            if (offset === 'current' && navigate) scrollToCurrent(list, true);
                            else if (currentChanged) scrollToCurrent(list);
                            else if (!merge && (navigate || extend)) list.scrollTop = 0;
                        });
                    });
                }).catch(function (error) {
                    console.error('Unable to load playlist:', error);
                    update(function () {
                        if (request !== queueRevision) return;
                        if (!vm.queueError) showError(vm.labels.loadError, vm.retryQueue, null, !navigate);
                        vm.queueError = true;
                    });
                }).finally(function () {
                    update(function () {
                        if (request !== queueRevision) return;
                        vm.queueLoading = false;
                        $scope.$$postDigest(function () {
                            const list = document.querySelector('.playlist-list');
                            if (request === queueRevision && vm.playlistOpen && !vm.queueError && list &&
                                list.scrollHeight <= list.clientHeight && (vm.queueOffset || vm.queueNext != null)) {
                                update(() => loadMoreQueue(Boolean(vm.queueOffset)));
                            }
                        });
                    });
                });
        }
        vm.togglePlaylist = function () {
            vm.configOpen = false;
            vm.recentOpen = false;
            vm.playlistOpen = !vm.playlistOpen;
            if (vm.playlistOpen) {
                if (vm.browserOpen) rememberFolder();
                vm.browserOpen = false;
                ++browseRevision;
                vm.browsing = false;
                vm.queue = [];
                vm.queueUnavailable = false;
                vm.queueOffset = 0;
                vm.queueNext = null;
                fetchQueue('current', true);
            } else {
                ++queueRevision;
                if (vm.alwaysOpen && vm.canBrowse()) {
                    vm.browserOpen = true;
                    restoreFolder();
                }
            }
        };
        vm.toggleConfig = function () {
            vm.recentOpen = false;
            vm.configOpen = !vm.configOpen;
            if (vm.configOpen) {
                if (vm.browserOpen) rememberFolder();
                vm.browserOpen = vm.playlistOpen = false;
                ++queueRevision;
                ++browseRevision;
                vm.browsing = false;
                vm.loadRooms();
                vm.loadDevice();
            } else if (vm.alwaysOpen && vm.canBrowse()) {
                vm.browserOpen = true;
                restoreFolder();
            }
        };
        vm.toggleRecent = function () {
            if (vm.recentOpen) {
                vm.recentOpen = false;
                if (vm.alwaysOpen) {
                    vm.browserOpen = true;
                    restoreFolder();
                }
                return;
            }
            if (vm.browserOpen) rememberFolder();
            vm.recentOpen = true;
            vm.browserOpen = vm.playlistOpen = vm.configOpen = false;
            ++queueRevision;
            ++browseRevision;
            vm.browsing = false;
        };
        vm.roomTarget = function () {
            if (vm.speakerId) return vm.player?.protocol === 'sonos' ? vm.speakerId : null;
            const id = (vm.player?.currentTarget || vm.player?.defaultTarget)?.id;
            return typeof id === 'string' && id.startsWith('dlna:uuid:') ? id : null;
        };
        // Inputs and power of the selected source speaker or of the playback destination.
        vm.deviceTarget = function () {
            if (vm.speakerId) return vm.speakerId;
            const id = (vm.player?.currentTarget || vm.player?.defaultTarget)?.id;
            return typeof id === 'string' && /^(?:cast:|dlna:uuid:)/.test(id) ? id : null;
        };
        vm.device = {inputs: [], input: null, power: null, locked: false};
        function resetDevice() {
            ++deviceRequest;
            vm.device = {inputs: [], input: null, power: null, locked: false};
            confirmedInput = null;
            vm.deviceBusy = false;
        }
        vm.hasDeviceControls = () => Boolean(vm.device.inputs.length || vm.device.power);
        function deviceCall(payload) {
            const id = vm.deviceTarget();
            if (!id) return;
            const request = ++deviceRequest;
            if (payload.action !== 'deviceControls') vm.deviceBusy = true;
            Homey.api('POST', '/control', {speaker: id, widget, ...payload}).then(result => update(() => {
                if (request !== deviceRequest) return;
                vm.device = result;
                confirmedInput = result.input;
            })).catch(error => {
                console.error('Unable to control the device:', error);
                update(() => {
                    if (request !== deviceRequest) return;
                    vm.device.input = confirmedInput;
                    if (payload.action !== 'deviceControls') showError(vm.labels.controlError, null, error);
                });
            }).finally(() => update(() => {
                if (request !== deviceRequest) return;
                vm.deviceBusy = false;
                if (payload.action !== 'deviceControls') vm.refresh();
            }));
        }
        vm.loadDevice = function () {
            if (vm.configOpen && !vm.deviceBusy) deviceCall({action: 'deviceControls'});
        };
        vm.setInput = function (input) {
            if (!vm.deviceBusy && !vm.disabled() && input && input !== confirmedInput) deviceCall({action: 'setInput', value: input});
        };
        vm.togglePower = function () {
            if (!vm.deviceBusy && !vm.disabled() && vm.device.power) deviceCall({action: 'setPower', value: vm.device.power.on === false});
        };
        function resetRooms() {
            ++roomRequest;
            vm.rooms = [];
            vm.groupVolume = null;
            vm.roomCount = 0;
            vm.roomsLocked = vm.roomsLoading = false;
            vm.roomsSupported = undefined;
            vm.roomsError = false;
        }
        function roomPayload(payload) {
            return vm.speakerId ? {speaker: vm.speakerId, widget, ...payload}
                : {player: vm.player.id, widget, target: vm.roomTarget(), ...payload};
        }
        vm.loadRooms = function () {
            const summary = !vm.configOpen;
            if (!vm.roomTarget() || vm.roomsSupported === false || (summary && vm.speakerId) ||
                vm.roomsLoading || vm.groupBusy) return;
            const request = ++roomRequest;
            vm.roomsLoading = true;
            Homey.api('POST', '/control', roomPayload({action: 'listRooms', summary})).then(result => update(() => {
                if (request !== roomRequest) return;
                vm.roomsSupported = result.supported !== false;
                if (summary) vm.roomCount = result.roomCount || 0;
                else if (vm.roomsSupported) applyRooms(result);
                vm.roomsError = false;
            })).catch(error => {
                console.error('Unable to read Sonos rooms:', error);
                update(() => {
                    if (request !== roomRequest) return;
                    if (!summary) {
                        vm.roomsError = true;
                        showError(vm.labels.loadError, vm.loadRooms);
                    }
                });
            }).finally(() => update(() => {
                if (request !== roomRequest) return;
                vm.roomsLoading = false;
                if (summary && vm.configOpen) vm.loadRooms();
            }));
        };
        function applyRooms(result) {
            const previous = new Map(vm.rooms.map(room => [room.id, room]));
            vm.rooms = result.rooms;
            for (const room of vm.rooms) {
                const old = previous.get(room.id);
                room.level = old && old.volume === room.volume ? old.level : Math.round(room.volume * 100);
            }
            if (vm.groupVolume !== result.groupVolume) vm.groupLevel = Math.round(result.groupVolume * 100);
            vm.groupVolume = result.groupVolume;
            vm.roomCount = result.roomCount;
            vm.roomsLocked = result.locked;
        }
        function roomCommand(payload) {
            if (!vm.roomTarget() || !vm.roomsSupported || vm.groupBusy || vm.roomsLoading || vm.disabled()) return;
            if ((payload.action === 'joinRoom' || payload.action === 'leaveRoom') &&
                (vm.player.locked || vm.roomsLocked)) return;
            const request = ++roomRequest;
            vm.groupBusy = true;
            vm.busy = true;
            Homey.api('POST', '/control', roomPayload(payload))
                .then(result => update(() => {
                    if (request !== roomRequest) return;
                    vm.groupVolume = undefined;
                    vm.rooms = [];
                    applyRooms(result);
                }))
                .catch(error => {
                    console.error('Unable to change Sonos group:', error);
                    update(() => { if (request === roomRequest) showError(vm.labels.controlError, null, error); });
                }).finally(() => update(() => {
                    vm.groupBusy = false;
                    vm.busy = false;
                    vm.refresh();
                }));
        }
        vm.changeRoom = room => { if (room.editable) roomCommand({action: room.joined ? 'leaveRoom' : 'joinRoom', value: room.id}); };
        vm.setRoomVolume = room => roomCommand({action: 'roomVolume', room: room.id, value: room.level / 100});
        vm.setGroupVolume = () => roomCommand({action: 'groupVolume', value: vm.groupLevel / 100});
        function loadMoreQueue(previous) {
            if (!vm.playlistOpen || vm.queueLoading || vm.queueError) return;
            const offset = previous ? vm.queueOffset && Math.max(0, vm.queueOffset - queuePageSize) : vm.queueNext;
            if (offset != null && (!previous || vm.queueOffset)) fetchQueue(offset, false, null, true);
        }
        function scrollLists(event) {
            const list = event.target;
            const nearBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 48;
            if (list.matches?.('#media-library .library-list') && nearBottom) update(() => loadMoreFolder());
            else if (list.matches?.('.playlist-list')) {
                if (list.scrollTop <= 1 && vm.queueOffset) update(() => loadMoreQueue(true));
                else if (nearBottom) update(() => loadMoreQueue(false));
            }
        }
        vm.playQueueItem = function (item, event) {
            if (!vm.controlDisabled('playQueueItem') && !vm.queueLoading && !vm.queueError) {
                sendCommand({action: 'playQueueItem', item: item.id, number: item.number}, event);
            }
        };
        vm.retryQueue = function () { queueTarget?.(); };
        function visibility() {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            clearTimeout(nativeTimer);
            if (document.hidden) {
                stopPositionTimer();
                spectrum.cancel();
            }
            else update(function () {
                retries = 0;
                refreshPending = true;
                vm.refresh();
            });
        }
        document.addEventListener('visibilitychange', visibility);
        document.addEventListener('click', dismissOnClick, true);
        document.addEventListener('scroll', scrollLists, true);
        const resize = new ResizeObserver(function () {
            height();
            if (vm.menu) positionMenu();
        });
        // The final list can be the same height as its loading state (for example, on failure).
        $scope.$watch(awaitingList, pending => {
            if (!pending) $scope.$$postDigest(height);
        });
        resize.observe(document.querySelector('main'));
        function dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            clearTimeout(retryTimer);
            clearTimeout(nativeTimer);
            clearTimeout(errorTimer);
            stopPositionTimer();
            spectrum.cancel();
            document.removeEventListener('visibilitychange', visibility);
            document.removeEventListener('click', dismissOnClick, true);
            document.removeEventListener('scroll', scrollLists, true);
            if (realtime) {
                const remove = Homey.off || Homey.removeListener;
                if (typeof remove === 'function') {
                    remove.call(Homey, 'media_state_changed', stateChanged);
                    remove.call(Homey, 'speaker_state_changed', speakerChanged);
                }
            }
            resize.disconnect();
        }
        $window.addEventListener('pagehide', dispose, {once: true});
        $scope.$on('$destroy', dispose);
        document.documentElement.dir = /[\u0600-\u06ff]/.test(vm.labels.player) ? 'rtl' : 'ltr';
        if (realtime) {
            Homey.on('media_state_changed', stateChanged);
            Homey.on('speaker_state_changed', speakerChanged);
        }
        if (widget) {
            vm.loading = true;
            Homey.api('POST', '/control', {action: 'getSourcePreference', widget}).then(({source}) => {
                if (source?.kind === 'speaker') {
                    vm.speakerId = source.id;
                    vm.browserOpen = false;
                } else if (source?.kind === 'player') vm.playerId = source.id;
            }).catch(error => {
                console.error('Unable to restore widget source:', error);
                update(() => showError(vm.labels.loadError));
            }).finally(() => update(() => {
                vm.restoringSource = false;
                vm.loading = false;
                Homey.ready();
                vm.refresh();
            }));
        } else {
            Homey.ready();
            vm.refresh();
        }
    }]);

    window.onHomeyReady = function (Homey) {
        window.umpHomey = Homey;
        angular.bootstrap(document, ['umpMedia']);
    };
}());
