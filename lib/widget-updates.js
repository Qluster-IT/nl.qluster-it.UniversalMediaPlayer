'use strict';

const pending = new WeakMap();

function notifyWidget(player, playersChanged = false) {
    const api = player?.homey?.api;
    if (typeof api?.realtime !== 'function') return;
    const queued = pending.get(player);
    if (queued) {
        if (playersChanged) queued.playersChanged = true;
        return;
    }
    const payload = {player: player.widgetPlayerId || player.getData().id};
    if (player.widgetTargetId) payload.speaker = player.widgetTargetId;
    if (playersChanged) payload.playersChanged = true;
    pending.set(player, payload);
    setImmediate(async () => {
        pending.delete(player);
        player.homey.app?.speakerUpdates?.emit('player', payload);
        try {
            await api.realtime('media_state_changed', payload);
        } catch (error) {
            player.error('Unable to notify media widget:', error);
        }
    });
}

module.exports = {notifyWidget};
