// Original Code from https://github.com/dalhundal/sky-q


const { Defer } = require('./proto');
const {notifyWidget} = require('./widget-updates');
const DirectSpeakerSession = require('./direct-speaker-session');

const fetch = require('node-fetch');
const PLAYBACK_STORE_KEY = 'playback';
const SLEEP_STORE_KEY = 'sleepTimer';
const MODES = ['single', 'randomsingle', 'normal', 'randomnormal', 'repeat', 'randomrepeat'];


// const UPnPPlayerApp = require('./../app');
// const UPnPPlayerDevice = require('./../drivers/upnpplayer/device');
//const  http  = require('http.min');

class PlaylistManager {
    
    //get playing() { return true; }
    set playing(v) { 
        this._playing = v;
        this.PublishCapability('speaker_playing', v);
    }
    get playing() { 
        return Boolean(this._playing);
    }

    set albumUrl(v) {
        this._albumUrl = v;
        //console.log('albumUrl:' + v);
        if(this.image) {
            //console.log('setStream');
            if(v) this.image.setStream(async stream => {
                const res = await fetch(v, { timeout: 10000 });
                //console.log('setStream fetching: ' + res.ok);
                if (!res.ok) {
                  throw new Error('Invalid Response');
                }
              
                return res.body.pipe(stream);
              });
            else this.image.setUrl(null);
            //this.image.setUrl(v);
            this.image.update().catch(error => {
                this.uPnPPlayer.error('Unable to update album art:', error);
            });
        }
        //return this.uPnPPlayer.setCapabilityValue('speaker_album', v);        
    }
    set album(v) {         
        this.uPnPPlayer.setCapabilityValue('speaker_album', v || '');        
    }
    set artist(v) { 
        return this.uPnPPlayer.setCapabilityValue('speaker_artist', v || '');        
    }
    set track(v) { 
        return this.uPnPPlayer.setCapabilityValue('speaker_track', v || '');        
    }
    currentFile = undefined;
    playbackRevision = 0;
    startedAt = null;
    stoppedPosition = 0;
    

    //_playlists = [];
    // get playlists() { return this._playlists; }
    // set playlists(v) { this._playlists = v; }
    playlists = [];
    /**
     * 
     * @param {object} param 
     * @param {object} param.homey 
     * @param {import('../drivers/upnpplayer/device')} param.uPnPPlayer 
     */
    constructor({homey, uPnPPlayer}) {
        this.homey = homey;
        this.uPnPPlayer = uPnPPlayer;
        if(!this.image) {
            this.homey.images.createImage().then(async image=> {
                this.image = image;
                image.setUrl(null);
                await uPnPPlayer.setAlbumArtImage(this.image);
                if (this._albumUrl) this.albumUrl = this._albumUrl;
            }).catch(error => {
                uPnPPlayer.error('Unable to initialize album art:', error);
            });
        }
        //this.device=device;

        // setPlaylistFromSettings.call(this);

        // homey.settings.on('set', ((settingName) => {
        //     if(settingName=='playlists') setPlaylistFromSettings.call(this);
        // }).bind(this));


        // async function setPlaylistFromSettings() {            
        //     return this.playlists = await getPlaylistFromSettings();
        // }
        // async function getPlaylistFromSettings() {
        //     var playlists = await homey.settings.get('playlists');
        //     //console.log('getPlaylistFromSettings.playlists: ');
        //     //console.log(playlists);
        //     if(!playlists) playlists=[];
        //     return playlists;
        // }
    }

    get duration() {
        return positiveNumber(this.currentFile?.duration, 0);
    }

    get position() {
        const elapsed = this.startedAt === null || this.startedAt === undefined
            ? this.stoppedPosition || 0 : Date.now() - this.startedAt;
        return Math.max(0, this.duration ? Math.min(elapsed, this.duration) : elapsed);
    }

    PublishCapability(id, value) {
        Promise.resolve(this.uPnPPlayer.setCapabilityValue(id, value))
            .catch(error => this.uPnPPlayer.error(`Unable to update ${id}:`, error));
    }

    PublishTrack() {
        const file = this.currentFile;
        this.track = file?.name;
        this.artist = file?.artist;
        this.album = file?.album;
        this.albumUrl = file?.albumUrl;
        this.PublishCapability('speaker_duration', this.duration / 1000);
        this.PublishPosition();
    }

    PublishPosition() {
        const seconds = Math.floor(this.position / 1000);
        if (seconds === this.publishedPosition) return;
        this.publishedPosition = seconds;
        this.PublishCapability('speaker_position', seconds);
    }

    UpdatePositionTimer() {
        clearInterval(this.positionTimer);
        this.positionTimer = null;
        if (this.playing) this.positionTimer = setInterval(() => this.PublishPosition(), 5000);
    }

    SavePlayback(modeOnly = false) {
        notifyWidget(this.uPnPPlayer);
        if (typeof this.uPnPPlayer?.setStoreValue !== 'function') return;
        const snapshot = modeOnly && this.savedPlayback
            ? {...this.savedPlayback, mode: this.mode, order: this.order, customOrder: this.customOrder === true,
                recentFolders: this.recentFolders || []} : {
            version: 1,
            files: (this.files || []).map(({id, name, url, duration, artist, album, albumUrl, libraryPath, contentType}) =>
                ({id, name, url, duration, artist, album, albumUrl, libraryPath, contentType})),
            folder: this.folder ? {id: this.folder.id, libraryPath: this.folder.libraryPath} : null,
            index: this.files?.indexOf(this.currentFile) ?? -1,
            played: Object.keys(this.filesIndex || {}).filter(id => this.filesIndex[id].played),
            mode: this.mode || 'normal',
            order: this.order,
            customOrder: this.customOrder === true,
            startedAt: this.startedAt,
            paused: this.paused === true,
            restartOnSpeakerResume: this.restartOnSpeakerResume === true,
            position: this.stoppedPosition || 0,
            completion: this.completion,
            message: this.finishedMessage,
            continueAfterSingle: this.continueAfterSingle === true,
            recentFolders: this.recentFolders || []
        };
        this.savedPlayback = snapshot;
        this.pendingSave = Promise.resolve(this.pendingSave)
            .then(() => this.uPnPPlayer.setStoreValue(PLAYBACK_STORE_KEY, snapshot))
            .catch(error => this.uPnPPlayer.error('Unable to save playback state:', error));
        return this.pendingSave;
    }

    RestorePlayback() {
        const saved = this.uPnPPlayer.getStoreValue(PLAYBACK_STORE_KEY);
        const shuffle = this.uPnPPlayer.getCapabilityValue?.('speaker_shuffle') === true;
        const repeat = this.uPnPPlayer.getCapabilityValue?.('speaker_repeat') === 'playlist';
        this.mode = (shuffle ? 'random' : '') + (repeat ? 'repeat' : 'normal');
        this.startedAt = null;
        this.restartOnSpeakerResume = false;
        if (saved && (saved.version !== 1 || !Array.isArray(saved.files)
            || !saved.files.every(file => file && typeof file.id === 'string')
            || !Array.isArray(saved.played) || !MODES.includes(saved.mode)
            || !Number.isInteger(saved.index) || saved.index < -1 || saved.index >= saved.files.length)) {
            this.uPnPPlayer.error('Unable to restore an invalid playback snapshot.');
        } else if (saved) {
            this.savedPlayback = saved;
            if (saved.recentFolders != null && (!Array.isArray(saved.recentFolders)
                || !saved.recentFolders.every(validRecentFolder))) {
                this.uPnPPlayer.error('Unable to restore an invalid recent-folder history.');
            }
            this.recentFolders = Array.isArray(saved.recentFolders)
                ? saved.recentFolders.filter(validRecentFolder).slice(0, 100) : [];
            this.files = saved.files;
            this.folder = saved.folder;
            this.mode = saved.mode;
            this.customOrder = saved.customOrder === true;
            this.playingIndex = saved.index;
            this.currentFile = this.files[this.playingIndex];
            const played = new Set(saved.played);
            this.filesIndex = Object.fromEntries(this.files.map((file, index) =>
                [file.id, {index, file, played: played.has(file.id)}]));
            if (Array.isArray(saved.order) && saved.order.length === this.files.length
                && new Set(saved.order).size === this.files.length
                && saved.order.every(index => Number.isInteger(index) && index >= 0 && index < this.files.length)) {
                this.order = saved.order;
            } else this.BuildOrder(this.mode.startsWith('random'), true);
            if (!this.mode.startsWith('random') && !this.customOrder) this.BuildOrder(false);
            this.finishedMessage = saved.message;
            this.completion = saved.completion;
            this.continueAfterSingle = saved.continueAfterSingle === true;
            this.stoppedPosition = positiveNumber(saved.position, 0);
            this.paused = Boolean(this.currentFile && saved.paused && !saved.startedAt);
            this.restartOnSpeakerResume = this.paused && saved.restartOnSpeakerResume === true;
            if (this.currentFile && Number.isFinite(saved.startedAt) && saved.startedAt > 0) {
                this.startedAt = saved.startedAt;
            }
        }
        this.playing = this.startedAt !== null;
        this.PublishTrack();
        this.PublishMode();
        this.UpdatePositionTimer();
        const recoverDirect = this.HasDirectSession();
        this.RestoreSleep({defer: recoverDirect});
        const sleepDue = this.sleep?.mode === 'deferred'
            || this.sleep?.mode === 'time' && this.sleep.deadline <= Date.now();
        if (this.playing && !sleepDue && !recoverDirect) {
            this.ScheduleCompletion();
        }
    }

    async RecoverDirect() {
        if (!this.HasDirectSession()) return;
        try {
            if (this.uPnPPlayer.getStoreValue?.('directSpeakerSessionV1')?.notification) {
                this.CheckDirect(await this.DirectSession().recoverNotification());
            } else {
                const status = await this.DirectSession().status();
                this.CheckDirect(status, true);
                if (status.targets?.[0]?.handoff) {
                    await this.ApplySpeakerProgress(status.targets[0]);
                } else if (!status.targets?.length || status.targets.some(target => target.url !== this.currentFile?.url)) {
                    throw new Error('The saved direct playback no longer matches the current track.');
                }
                const target = status.targets[0];
                if (!target.handoff && this.playing && target.state === 'PLAYING' && Number.isFinite(target.position)) {
                    this.startedAt = Date.now() - Math.max(0, target.position);
                    this.PublishPosition();
                    await this.SavePlayback();
                }
            }
        } catch (error) {
            this.uPnPPlayer.error('Unable to verify direct playback after restart:', error);
            if (this.playing) {
                this.restartOnSpeakerResume = true;
                await this.MarkStopped(true);
            }
        }
        this.ScheduleSleep();
        const sleepDue = this.sleep?.mode === 'deferred'
            || this.sleep?.mode === 'time' && this.sleep.deadline <= Date.now();
        if ((this.playing || this.paused && this.directSession?.hasHandoff) && !sleepDue) this.ScheduleCompletion();
    }

    PublishMode() {
        this.PublishCapability('speaker_repeat', this.mode.endsWith('repeat') ? 'playlist' : 'none');
        this.PublishCapability('speaker_shuffle', this.mode.startsWith('random'));
    }

    MarkStopped(paused = false) {
        this.stoppedPosition = this.position;
        this.startedAt = null;
        this.paused = paused;
        if (!paused) this.restartOnSpeakerResume = false;
        this.playing = false;
        clearInterval(this.positionTimer);
        this.positionTimer = null;
        this.PublishPosition();
        return this.SavePlayback();
    }

    async PlayFile({file, message, finish, af}, resolve) {
        this.EnsureCanStart();
        const revision = this.InvalidatePlayback();
        const resolvedFile = await (resolve ? resolve() : this.uPnPPlayer.server.getFromLocation({item:file, search:'file'}));
        if (revision !== this.playbackRevision) return false;
        if (!resolvedFile) throw new Error(this.homey.__('playback.missingFile'));
        if (!resolvedFile.url) throw new Error(this.homey.__('playback.missingUrl'));
        this.folder = null;
        this.customOrder = false;
        this.continueAfterSingle = false;
        this.files = [resolvedFile];
        this.order = [0];
        this.filesIndex = {};
        if(this.files && this.files.length>0) this.filesIndex[this.files[0].id] = { index : 0, played : false, file:this.files[0] };
        return this.PlayNext({mode:'single', message:message, finish:finish, af:af});
    }

    async PlayNotification(file, {speaker, sonos_mode, volume, completion} = {}) {
        const target = speaker ?? this.PlaybackTarget();
        if (!target) throw new Error('Select a direct playback speaker or group for the notification player.');
        const resolved = await this.uPnPPlayer.server.getFromLocation({item: file, search: 'file'});
        if (!resolved?.url) throw new Error(this.homey.__('playback.missingFile'));
        if (this.playing || this.paused || this.playbackPending) {
            throw new Error('Use an idle player to play a notification.');
        }
        const mode = [sonos_mode, this.uPnPPlayer.getSetting?.('announcement_sonos_mode'),
            this.homey.settings?.get('sonosAnnouncementMode')].find(value => value === 'selected' || value === 'sync');
        this.CheckDirect(await this.DirectSession().playNotification(target, resolved, {
            mode, volume, completion,
            group: mode === 'sync' || this.uPnPPlayer.getSetting?.('announcement_group_sonos') !== false
        }));
        return true;
    }

    async PlayFolder({folder, mode, startFile}={}, resolve) {
        this.EnsureCanStart();
        const revision = this.InvalidatePlayback();
        const resolvedFolder = resolve ? await resolve()
            : folder ? await this.uPnPPlayer.server.getFromLocation({item:folder, search:'folders'}) : null;
        if (revision !== this.playbackRevision) return false;
        if ((folder || resolve) && !resolvedFolder) throw new Error(this.homey.__('playback.missingFolder'));
        let files = resolvedFolder ? await this.uPnPPlayer.server.browseById({id:resolvedFolder.id, search:'files'}) : null;
        if (revision !== this.playbackRevision) return false;
        if (resolve) {
            files = files.filter(file => file.url);
            if (!files.length) throw new Error(this.homey.__('widget.emptyFolder'));
        }
        const startIndex = startFile == null ? 0 : files?.findIndex(file => file.id === startFile);
        if (startFile != null && !(startIndex >= 0)) throw new Error(this.homey.__('playback.missingFile'));
        this.folder = resolvedFolder;
        this.customOrder = false;
        this.continueAfterSingle = false;
        this.files = files?.slice();
        this.filesIndex = {};
        this.playingIndex = startIndex - 1;
        if(this.files) this.files.forEach((f, index)=>this.filesIndex[f.id] = { index : index, played : false, file:f } );
        this.mode = mode;
        this.BuildOrder(Boolean(mode?.startsWith('random')));
        if (startFile != null && mode?.startsWith('random')) {
            this.order = [startIndex, ...this.order.filter(index => index !== startIndex)];
        }
        return this.PlayNext();
    }
    BuildOrder(shuffle, preservePlayed = false) {
        const indices = (this.files || []).map((_, index) => index);
        const played = preservePlayed ? indices.filter(index => this.filesIndex?.[this.files[index].id]?.played) : [];
        const remaining = preservePlayed ? indices.filter(index => !this.filesIndex?.[this.files[index].id]?.played) : indices;
        if (shuffle) {
            for (let i = remaining.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
        }
        this.order = [...played.filter(index => index !== this.playingIndex),
            ...played.filter(index => index === this.playingIndex), ...remaining];
    }

    NextShuffled(repeat) {
        if (!this.order) this.BuildOrder(true, true);
        let next = this.order.find(index => !this.filesIndex[this.files[index].id].played);
        if (next === undefined && repeat) {
            this.files.forEach(file => { this.filesIndex[file.id].played = false; });
            this.BuildOrder(true);
            next = this.order[0];
        }
        return next === undefined ? undefined : this.files[next];
    }

    PlayNext({mode, message, finish, af}={}) {        
        this.EnsureCanStart();
        this.continueAfterSingle = false;
        this.ClearTimer();
        this.ClearFinishedTimer();
        this.finishedMessage = message;
        if(!this.files || this.files.length==0 || !this.files[0]) return this.Stop({manual: false});
        mode = mode || this.mode || 'normal';
        const previous = this.currentFile;
        const previousIndex = this.playingIndex;
        this.currentFile = undefined;
        switch (mode) {
            case 'single':
                this.playingIndex=0;
                this.currentFile = this.files[0];
                break;
            case 'randomsingle':
                this.currentFile = pickRandom(this.files);
                this.playingIndex=this.files.indexOf(this.currentFile);                
                break;
            case 'normal':
                if (!this.order) this.BuildOrder(false);
                this.playingIndex = this.order[this.order.indexOf(this.playingIndex) + 1] ?? -1;
                this.currentFile = this.files[this.playingIndex];
                break;
            case 'randomnormal':
                this.currentFile = this.NextShuffled(false);
                this.playingIndex=this.files.indexOf(this.currentFile);
                break;
                case 'repeat':
                if (!this.order) this.BuildOrder(false);
                this.playingIndex = this.order[(this.order.indexOf(this.playingIndex) + 1) % this.order.length];
                this.currentFile = this.files[this.playingIndex];
                break;
            case 'randomrepeat':
                this.currentFile = this.NextShuffled(true);
                this.playingIndex=this.files.indexOf(this.currentFile);
                break;
            default:
                break;
        }
        if (!this.currentFile || !this.filesIndex[this.currentFile.id]) {
            this.currentFile = previous;
            this.playingIndex = previousIndex;
            return this.Stop({manual: false});
        }
        return this.Play({mode:mode, finish:finish, af:af});
    }
    PlayPrevious() {
        this.EnsureCanStart();
        if (!this.files || this.files.length === 0 || !this.currentFile) return false;
        this.continueAfterSingle = false;
        this.ClearTimer();
        this.ClearFinishedTimer();

        if (this.order) {
            const current = this.order.indexOf(this.playingIndex);
            const previous = current > 0 ? current - 1 : this.mode?.endsWith('repeat') ? this.order.length - 1 : 0;
            this.playingIndex = this.order[previous];
            if (this.mode?.startsWith('random')) {
                this.order.forEach((index, position) => {
                    this.filesIndex[this.files[index].id].played = position <= previous;
                });
            }
        } else if (this.playingIndex > 0) {
            this.playingIndex--;
        } else if (this.mode === 'repeat' || this.mode === 'randomrepeat') {
            this.playingIndex = this.files.length - 1;
        }
        this.currentFile = this.files[this.playingIndex];
        return this.Play({mode:this.mode});
    }
    PlayQueueItem(index) {
        this.EnsureCanStart();
        const file = this.files?.[index];
        if (!file?.url || !this.filesIndex?.[file.id]) throw new Error(this.homey.__('playback.missingFile'));
        this.continueAfterSingle = false;
        if (this.mode?.startsWith('random') && !this.mode.endsWith('single')) {
            const selected = this.order.indexOf(index);
            this.order.forEach((fileIndex, position) => {
                this.filesIndex[this.files[fileIndex].id].played = position < selected;
            });
        }

        this.playingIndex = index;
        this.currentFile = file;
        this.finishedMessage = undefined;
        return this.Play();
    }

    async QueueNext(file) {
        if (!this.currentFile || !file?.url || file.id === this.currentFile.id) {
            throw new Error(this.homey.__('widget.invalidAction'));
        }
        if (!this.order) this.BuildOrder(Boolean(this.mode?.startsWith('random')), true);
        let index = this.files.findIndex(item => item.id === file.id);
        if (index < 0) {
            index = this.files.length;
            this.files.push(file);
            this.filesIndex[file.id] = {index, file, played: false};
        }
        this.order = this.order.filter(item => item !== index);
        this.order.splice(this.order.indexOf(this.playingIndex) + 1, 0, index);
        this.customOrder = true;
        this.filesIndex[file.id].played = false;
        if (this.mode.endsWith('single')) {
            this.mode = this.mode.startsWith('random') ? 'randomnormal' : 'normal';
            this.continueAfterSingle = true;
            this.PublishMode();
        }
        await this.SavePlayback();
        await this.RefreshSpeakerQueue();
    }

    async Play({mode, message, finish, af}={}) {
        this.EnsureCanStart();
        if (!this.currentFile || !this.filesIndex || !this.filesIndex[this.currentFile.id]) return false;
        const revision = this.InvalidatePlayback();
        this.ClearTimer();
        this.ClearFinishedTimer();
        const file = this.currentFile;
        if (!positiveNumber(file.duration, 0)) {
            this.uPnPPlayer.log('The UPnP server did not provide a valid duration; playback timing may be inaccurate.');
        }
        mode = mode || this.mode || 'normal';
        this.mode = mode;
        let startedAt = Date.now();
        let triggered;
        const target = this.PlaybackTarget();
        this.playbackPending = revision;
        try {
            if (target) {
                this.directStarting = revision;
                this.CheckDirect(await this.DirectSession().start(target, file,
                    {...this.DirectOptions(), queue: this.SpeakerQueue()}), true);
                startedAt = Date.now();
                triggered = true;
                if (revision === this.playbackRevision && this.RunDirectFlows()) {
                    await this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(
                        this.uPnPPlayer, {url:file.url, duration:file.duration, name:file.name});
                }
            } else {
                if (this.HasDirectSession()) this.CheckDirect(await this.DirectSession().stop());
                triggered = await this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(
                    this.uPnPPlayer, {url:file.url, duration:file.duration, name:file.name});
            }
        } catch (error) {
            if (revision === this.playbackRevision) {
                if (target && this.HasDirectSession()) {
                    try {
                        this.CheckDirect(await this.DirectSession().stop());
                    } catch (restoreError) {
                        this.uPnPPlayer.error('Unable to restore speakers after playback failed:', restoreError);
                        error = new AggregateError([error, restoreError], 'Playback failed and speakers could not be restored.');
                    }
                }
                this.startedAt = null;
                this.stoppedPosition = 0;
                this.PublishTrack();
                await this.MarkStopped();
            }
            throw error;
        } finally {
            if (this.playbackPending === revision) this.playbackPending = null;
            if (this.directStarting === revision) this.directStarting = null;
        }
        if (revision !== this.playbackRevision) return false;
        if (triggered === false) {
            this.startedAt = null;
            this.stoppedPosition = 0;
            this.PublishTrack();
            await this.MarkStopped();
            this.uPnPPlayer.log('No flow handled this URL. Add a flow using the URL changed trigger.');
            return false;
        }
        this.filesIndex[file.id].played = true;
        this.startedAt = startedAt;
        this.paused = false;
        this.restartOnSpeakerResume = false;
        this.stoppedPosition = 0;
        this.completion = mode.endsWith('single') ? 'finish' : 'next';
        this.playing = true;
        this.RememberFolder(file);
        this.PublishTrack();
        this.PublishMode();
        this.UpdatePositionTimer();
        const completion = this.ScheduleCompletion({finish, af});
        if (completion) {
            this.SavePlayback();
            return completion;
        }
        await this.SavePlayback();
        if (revision !== this.playbackRevision) return false;
        if(af) return {url:file.url, duration:file.duration, name:file.name};
        else return this.playing;
    }

    async Stop({manual = true, sleep = false} = {}) {
        this.continueAfterSingle = false;
        const result = await this.EndPlayback({manual, paused: false});
        if (!sleep && this.sleep) await this.SetSleep(null);
        return result;
    }

    EnsureCanStart() {
        if (this.sleep?.mode === 'deferred' && this.paused && this.restartOnSpeakerResume) {
            throw new Error(this.homey.__('widget.sleepDeferred'));
        }
    }

    PlaybackTarget() {
        return this.uPnPPlayer.getStoreValue?.('ump_current_speaker')
            || this.uPnPPlayer.getStoreValue?.('announcement_speaker') || null;
    }

    DirectSession() {
        if (!this.directSession) {
            const playback = this.homey.app?.speakerPlayback;
            if (!playback) throw new Error('Direct speaker playback is unavailable.');
            this.directSession = new DirectSpeakerSession({
                playback, device: this.uPnPPlayer,
                log: message => this.uPnPPlayer.log(message)
            });
        }
        return this.directSession;
    }

    HasDirectSession() {
        return Boolean(this.directStarting || this.directSession?.journal?.units?.length
            || this.uPnPPlayer.getStoreValue?.('directSpeakerSessionV1')?.units?.length);
    }

    DirectOptions() {
        const volume = this.uPnPPlayer.getCapabilityValue?.('volume_set');
        return {
            restore: this.uPnPPlayer.getSetting?.('announcement_resume') !== false,
            restoreQueue: false,
            followGroup: true,
            group: this.uPnPPlayer.getSetting?.('announcement_group_sonos') !== false,
            ...(Number.isFinite(volume) && volume >= 0 && volume <= 1 ? {volume: volume * 100} : {})
        };
    }

    SpeakerQueue() {
        if (this.mode?.endsWith('single') || this.sleep?.mode === 'track' || this.RunDirectFlows() || !this.order?.length) return;
        const index = this.order.indexOf(this.playingIndex);
        if (index < 0) return;
        const repeating = this.mode?.endsWith('repeat');
        const repeat = repeating && this.order.length <= 33;
        const start = repeat ? 0 : Math.max(0, index - 8);
        const end = repeat ? this.order.length : index + 25;
        const window = this.order.slice(start, end);
        if (repeating && !repeat && end >= this.order.length) {
            window.push(...this.order.slice(0, Math.max(1, end - this.order.length)));
        }
        const items = window.map(i => ({...this.files[i], index: i}));
        if ((!repeat && items.length < 2) || !items.every(item => /^https?:\/\//i.test(item.url) && item.duration > 0)) return;
        return {items, index: index - start, repeat};
    }

    async RefreshSpeakerQueue() {
        if (!this.directSession?.hasHandoff || (!this.playing && !this.paused)) return;
        const target = this.PlaybackTarget();
        if (!target) return;
        const revision = this.InvalidatePlayback();
        this.ClearTimer();
        try {
            const result = await this.DirectSession().status();
            if (revision !== this.playbackRevision) return;
            this.CheckDirect(result, true);
            const state = result.targets[0];
            if (!['PLAYING', 'PAUSED_PLAYBACK'].includes(state.state)) throw new Error('The speaker is changing tracks; retry the queue edit.');
            await this.ApplySpeakerProgress(state);
            if (revision !== this.playbackRevision) return;
            const paused = this.paused;
            const position = state.position ?? this.position;
            this.CheckDirect(await this.DirectSession().start(target, this.currentFile,
                {...this.DirectOptions(), queue: this.SpeakerQueue(), position, queueOnly: true}), true);
            if (revision !== this.playbackRevision) return;
            if (paused) this.CheckDirect(await this.DirectSession().pause(), true);
            if (revision !== this.playbackRevision) return;
            this.stoppedPosition = position;
            this.startedAt = paused ? null : Date.now() - position;
            await this.SavePlayback();
        } finally {
            if (revision === this.playbackRevision && (this.playing || this.directSession?.hasHandoff)) this.ScheduleCompletion();
        }
    }

    async ApplySpeakerProgress(state) {
        const file = this.files?.[state.index];
        if (!file || state.url !== file.url || !['PLAYING', 'PAUSED_PLAYBACK'].includes(state.state)) return;
        const position = Number.isFinite(state.position) ? Math.max(0, state.position) : file === this.currentFile ? this.position : 0;
        if (this.currentFile === file && this.playing === (state.state === 'PLAYING') &&
            Math.abs(this.position - position) < 1500) return;
        this.currentFile = file;
        this.playingIndex = state.index;
        if (this.mode?.startsWith('random')) {
            const current = this.order.indexOf(state.index);
            this.order.forEach((index, i) => { this.filesIndex[this.files[index].id].played = i <= current; });
        } else this.filesIndex[file.id].played = true;
        this.playing = state.state === 'PLAYING';
        this.paused = !this.playing;
        this.restartOnSpeakerResume = false;
        this.stoppedPosition = position;
        this.startedAt = this.playing ? Date.now() - position : null;
        this.RememberFolder(file);
        this.PublishTrack();
        this.UpdatePositionTimer();
        await this.SavePlayback();
    }

    async CheckSpeakerProgress(revision) {
        try {
            const result = await this.DirectSession().status();
            if (revision !== this.playbackRevision) return;
            this.CheckDirect(result, true);
            const state = result.targets[0];
            if (state.finished) {
                if (this.sleep?.mode === 'track' || this.sleep?.mode === 'deferred') await this.ExecuteSleep();
                else await this.PlayNext();
                return;
            }
            await this.ApplySpeakerProgress(state);
            if (revision !== this.playbackRevision) return;
            if (this.playing && this.sleep?.mode === 'deferred') {
                await this.ExecuteSleep();
                return;
            }
        } catch (error) {
            if (revision !== this.playbackRevision) return;
            if (!this.restartOnSpeakerResume) {
                this.uPnPPlayer.error('Unable to verify the speaker queue:', error);
                this.restartOnSpeakerResume = true;
                await this.MarkStopped(true);
            }
        }
        if (revision === this.playbackRevision) this.SetTimer();
    }

    CheckDirect(result, requireActive = false) {
        if (!result?.ok || (requireActive && !result.active)) {
            const details = (result?.failures?.length ? result.failures : result?.skipped)?.map(item => item.message).join('; ');
            throw new Error(details || 'Direct speaker playback failed.');
        }
    }

    RunDirectFlows() {
        return !this.uPnPPlayer.getStoreValue?.('ump_current_speaker') &&
            this.uPnPPlayer.getSetting?.('trigger_when_announcing') === true;
    }

    async setPlaybackTarget() {
        const target = this.PlaybackTarget();
        if (!this.playing && !this.paused && !this.HasDirectSession()) return true;
        if (this.paused) {
            if (this.HasDirectSession()) this.CheckDirect(await this.DirectSession().stop());
            return true;
        }
        if (!this.currentFile) throw new Error(this.homey.__('playback.noCurrentFile'));
        const revision = this.InvalidatePlayback();
        this.ClearTimer();
        if (this.finishedTimerDeferred) {
            clearTimeout(this.finishedTimer);
            clearTimeout(this.finishedTimerDeferred.timer);
            this.suspendedCompletion = true;
        }
        try {
            if (target) {
                this.CheckDirect(await this.DirectSession().setTarget(target, this.currentFile,
                    {...this.DirectOptions(), queue: this.SpeakerQueue()}), true);
                if (this.RunDirectFlows() && revision === this.playbackRevision) {
                    await this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(this.uPnPPlayer,
                        {url: this.currentFile.url, duration: this.currentFile.duration, name: this.currentFile.name});
                }
            } else {
                if (this.HasDirectSession()) this.CheckDirect(await this.DirectSession().stop());
                const handled = await this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(this.uPnPPlayer,
                    {url: this.currentFile.url, duration: this.currentFile.duration, name: this.currentFile.name});
                if (handled === false) throw new Error(this.homey.__('widget.noPlayback'));
            }
        } catch (error) {
            if (revision === this.playbackRevision && this.playing) {
                this.restartOnSpeakerResume = true;
                await this.MarkStopped(true);
            }
            throw error;
        }
        if (revision !== this.playbackRevision) return false;
        this.startedAt = Date.now();
        this.stoppedPosition = 0;
        this.PublishPosition();
        this.ScheduleCompletion();
        await this.SavePlayback();
        return true;
    }

    async SaveSleep(value) {
        const previous = this.pendingSleepSave;
        const save = (async () => {
            if (previous) {
                try { await previous; }
                catch (error) { this.uPnPPlayer.error('Previous sleep timer save failed:', error); }
            }
            await this.uPnPPlayer.setStoreValue(SLEEP_STORE_KEY, value);
        })();
        this.pendingSleepSave = save;
        return save;
    }

    async SetSleep(value) {
        if (value !== null && value !== 'track' && ![15, 30, 60].includes(value)) {
            throw new Error(this.homey.__('widget.invalidAction'));
        }
        if (value === 'track' && (!this.currentFile || !this.duration)) {
            throw new Error(this.homey.__('widget.noCurrentDuration'));
        }
        const revision = this.sleepRevision = (this.sleepRevision || 0) + 1;
        const next = value === null ? null : value === 'track' ? {mode: 'track'}
            : {mode: 'time', minutes: value, deadline: Date.now() + value * 60000};
        try { await this.SaveSleep(next); }
        catch (error) {
            if (revision === this.sleepRevision) this.ScheduleSleep();
            throw error;
        }
        if (revision !== this.sleepRevision) return;
        const previous = this.sleep;
        this.sleep = next;
        this.ScheduleSleep();
        if (this.playing && (previous?.mode === 'track' || next?.mode === 'track')) {
            if (this.directSession?.hasHandoff) await this.RefreshSpeakerQueue();
            else if (this.completion === 'finish' && this.finishedTimerDeferred) {
                clearTimeout(this.finishedTimer);
                clearTimeout(this.finishedTimerDeferred.timer);
                this.suspendedCompletion = true;
                this.SetFinishedTimer();
            } else this.SetTimer();
        }
        notifyWidget(this.uPnPPlayer);
    }

    RestoreSleep({defer = false} = {}) {
        const saved = this.uPnPPlayer.getStoreValue?.(SLEEP_STORE_KEY);
        if (saved == null) return;
        if (saved.mode !== 'track' && saved.mode !== 'deferred'
            && !(saved.mode === 'time' && [15, 30, 60].includes(saved.minutes)
                && Number.isFinite(saved.deadline) && saved.deadline > 0)) {
            this.uPnPPlayer.error('Unable to restore an invalid sleep timer.');
            return;
        }
        this.sleep = saved;
        if (!defer) this.ScheduleSleep();
    }

    ScheduleSleep() {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
        const recoveringStop = this.sleep?.mode === 'deferred' && !(this.paused && this.restartOnSpeakerResume);
        if (this.sleep?.mode !== 'time' && !recoveringStop) return;
        const revision = this.sleepRevision;
        this.sleepTimer = setTimeout(() => {
            this.ExecuteSleep(revision).catch(error => this.uPnPPlayer.error('Unable to stop after sleep timer:', error));
        }, recoveringStop ? 0 : Math.max(0, this.sleep.deadline - Date.now()));
    }

    async ExecuteSleep(revision = this.sleepRevision) {
        if (!this.sleep || revision !== this.sleepRevision) return;
        if (this.paused && this.restartOnSpeakerResume) {
            const deferred = {mode: 'deferred'};
            const previous = this.sleep;
            this.sleep = deferred;
            try { await this.SaveSleep(deferred); }
            catch (error) {
                if (revision === this.sleepRevision) this.sleep = previous;
                throw error;
            }
            if (revision !== this.sleepRevision) return;
            notifyWidget(this.uPnPPlayer);
            return;
        }
        await this.Stop({sleep: true});
        if (revision !== this.sleepRevision) return;
        await this.SetSleep(null);
    }

    RememberFolder(file) {
        const path = file.libraryPath || this.folder?.libraryPath;
        if (!Array.isArray(path) || !path.length) return;
        const setting = this.uPnPPlayer.getSetting?.('recentFolderLimit');
        const limit = Number.isInteger(setting) && setting >= 0 && setting <= 100 ? setting : 10;
        const folder = path.at(-1);
        if (!folder?.id || !folder.name) return;
        if (!validRecentFolder({path})) {
            this.uPnPPlayer.error('Unable to remember an invalid recent-folder path.');
            return;
        }
        const key = JSON.stringify(path.map(part => part.id));
        this.recentFolders = [{path}, ...(this.recentFolders || []).filter(entry =>
            JSON.stringify(entry.path.map(part => part.id)) !== key)].slice(0, limit);
    }

    async ReportSpeakerPlayback({url, state}) {
        if (this.directSession?.hasHandoff) return; // Native status verifies the queue, not merely a reported URL.
        if (!this.currentFile || !['PLAYING', 'PAUSED_PLAYBACK', 'STOPPED', 'NO_MEDIA_PRESENT'].includes(state)) return;
        const owned = url === this.currentFile.url;
        const restartOnResume = !owned || state === 'STOPPED' || state === 'NO_MEDIA_PRESENT';
        if (owned && state === 'PLAYING') {
            if (!this.paused || this.playing) return;
            if (this.sleep?.mode === 'deferred') {
                await this.Stop({sleep: true});
                await this.SetSleep(null);
                return;
            }
            this.InvalidatePlayback();
            if (this.restartOnSpeakerResume) this.stoppedPosition = 0;
            this.restartOnSpeakerResume = false;
            this.startedAt = Date.now() - this.stoppedPosition;
            this.paused = false;
            this.playing = true;
            this.PublishPosition();
            this.UpdatePositionTimer();
            this.ScheduleCompletion();
            await this.SavePlayback();
        } else if (this.playing) {
            // Natural queue completion must still advance after Sonos reports STOPPED.
            if (owned && state === 'STOPPED' && this.duration > 0 && this.duration - this.position <= 2000) return;
            this.restartOnSpeakerResume = restartOnResume;
            this.InvalidatePlayback();
            this.ClearTimer();
            clearTimeout(this.finishedTimer);
            this.finishedTimer = null;
            if (this.finishedTimerDeferred) {
                clearTimeout(this.finishedTimerDeferred.timer);
                this.suspendedCompletion = true;
            }
            await this.MarkStopped(true);
        } else if (this.paused && restartOnResume && !this.restartOnSpeakerResume) {
            this.restartOnSpeakerResume = true;
            await this.SavePlayback();
        }
    }

    async Pause() {
        if (!this.playing) return false;
        return this.EndPlayback({manual: true, paused: true});
    }

    async EndPlayback({manual, paused}) {
        const revision = this.InvalidatePlayback();
        this.ClearTimer();
        this.ClearFinishedTimer();
        this.restartOnSpeakerResume = false;
        const saving = this.MarkStopped(paused);
        const player = this.uPnPPlayer;
        const triggers = player.driver.Triggers;
        try {
            const direct = this.HasDirectSession();
            if (direct) {
                const session = this.DirectSession();
                this.CheckDirect(await (paused ? session.pause() : session.stop()), paused);
            }
            const flowOnly = !direct && !this.PlaybackTarget();
            if (flowOnly || (direct && this.RunDirectFlows())) {
                const card = (paused ? triggers.paused_trigger : triggers.stopped_trigger).Card;
                await card.trigger(player);
            }
            const setting = paused ? 'silentPause' : 'silentStop';
            if (flowOnly && manual && revision === this.playbackRevision && player.getSetting?.(setting) === true) {
                const address = await this.homey.cloud.getLocalAddress();
                if (revision !== this.playbackRevision) return false;
                const local = new URL(`http://${address}`);
                const legacy = this.homey.platform === 'local' && this.homey.platformVersion === 1;
                const origin = legacy ? local.origin : `https://${local.hostname.replaceAll('.', '-')}.homey.homeylocal.com`;
                const prefix = legacy ? '' : '/app';
                const handled = await triggers.url_trigger.Card.trigger(player, {
                    url: `${origin}${prefix}/${this.homey.manifest.id}/assets/audio/silence.wav`,
                    duration: 500,
                    name: this.homey.__(paused ? 'widget.paused' : 'widget.stopped')
                });
                if (handled === false) throw new Error(this.homey.__('widget.noPlayback'));
            }
        } finally {
            await saving;
        }
        if (paused && this.directSession?.hasHandoff && revision === this.playbackRevision) this.SetTimer();
        return true;
    }    
    async TogglePlay(val) {
        if (val && this.paused && this.HasDirectSession()) {
            const revision = this.InvalidatePlayback();
            this.CheckDirect(await this.DirectSession().resume(), true);
            if (revision !== this.playbackRevision) return false;
            this.startedAt = Date.now() - this.stoppedPosition;
            this.paused = false;
            this.playing = true;
            this.PublishPosition();
            this.UpdatePositionTimer();
            this.ScheduleCompletion();
            await this.SavePlayback();
            return true;
        }
        if(val) return this.Play();
        else return this.Pause();
    }
    SetShuffle(val) {
        const shuffle = Boolean(val);
        const changed = shuffle !== Boolean(this.mode?.startsWith('random'));
        switch (this.mode) {
            case 'single':
            case 'randomsingle':
                this.mode = shuffle ? 'randomsingle' : 'single';
                break;
            case 'normal':
            case 'randomnormal':
                this.mode = shuffle ? 'randomnormal' : 'normal';
                break;
            case 'repeat':
            case 'randomrepeat':   
                this.mode = shuffle ? 'randomrepeat' : 'repeat';
                break;
            default:
                this.mode = shuffle ? 'randomnormal' : 'normal';
                break;
        }
        if (changed) {
            this.customOrder = false;
            this.BuildOrder(shuffle, shuffle);
        }
        return Promise.resolve(this.SavePlayback(true)).then(() => changed && this.RefreshSpeakerQueue());
    }    
    SetRepeat(val) {
        const shuffle = Boolean(this.mode && this.mode.indexOf('random') > -1);
        const single = Boolean(this.mode && this.mode.indexOf('single') > -1);
        switch (val) {
            case 'none':
                this.mode = (shuffle ? 'random' : '') + (single ? 'single' : 'normal');
                break;
            case 'track':
                this.mode = (shuffle ? 'random' : '') + 'single';
                break;
            case 'playlist':
                this.mode = (shuffle ? 'random' : '') + 'repeat';
                break;
        }
        return Promise.resolve(this.SavePlayback(true)).then(() => this.RefreshSpeakerQueue());
    }

    ScheduleCompletion({finish, af} = {}) {
        if (this.completion === 'finish') {
            const done = this.SetFinishedTimer({af});
            if (finish) return done;
            done.catch(error => {
                if (error.code !== 'PLAYBACK_CANCELLED') this.uPnPPlayer.error('Unable to finish playback:', error);
            });
        } else {
            this.SetTimer();
        }
    }

    RemainingTime() {
        const delay = this.sleep?.mode === 'track' ? 0 : positiveNumber(this.uPnPPlayer.getSetting('delay'), 1000);
        const elapsed = this.startedAt == null ? 0 : Math.max(0, Date.now() - this.startedAt);
        return Math.max(0, this.duration + delay - elapsed);
    }
    SetTimer() {
        this.ClearTimer();
        if(!this.currentFile) return;   
        if (this.directSession?.hasHandoff) {
            const revision = this.playbackRevision;
            this.timer = setTimeout(() => this.CheckSpeakerProgress(revision)
                .catch(error => this.uPnPPlayer.error('Unable to follow speaker playback:', error)), 1500);
            this.timer.unref?.();
            return;
        }
        this.timer = setTimeout(() => {
            const action = this.sleep?.mode === 'track' ? this.ExecuteSleep() : this.PlayNext();
            Promise.resolve(action).catch(error => this.uPnPPlayer.error('Unable to finish playback:', error));
        }, this.RemainingTime());
    }
    ClearTimer() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    SetFinishedTimer({af}={}) {
        const suspended = this.suspendedCompletion && this.finishedTimerDeferred;
        if (suspended) af = this.finishedTimerAF;
        else this.ClearFinishedTimer();
        if (!this.currentFile) return Promise.reject(new Error(this.homey.__('playback.noCurrentFile')));
        const remaining = this.RemainingTime();
        const file = this.currentFile;
        const message = this.finishedMessage;
        const defer = suspended || new Defer();
        defer.timer = setTimeout(() => defer.reject(new Error('Operation timed out')), remaining + 30000);
        this.suspendedCompletion = false;
        this.finishedTimerAF = af;
        this.finishedTimerDeferred = defer;
        this.finishedTimer = setTimeout(async () => {
            let claimed = false;
            try {
                const direct = this.HasDirectSession();
                if (direct && !this.continueAfterSingle && this.sleep?.mode !== 'track') {
                    this.CheckDirect(await this.DirectSession().stop());
                }
                if (direct ? this.RunDirectFlows() : !this.PlaybackTarget()) {
                    await this.uPnPPlayer.driver.Triggers.finished_trigger.Card.trigger(this.uPnPPlayer, {
                        hasMessage: !!message,
                        message: message || 'No message'
                    });
                }
                if (this.finishedTimerDeferred !== defer) return;
                this.finishedTimer = null;
                this.finishedTimerDeferred = null;
                claimed = true;
                await this.MarkStopped();
                if (this.sleep?.mode === 'track') {
                    this.continueAfterSingle = false;
                    await this.ExecuteSleep();
                }
                if (af) defer.resolve({url:file.url, duration:file.duration, name:file.name});
                else defer.resolve(true);
                if (this.continueAfterSingle) {
                    this.continueAfterSingle = false;
                    Promise.resolve(this.PlayNext()).catch(error => this.uPnPPlayer.error('Unable to play the next file:', error));
                }
            } catch (error) {
                if (!claimed && this.finishedTimerDeferred !== defer) {
                    this.uPnPPlayer.error('Unable to trigger finished playback:', error);
                    return;
                }
                this.finishedTimer = null;
                this.finishedTimerDeferred = null;
                await this.MarkStopped();
                defer.reject(error);
            }
        }, remaining);
        return defer.promise;
    }
    
    ClearFinishedTimer() {
        this.suspendedCompletion = false;
        this.finishedTimerAF = undefined;
        if (this.finishedTimer) clearTimeout(this.finishedTimer);
        this.finishedTimer = null;
        if (this.finishedTimerDeferred) {
            this.finishedTimerDeferred.reject(Object.assign(new Error(this.homey.__('playback.cancelled')), {
                code: 'PLAYBACK_CANCELLED'
            }));
            this.finishedTimerDeferred = null;
        }
    }

    InvalidatePlayback() {
        this.playbackRevision = (this.playbackRevision || 0) + 1;
        return this.playbackRevision;
    }

    Dispose() {
        this.InvalidatePlayback();
        this.ClearTimer();
        this.ClearFinishedTimer();
        clearInterval(this.positionTimer);
        clearTimeout(this.sleepTimer);
        return Promise.all([this.pendingSave, this.pendingSleepSave]);
    }
}

function pickRandom(items) {
    if (!items || items.length === 0) return undefined;
    return items[Math.floor(Math.random() * items.length)];
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function validRecentFolder(entry) {
    return Array.isArray(entry?.path) && entry.path.length > 0 && entry.path.length <= 64
        && entry.path.every(part => part && typeof part.id === 'string' && part.id.length > 0 && part.id.length <= 1024
            && typeof part.name === 'string' && part.name.length > 0 && part.name.length <= 1024);
}

module.exports = PlaylistManager;