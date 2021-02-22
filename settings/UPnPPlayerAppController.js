angular.module('uPnPPlayerApp', ['smart-table'])
    .controller('UPnPPlayerAppController', function($scope) {
        var upnp = this;
        upnp.messages = '';
        upnp.selected = {};
        upnp.homey;

        upnp.setHomey = function(homey, scope, log) {
            upnp.homey = homey;
            upnp.log = function(s) { return log(s);}
            upnp.playlists = [];
            
            getPlaylistFromSettings();
        
            upnp.homey.on('setting_changed', function(name) {
                getPlaylistFromSettings();
            });

            function getPlaylistFromSettings() {
                upnp.log('getPlaylistFromSettings');
                upnp.homey.get('playlists', function(err, newPlaylists) {
                    upnp.log('getPlaylistFromSettings.result');
                    if (!newPlaylists) {
                        newPlaylists = [];
                    }
                    scope.$apply(function() {
                        upnp.playlists = newPlaylists;
                    });
                });
            }
        }
        upnp.addPlaylist = function() {
            try {                
                upnp.log('addPlaylist');
                if (upnp.playlists && upnp.playlists.filter(function(e) { return e.name == upnp.newPlaylist.name; }).length > 0) {
                    upnp.messages = "Playlist already exists.";
                    return;
                }
                var playlist = {
                    name: upnp.newPlaylist.name,
                    remove: false
                };
                upnp.playlists.push(playlist);
                storePlaylist(upnp.playlists, playlist);
                upnp.messages = '';
                upnp.newPlaylist = {}                
                upnp.log('addPlaylist done');
            } catch (error) {                           
                upnp.log('addPlaylist error: ' + error);
                upnp.messages = error;
            }
        };
        upnp.deleteAll = function() {
            upnp.playlists = [];
            storePlaylist(upnp.playlists);
        }
        upnp.removePlaylist = function(row) {
            var index = upnp.playlists.indexOf(row);
            upnp.playlists.splice(index, 1);
            storePlaylist(upnp.playlists);
        };

        function storePlaylist(playlists, playlist) {
            upnp.homey.set('playlists', angular.copy(playlists));
        }
    });
