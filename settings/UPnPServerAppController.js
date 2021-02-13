angular.module('uPnPServerApp', [])
    .controller('UPnPServerAppController', function($scope) {
        var ctl = this;
        upnp.messages = '';
        upnp.selected = {};
        upnp.homey;

        upnp.setHomey = function(homey, scope) {
            upnp.homey = homey;
            homey.alert('UPnPServerAppController started');
            return;
            console.log('UPnPServerAppController.setHomey');
            upnp.homey.get('playlists', function(err, newPlaylists) {
                console.log(newPlaylists);
                if (!newPlaylists) {
                    newPlaylists = [];
                }
                scope.$apply(function() {
                    upnp.playlists = newPlaylists;
                });
            });
        
            upnp.homey.on('setting_changed', function(name) {
                upnp.homey.get('playlists', function(err, newPlaylists) {
                    console.log(newPlaylists);
                    if (!newPlaylists) {
                        newPlaylists = [];
                    }
                    $scope.$apply(function() {
                        upnp.playlists = newPlaylists;
                    });

                    console.log(upnp.playlists);
                });
            });
        }
        upnp.addPlaylist = function() {
            if (upnp.playlists && upnp.playlists.filter(function(e) { return e.name == upnp.newPlaylist.name; }).length > 0) {
                upnp.messages = "Playlist already exists.";
                return;
            }
            var playlist = {
                name: upnp.newPlaylist.name,
                remove: false
            };
            upnp.playlists.push(playlist);
            storePlaylist(angular.copy(upnp.playlists), playlist);
            upnp.messages = '';
            upnp.newPlaylist = {}
        };
        upnp.deleteAll = function() {
            upnp.playlists = [];
            upnp.homey.set('deleteAll', []);

        }
        upnp.removePlaylist = function(row) {
            var index = upnp.playlists.indexOf(row);
            var toDeletePlaylist = upnp.playlists[index];
            toDeletePlaylist.remove = true;
            upnp.playlists.splice(index, 1);
            storePlaylist(angular.copy(upnp.playlists), toDeletePlaylist);
        };

        function storePlaylist(playlists, playlist) {
            var changeObject = {
                playlists: playlists,
                playlist: playlist
            };

            upnp.homey.set('changedPlaylists', changeObject);
        }
    });
