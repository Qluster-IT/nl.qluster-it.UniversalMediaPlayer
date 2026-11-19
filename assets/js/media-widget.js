(function () {
    'use strict';

    const app = angular.module('umpMedia', []);
    app.directive('mediaArtwork', function () {
        return {
            link: function (scope, element) {
                function failed() {
                    scope.$applyAsync(function () { scope.vm.artFailed = true; });
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
    app.controller('MediaController', ['$scope', '$window', '$interval', function ($scope, $window, $interval) {
        const vm = this;
        const Homey = $window.umpHomey;
        const settings = Homey.getSettings();
        const realtime = typeof Homey.on === 'function';
        let timer;
        let refreshPending = false;
        let disposed = false;
        let revision = 0;
        let browseRevision = 0;
        let lastBrowseOffset = 0;
        let revealOnRefresh = true;
        let positionTimer;
        let positionSampleAt;
        let sourceTimer;
        let retryTimer;
        let retries = 0;
        let queueRevision = 0;
        let queueTarget;
        const browsingHistory = new Map();
        const pageSize = Number.isInteger(settings.pageSize) && settings.pageSize >= 1 && settings.pageSize <= 200
            ? settings.pageSize : 50;
        vm.pageSize = pageSize;
        const keys = ['player', 'selectPlayer', 'playing', 'paused', 'stopped', 'pause', 'nothingPlaying', 'duration',
            'controls', 'shuffle', 'previous', 'stop', 'play', 'next', 'repeat', 'startFlow',
            'noPlayers', 'retry', 'loadError', 'controlError', 'library', 'browsing',
            'emptyFolder', 'more', 'volume', 'volumeUp', 'volumeDown', 'mute', 'unmute', 'playFile', 'playFrom',
            'playlist', 'filter', 'clearFilter', 'previousPage', 'nextPage', 'details', 'close', 'stale',
            'loading', 'emptyPlaylist', 'noMatches', 'breadcrumbs', 'interrupted', 'recentFolders', 'playNext',
            'sleepTimer', 'sleepOff', 'sleep15', 'sleep30', 'sleep60', 'sleepTrack', 'sleepDeferred', 'trackActions'];
        vm.labels = Object.fromEntries(keys.map(function (key) { return [key, Homey.__('widget.' + key)]; }));
        vm.labels.back = Homey.__('browse.back');
        vm.labels.selectFolder = Homey.__('browse.selectFolder');
        vm.labels.browseError = Homey.__('browse.browseError');
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
        vm.playbackBlocked = function () { return vm.player?.sleep?.mode === 'deferred'; };
        vm.playbackStatus = function () {
            return vm.player?.interrupted ? vm.labels.interrupted : vm.player?.playing ? vm.labels.playing
                : vm.player?.paused ? vm.labels.paused : vm.labels.stopped;
        };
        vm.sourceName = function () {
            return vm.players.find(function (player) { return player.id === vm.playerId; })?.name || vm.labels.selectPlayer;
        };
        vm.closeSources = function () {
            clearTimeout(sourceTimer);
            const menu = document.getElementById('source-menu');
            if (menu?.contains(document.activeElement)) document.getElementById('player').focus();
            vm.sourcesOpen = false;
        };
        vm.toggleSources = function () {
            if (vm.sourcesOpen) return vm.closeSources();
            vm.sourcesOpen = true;
            sourceTimer = setTimeout(function () { update(vm.closeSources); }, 10000);
            $scope.$$postDigest(function () {
                const menu = document.getElementById('source-menu');
                const item = menu?.querySelector('[aria-checked="true"]') || menu?.querySelector('button');
                item?.focus();
            });
        };
        vm.chooseSource = function (id) {
            vm.closeSources();
            if (id === vm.playerId) return;
            vm.playerId = id;
            vm.selectPlayer();
        };
        vm.sourceKey = function (event) {
            if (!vm.sourcesOpen) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                vm.closeSources();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                const items = Array.from(document.querySelectorAll('#source-menu [role="menuitemradio"]'));
                if (!items.length) return;
                event.preventDefault();
                const index = items.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next].focus();
            } else if (event.key === 'Tab') {
                vm.closeSources();
            }
        };
        function resetBrowser() {
            ++browseRevision;
            vm.path = [{id: '0', name: vm.labels.library}];
            vm.entries = [];
            vm.nextPage = null;
            vm.pageHistory = [];
            vm.filter = '';
            vm.pageNumber = 1;
            vm.pageOffset = 0;
            vm.browserError = '';
            vm.browsing = false;
        }
        resetBrowser();
        vm.showDetails = function () { document.getElementById('track-details').showModal(); };
        vm.closeDetails = function () { document.getElementById('track-details').close(); };
        vm.duration = function (ms) {
            const seconds = Math.floor(ms / 1000);
            return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        };
        let lastHeight = 0;
        function height() {
            if (disposed) return;
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
        function stopPositionTimer() {
            if (positionTimer) $interval.cancel(positionTimer);
            positionTimer = null;
        }
        function applyPlayer(player) {
            if (player?.volume !== vm.player?.volume || player?.id !== vm.player?.id) {
                vm.volumeDraft = player?.volume == null ? 50 : Math.round(player.volume * 100);
            }
            vm.player = player;
            vm.sleepChoice = sleepChoice(player);
            positionSampleAt = Date.now();
            updatePosition();
            if (player?.playing && !document.hidden) {
                if (!positionTimer) positionTimer = $interval(updatePosition, 1000);
            } else stopPositionTimer();
            const artwork = player && player.artwork;
            if (artwork !== vm.artwork) {
                vm.artwork = artwork;
                vm.artFailed = false;
            }
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
            if (!vm.browserOpen || !vm.playerId || !revealOnRefresh || vm.playlistOpen) return;
            revealOnRefresh = false;
            const selection = vm.player && vm.player.selection;
            vm.path = [{id: '0', name: vm.labels.library}, ...(selection ? selection.path : [])];
            vm.pageHistory = [];
            vm.pageNumber = 1;
            vm.filter = '';
            fetchFolder(0);
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
            if (disposed || document.hidden || !event?.player
                || (!event.playersChanged && vm.playerId && event.player !== vm.playerId)) return;
            if (refreshPending) return;
            refreshPending = true;
            schedule();
        }
        vm.refresh = function () {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            if (disposed || vm.loading || vm.busy) return;
            refreshPending = false;
            vm.loading = true;
            const request = ++revision;
            const id = vm.playerId;
            Homey.api('GET', '/state' + (id ? '?player=' + encodeURIComponent(id) : ''), {})
                .then(function (state) {
                    update(function () {
                        if (request !== revision) return;
                        vm.players = state.players;
                        if (state.player || !vm.player) applyPlayer(state.player);
                        vm.stale = Boolean(state.error);
                        if (vm.stale) stopPositionTimer();
                        vm.error = state.error || '';
                        retries = 0;
                        if (!vm.playerId && vm.players.length === 1) {
                            vm.playerId = vm.players[0].id;
                        }
                        revealPlayback();
                        refreshQueue();
                    });
                }).catch(function (error) {
                    console.error('Unable to load media widget:', error);
                    update(function () {
                        if (request !== revision) return;
                        vm.error = vm.labels.loadError;
                        vm.stale = true;
                        stopPositionTimer();
                        if (retries < 3 && !document.hidden) {
                            retryTimer = setTimeout(vm.refresh, 2000 * 2 ** retries++);
                        }
                    });
                }).finally(function () {
                    update(function () {
                        if (request !== revision) return;
                        vm.loading = false;
                        schedule();
                    });
                });
        };
        vm.selectPlayer = function () {
            ++revision;
            vm.loading = false;
            applyPlayer(null);
            vm.stale = true;
            resetBrowser();
            vm.playlistOpen = false;
            ++queueRevision;
            retries = 0;
            revealOnRefresh = true;
            refreshPending = true;
            vm.refresh();
        };
        function sendCommand(payload, event) {
            if (vm.busy || !vm.playerId) return;
            const playerId = vm.playerId;
            const pressed = event?.currentTarget;
            pressed?.classList.add('command-pending');
            pressed?.setAttribute('aria-busy', 'true');
            const enabledControls = document.querySelectorAll('.media :is(button, select, input):enabled');
            enabledControls.forEach(function (control) { control.classList.add('command-pending-enabled'); });
            clearTimeout(timer);
            ++revision;
            vm.loading = false;
            vm.busy = true;
            Homey.api('POST', '/control', Object.assign({player: playerId}, payload))
                .then(function (state) {
                    update(function () {
                        if (playerId !== vm.playerId) return;
                        applyPlayer(state.player);
                        if (payload.action === 'volume') vm.volumeDraft = Math.round(state.player.volume * 100);
                        vm.error = '';
                        vm.stale = false;
                        revealPlayback();
                        refreshQueue();
                    });
                }).catch(function (error) {
                    console.error('Media widget control failed:', error);
                    update(function () {
                        if (playerId !== vm.playerId) return;
                        if (payload.action === 'volume') {
                            vm.volumeDraft = vm.player?.volume == null ? 50 : Math.round(vm.player.volume * 100);
                        }
                        if (payload.action === 'sleep') vm.sleepChoice = sleepChoice(vm.player);
                        vm.error = vm.labels.controlError;
                        vm.stale = true;
                    });
                }).finally(function () {
                    update(function () {
                        vm.busy = false;
                        enabledControls.forEach(function (control) { control.classList.remove('command-pending-enabled'); });
                        pressed?.classList.remove('command-pending');
                        pressed?.removeAttribute('aria-busy');
                        schedule();
                    });
                });
        };
        vm.command = function (action, value, event) {
            if (!vm.disabled()) {
                const payload = {action: action, value: value};
                if (action === 'volumeUp' || action === 'volumeDown') payload.step = settings.volumeStep ?? 5;
                sendCommand(payload, event);
            }
        };
        vm.setSleep = function () {
            const value = vm.sleepChoice === 'off' ? null : vm.sleepChoice === 'track' ? 'track' : Number(vm.sleepChoice);
            vm.command('sleep', value);
        };
        vm.folder = function () { return vm.path[vm.path.length - 1]; };
        function historyKey() { return vm.playerId + ':' + JSON.stringify(vm.path.map(item => item.id)); }
        function rememberFolder() {
            const list = document.querySelector('.library-list');
            browsingHistory.delete(historyKey());
            browsingHistory.set(historyKey(), {
                offset: vm.pageOffset, history: vm.pageHistory.slice(), filter: vm.filter, scroll: list?.scrollTop || 0
            });
            if (browsingHistory.size > 30) browsingHistory.delete(browsingHistory.keys().next().value);
        }
        function restoreFolder() {
            const saved = browsingHistory.get(historyKey());
            vm.filter = saved?.filter || '';
            vm.pageHistory = saved?.history.slice() || [];
            vm.pageNumber = vm.pageHistory.length + 1;
            fetchFolder(saved?.offset ?? 0, saved?.scroll);
        }
        function fetchFolder(offset, scroll) {
            const request = ++browseRevision;
            const folder = vm.folder().id;
            lastBrowseOffset = offset;
            vm.pageOffset = offset;
            vm.browserError = '';
            vm.browsing = true;
            Homey.api('POST', '/browse', {player: vm.playerId, folder: folder, offset: offset, size: pageSize, filter: vm.filter})
                .then(function (result) {
                    update(function () {
                        if (request !== browseRevision) return;
                        vm.entries = result.items;
                        vm.nextPage = result.next;
                        $scope.$$postDigest(function () {
                            const list = document.querySelector('.library-list');
                            if (!list) return;
                            list.scrollTop = scroll ?? 0;
                            const current = list.querySelector('[aria-current="true"]');
                            if (current && scroll == null && !offset) {
                                list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top;
                            }
                        });
                    });
                }).catch(function (error) {
                    console.error('Unable to browse the UPnP server:', error);
                    update(function () {
                        if (request === browseRevision) vm.browserError = vm.labels.browseError;
                    });
                }).finally(function () {
                    update(function () { if (request === browseRevision) vm.browsing = false; });
                });
        }
        vm.toggleBrowser = function () {
            vm.playlistOpen = false;
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
            rememberFolder();
            vm.path = [{id: '0', name: vm.labels.library}, ...recent.path];
            restoreFolder();
        };
        vm.jumpTo = function (index) {
            if (index < 0 || index >= vm.path.length - 1) return;
            rememberFolder();
            vm.path = vm.path.slice(0, index + 1);
            restoreFolder();
        };
        vm.nextLibraryPage = function () {
            if (vm.nextPage == null || vm.browsing) return;
            vm.pageHistory.push(vm.pageOffset);
            vm.pageNumber = vm.pageHistory.length + 1;
            fetchFolder(vm.nextPage);
        };
        vm.previousLibraryPage = function () {
            if (!vm.pageHistory.length || vm.browsing) return;
            const offset = vm.pageHistory.pop();
            vm.pageNumber = vm.pageHistory.length + 1;
            fetchFolder(offset);
        };
        vm.filterChanged = function () {
            vm.pageHistory = [];
            vm.pageNumber = 1;
            fetchFolder(0);
        };
        vm.clearFilter = function () { vm.filter = ''; vm.filterChanged(); };
        vm.retryBrowse = function () { fetchFolder(lastBrowseOffset); };
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
            if (!vm.playlistOpen) return;
            const current = !vm.queueLoading && vm.queue?.find(item => item.current);
            const follow = current && queueCurrentVisible() ? {id: current.id, number: current.number} : null;
            fetchQueue(follow ? 'current' : queueTarget, vm.queueLoading, follow);
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
        function fetchQueue(offset, navigate, follow) {
            const request = ++queueRevision;
            queueTarget = offset;
            if (navigate) {
                vm.queueLoading = true;
                vm.queueError = '';
            }
            Homey.api('POST', '/playlist', {player: vm.playerId, offset, size: pageSize})
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
                        const scroll = navigate || result.offset !== vm.queueOffset;
                        queueTarget = result.offset;
                        vm.queue = result.items;
                        vm.queueNext = result.next;
                        vm.queueOffset = result.offset;
                        vm.queueError = '';
                        if (scroll || currentChanged) $scope.$$postDigest(function () {
                            if (request !== queueRevision || !vm.playlistOpen) return;
                            const list = document.querySelector('.playlist-list');
                            if (!list) return;
                            const current = offset === 'current' && list.querySelector('[aria-current="true"]');
                            if (current && follow) {
                                const top = list.getBoundingClientRect().top + list.clientTop;
                                const row = current.getBoundingClientRect();
                                if (row.top < top) list.scrollTop += row.top - top;
                                else if (row.bottom > top + list.clientHeight) list.scrollTop += row.bottom - top - list.clientHeight;
                            } else {
                                list.scrollTop = current
                                    ? list.scrollTop + current.getBoundingClientRect().top - list.getBoundingClientRect().top
                                        - (list.clientHeight - current.offsetHeight) / 2
                                    : 0;
                            }
                        });
                    });
                }).catch(function (error) {
                    console.error('Unable to load playlist:', error);
                    update(function () { if (request === queueRevision) vm.queueError = vm.labels.loadError; });
                }).finally(function () {
                    update(function () { if (request === queueRevision) vm.queueLoading = false; });
                });
        }
        vm.togglePlaylist = function () {
            vm.playlistOpen = !vm.playlistOpen;
            if (vm.playlistOpen) {
                vm.browserOpen = false;
                ++browseRevision;
                vm.browsing = false;
                vm.queue = [];
                vm.queueOffset = 0;
                vm.queueNext = null;
                fetchQueue('current', true);
            } else {
                ++queueRevision;
                if (vm.alwaysOpen) {
                    vm.browserOpen = true;
                    restoreFolder();
                }
            }
        };
        vm.queuePage = function (next) {
            fetchQueue(next ? vm.queueNext : Math.max(0, vm.queueOffset - pageSize), true);
        };
        vm.playQueueItem = function (item, event) {
            if (!vm.disabled() && !vm.queueLoading && !vm.queueError) {
                sendCommand({action: 'playQueueItem', item: item.id, number: item.number}, event);
            }
        };
        vm.retryQueue = function () { fetchQueue(queueTarget, true); };
        function visibility() {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            if (document.hidden) stopPositionTimer();
            else update(function () {
                retries = 0;
                refreshPending = true;
                vm.refresh();
            });
        }
        document.addEventListener('visibilitychange', visibility);
        const resize = new ResizeObserver(height);
        resize.observe(document.querySelector('main'));
        function dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            clearTimeout(sourceTimer);
            clearTimeout(retryTimer);
            stopPositionTimer();
            document.removeEventListener('visibilitychange', visibility);
            if (realtime) {
                const remove = Homey.off || Homey.removeListener;
                if (typeof remove === 'function') remove.call(Homey, 'media_state_changed', stateChanged);
            }
            resize.disconnect();
        }
        $window.addEventListener('pagehide', dispose, {once: true});
        $scope.$on('$destroy', dispose);
        document.documentElement.dir = /[\u0600-\u06ff]/.test(vm.labels.player) ? 'rtl' : 'ltr';
        if (realtime) Homey.on('media_state_changed', stateChanged);
        Homey.ready();
        vm.refresh();
    }]);

    window.onHomeyReady = function (Homey) {
        window.umpHomey = Homey;
        angular.bootstrap(document, ['umpMedia']);
    };
}());
