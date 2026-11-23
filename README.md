Universal Media Player browses a UPnP server and provides file URLs for speakers or TVs.
The available folders depend on the server. Flow selections use the browsing path so
the app can find the file again if the server changes its ID.

## Playback setup

When pairing or repairing a Media Server (formerly UPnP Player), select a **Default playback speaker** to
play directly on Sonos, Google Cast or compatible UPnP/DLNA speakers and TVs, such as Samsung TVs. Save
speaker groups in the app settings to select several speakers together.
Select **Use Flows only** to keep playback
controlled by your existing Flows. Direct playback does not run the existing
playback Flow triggers unless you enable that option. You can also choose whether
to restore the previous source and position when direct playback ends, where supported.
Google Services announcements are not replayed; temporary Sonos grouping is
still undone.
Music playback does not resume a previously active Sonos queue.
**Temporarily group Sonos rooms** is on by default and synchronizes direct playback
across compatible selected Sonos rooms.

Use **Play a notification sound** on an idle Media Server to play a UPnP file
of up to 60 seconds. Choose a speaker or group on the card, or leave it blank
to use the player's target. **Continue** waits for confirmed playback;
**Wait to finish** also waits for completion and any necessary restoration.
Existing cards wait for completion.

- **Play Separately** uses Sonos AudioClip to play MP3 or WAV in the selected rooms
  without replacing their queue or changing their group. Rooms may start at
  different times. Unsupported rooms report a failure instead of regrouping.
- **Play in Sync** uses the managed playback path and temporarily groups eligible
  selected Sonos rooms. UMP restores their original grouping and source afterward.

The Flow choice overrides the device setting, which overrides **App Settings → Speakers**.
If none is explicitly set, UMP keeps the previous grouping behavior. The settings
don't affect ordinary media playback. Optional router DHCP reservations let
Play Separately reuse verified Sonos addresses and avoid repeat network scans.

For Flow-controlled playback:

1. Add a Media Server and select a file or folder in a Flow card.
2. Create a Flow with **Playback URL changed** as the trigger.
3. Add your speaker's play-URL action and use the trigger's **URL** tag.

In this mode, the player sends URLs rather than controlling the speaker itself. **Pause** freezes the
position and fires **Playback paused**. The separate **Stop** button fires
**Playback stopped**. Connect those triggers to the corresponding actions on
your speaker. Pressing Play sends the current URL again and starts the track
from the beginning.

The **Playback duration elapsed** trigger and waiting cards use the duration
reported by the UPnP server plus the configured delay. Duration tags are in
milliseconds. If the server does not provide a valid duration, timing and
automatic folder advancement may be inaccurate.

Thanks for Johan Bendz for the excellent images and icons!

## Playback devices

Add a **Playback Device** to give a Sonos, Google Cast or UPnP/DLNA speaker or TV its own Homey
device. It shows what is playing and offers the controls that speaker supports, such as play/pause,
stop, next/previous, shuffle, repeat, volume and mute; controls appear once the speaker supports them.
TVs are added with the TV device class.
When a Media Server plays on the device, the device controls that playlist. Paired devices use their
Homey name in speaker lists and stay selectable as a playback target or widget source.

Samsung TVs also get an on/off button. Off works like the remote's power button (a Frame switches to
art mode, which shows as off); a TV that is fully off is switched on over the network (Wake-on-LAN).
Some Frames don't always report whether they show art. When they don't, on/off presses the power button once, like the
remote, and the button keeps its previous state.
The first time, the TV asks to allow **Universal Media Player**; choose Allow on the TV.

**Turn on and off automatically** (off by default) is for announcements. If the TV is off, UMP turns it
on first, plays the announcement and turns it off again afterwards; a TV that was already on stays on.
Music never turns a TV on: switch it on yourself. Set it in the device settings for an announcement
to that device, per speaker in a saved group, or in the app settings (**Speakers**) for **All speakers**.
The **All speakers (no TVs)** choices never turn anything on. A TV that doesn't respond is woken, but
only turned off again if it was seen in standby while waking. UMP can't see someone watching TV or HDMI:
if you start watching during an announcement that turned the TV on, it still turns off afterwards.

Devices with selectable inputs get Homey's **Input** control, with only the inputs that device has.
It works on the device, in Homey's standard input Flow cards and in the widget. Sonos soundbars
(Arc, Beam, Ray, Playbar, Playbase, Amp) switch to **TV** (HDMI ARC or optical); Sonos models with
a line-in (such as Five, Play:5, Port and Connect) switch to **Line-in**. **Music** switches back to the
Sonos queue. TV audio is only played by the soundbar itself, so a grouped soundbar leaves its group;
a line-in plays on the whole group. Samsung TVs switch to TV or HDMI 1–4 with remote keys while the
TV is on. The TV doesn't report its current input: the widget doesn't show one, and the device shows
the last input selected through Homey. Not every model has every HDMI input.
An input can't be changed while a Media Server plays on the device. This only applies within one Homey:
UMP on another Homey doesn't know about that playback and can still change the input.

## Dashboard widget

Add **Media player** to a Homey dashboard, select a Media Server, and choose
Compact or Large. The widget shows the player, artwork, track, artist, album,
and estimated playback time, with previous, play/pause, stop, next, shuffle, and playlist
repeat controls. A read-only progress bar appears when the track duration is known.
Compact uses tighter vertical spacing and shows elapsed and total time alongside the artwork.
Click the artwork to show a spectrum of the playing track; click it again to return to the artwork.
Each widget remembers this choice. The spectrum follows UMP playback: the widget analyses the
same file through Homey without playing sound, so it uses extra network traffic. It isn't available
for playback that UMP doesn't control. The Visualizer widget setting chooses No visualizer, Light
(for older tablets), Normal or Detailed. Light uses fewer bars and less data; Detailed is smoother
and suits fast devices.
On narrow screens, Compact keeps open lists shorter; swipe within a list to see more entries.
When available, the track number and total appear below the position bar, opposite the playback time.
Play/Pause is blue, and active Shuffle, Repeat, and Library buttons are tinted.
While a command runs, circular controls show a spinner and a highlight travels
around rectangular buttons without rotating their outline. With reduced motion
enabled, the indicators stay still.
The widget has minus and plus buttons beside its volume slider and a Mute icon alongside the playback buttons,
with Play/Pause in the center. The volume slider has a white handle in light and dark mode. **Volume step (%)** sets how much the widget's
minus and plus buttons change the volume (5% by default). Only Large shows the
volume percentage next to the slider and the playback status in the header.
Compact uses smaller volume-button circles while keeping their touch targets.
The source button on the left opens a menu inside the widget. Choose a UMP
player to browse its library, or choose a discovered speaker to control what it
is already playing. Each widget remembers its last selected source. Selecting a speaker does not start playback, replace the
queue, or change the UMP player’s default destination. **Playlist** shows the
speaker’s own queue when the device exposes it. Sonos radio and many DLNA and
Cast sessions do not expose a queue. Playback controls are enabled according to
what the current session supports.

In Sonos speaker mode, the widget shows **TV audio** or **Line-In** when the
speaker reports that input. For TV audio, it also shows the incoming format
when the soundbar reports a recognized one. It cannot identify the device or HDMI port selected
on the TV itself. Open **Config** to see the current group, its
coordinator, and rooms in other groups. You can add a standalone room or remove
an eligible room from the current group. The widget does not dismantle other
groups, separate stereo pairs, or interrupt a speaker that UMP is managing.
The header shows the coordinator and room count for grouped playback. **Group
volume** changes the whole group; the sliders next to room names change only
those rooms. These controls are shown when the speaker exposes them.
You can also open **Config → Group rooms** while using a UMP library: select an
individual Sonos room as the playback target (or use it as the device default).
Changing the live Sonos group does not change the selected source or target.
While a Media Server plays to that Sonos group, its own widget can still add and remove rooms; the
playback continues with the new group. Rooms playing for another Media Server on the same Homey stay locked.
**Config** also shows **Input** and **Power** for the selected source or destination when the device
supports them. Power and Samsung inputs require the TV to be added as a Playback Device.

Speaker mode listens for playback updates on compatible Sonos and DLNA devices
and still checks periodically if a notification is missed. Update subscriptions
automatically reconnect when Homey's local IP address changes. Homey can serve
artwork hosted by the selected speaker when a dashboard cannot reach it directly.
Compatible TVs show their model when available and expose media controls for
DLNA playback. For supported Samsung TVs discovered on the local network, the
widget also reads power state, resolution and operating system without pairing.
Select the TV as the source and tap its name to see available network type,
firmware and supported features. A TV that stops responding is not assumed to be
off. These readings do not identify the TV's current HDMI input, tuner channel,
or streaming app. To switch a Samsung TV on or off, add it as a Playback Device.
Some TVs report volume and mute but reject changes outside a DLNA session.
Use the TV remote or select the soundbar as the source if it handles the audio.

When UMP starts a playlist on a compatible Sonos or Cast destination, it gives
the speaker a queue in UMP’s playback order so the speaker’s own Next and
Previous controls can be used. UMP follows the speaker’s current track.
With playlist Repeat on, Next at the last track wraps to the beginning.
Compatible DLNA renderers receive the upcoming track, while UMP retains the
playlist. Single files, notifications, and independently playing destinations
continue to use UMP playback control.
Stopping ordinary music does not resume a previous music track or queue.
Notifications retain their separate speaker-restoration behavior.
Shuffle and Repeat edits on DLNA update the upcoming track without restarting
the current one. Video playback requires a format supported by the destination
and an accessible media URL; a server can still list files whose URLs no longer
exist.

The **Playback speaker** button on the right opens a matching menu. Choose a
speaker or group to select it, without stopping the previous destination,
starting music on the new one, or changing the paired default. Each widget
remembers its own destination. Playback and queues continue independently;
switching back restores control and the destination's Library location.
Use **Reload** to refresh the list.
Ordinary playback to a single Sonos destination uses its existing group without
regrouping. A group icon next to the destination shows when it has multiple
rooms. Use **Config → Group rooms** to adjust the group or individual room
volumes during playback. Stop UMP playback before changing group membership.
Widget errors appear at the top for 10 seconds, or
until you click the popup or elsewhere in the widget.
Widget and setup speaker pickers show the last discovered devices while Homey checks
the local network in the background. Flow-card autocomplete returns a recent scan
or waits for a new one, since Homey cannot update that list after it is returned.
The picker cache survives app restarts, but a cached entry doesn't guarantee that
the speaker is still online. UMP remembers Sonos and UPnP/DLNA addresses across
restarts. On first use after a restart it verifies the saved address directly,
then reuses the result while refreshing discovery in the background. Individual Sonos
playback can rediscover the same room and retry once if the connection failed before
any playback-changing command could reach it. Once a command may have arrived,
UMP reports the failure without replaying it and leaves normal recovery in charge. Google Cast
still uses discovery to identify its receivers. The picker itself stores no addresses.
Choose **Use device default** to clear the override. If no speaker is configured,
the player can still use existing Flows.
Controls stay visually steady while a command is being sent.
When a selected speaker is playing UMP's queue, its Library, Playlist and
transport controls use the owning UMP player, even when another widget started
playback. Existing native playback can be controlled without loading media;
choosing a Library track explicitly starts UMP playback.
Room volume and mute stay adjustable during playback.
Windows media renderers' typed playback and volume responses are supported; their
successful Stop can leave the renderer paused at the beginning while UMP is stopped.
UMP also recognizes their verified track completion so retained playlists keep
advancing, without treating ordinary pauses as finished tracks.
When switching between Library and Playlist, the widget keeps its previous
height until the incoming list is ready to avoid jumping up the dashboard.
The widget refreshes when Homey reports playback or volume changes, including
changes from Flows. It also refreshes when opened or brought back into view,
without polling in the background.
Renaming a player in Homey updates its name in the widget and source list immediately.
The Homey device also provides Volume, Volume Up,
Volume Down, and Mute, with built-in Flow actions for each control. Up and Down
adjust the current volume by five percentage points, between 0% and 100%.
Set or sync the volume once before using these buttons on a new device. Connect the
Homey built-in **The volume changed** and the app’s **Mute change requested**
triggers to your speaker actions. The volume token uses Homey's 0–1 scale
(0.25 is 25%). Use **Report
speaker volume or mute state** to feed back the speaker's Volume or Muted tag;
leave either field blank to keep that value unchanged. When using two-way volume
sync, only send a volume command if the speaker’s current volume differs from
the player’s volume. Volume feedback can fire the built-in trigger; mute feedback
doesn't fire the custom mute request trigger.

To follow Sonos playback, connect its **Stopped playing**, **Started playing**,
**The track changed**, and **Sound input changed** triggers to **Sync playback
from a Sonos speaker**, entering that speaker's local IP address. This reads the
actual playback URL (also through a group coordinator), not the track title.
Pausing Sonos freezes this player's timer; resuming our track restarts the timer
without sending the URL again. Other tracks or inputs temporarily suspend our queue,
without clearing it. Announcements can restore the original track afterward;
when Sonos reports it playing again, our queue resumes automatically with the
track timer reset to zero, matching the restarted song. Ordinary pause/resume
keeps the previous position.
Restored Sonos radio-stream URLs are recognized as the original track too.
Feedback never sends Pause, Play, silent audio, or shuffle commands to Sonos.
The estimated position remains an estimate; Sonos position is not imported.
No Homey-wide API permissions are required.

Open **Library** (folder icon) to browse the selected server. If there is a current
or last-played track, the library opens at its folder and highlights the file.
Tap a track to play the folder from that track onward. Open the actions beside
a track and choose **Play this file only**, or choose **Play this folder** to
start at the beginning. The folder-play icon starts the folder, and the back
arrow returns to its parent. In the widget settings, choose whether the library opens with a button
or stays visible. With a playback speaker selected, tracks play directly on
that target. In Flow-only mode, **Playback URL changed** still sends the file
URL to your Flow.

The Library fits up to four rows in both layouts. Scroll to load more entries automatically.
**Items per page** controls how many entries load at a time (50 by default, from 1 to 200),
not how many rows are visible. Filtering searches the whole current folder, including entries
not loaded yet. Returning to a parent restores its filter and scroll position.

**Playlist** (list with a music note), beside Library, opens at the current track in the playback sequence.
It fits up to six rows in both layouts; scroll to reach the rest of the queue.
Play and Pause update the track status without interrupting browsing or moving the list.
When the current track is fully visible, the list follows the next track; scrolling away leaves your position alone.
Tap any numbered row to start that track and continue with the following tracks in that order. Shuffle
generates the sequence in advance and remembers it across app restarts.
Previous and Next follow that sequence; repeating a shuffled playlist generates
a new sequence for the next cycle. Tap the track title for its full details.
Open a Library track's actions and choose **Play next** to move it next in the current sequence;
tracks from other folders are added to the playlist. The current track cannot be
queued next. Open **Recently** beside Playlist to return to a recently played folder;
the player setting controls how many are remembered (10 by default).

Open the **Config** gear beside Playlist to find the **Sleep timer** menu. It stops
playback after 15, 30 or 60 minutes, or at the end of
the current track. It continues counting while paused and survives app and Homey
restarts. When its deadline passes during a speaker interruption, Stop waits until
the original track resumes. In Flow-only mode, the Stop Flow or silent Stop setting controls
how the speaker is stopped. Speaker interruptions are shown separately from Pause.
While a command runs, a ring marks the pressed button and library navigation
remains available. Connection failures keep the last known information visible,
mark it as stale, and retry a few times; Retry remains available afterward.

For Flow-controlled playback, enable **Send silent audio on Stop** or **Send silent audio on Pause** in the
player's settings to also send a half-second silent WAV via **Playback URL changed**.
Both are off by default. When enabled for an action, the clip is sent on manual
Stop or Pause even if a matching **Playback stopped** or **Playback paused** Flow
is configured. The speaker must be able to fetch the clip from Homey and play WAV
files. The clip replaces playback on the speaker but not the remembered track.
The device remembers shuffle and repeat even before the first track is played.
It also remembers the queue, track, and estimated position across app restarts
and in-place reinstalls. Recovery does not send the current track to the speaker
again. If the device was playing, it uses the original start time and UPnP duration
to schedule the next track, or advances once on startup if the track has already
ended. If it was stopped, its position stays fixed. The estimate does not reflect
changes to playback made directly on the speaker; seeking is not supported.
Progress does not cause playback snapshots to be written repeatedly.

## Localization

Edit runtime translations in `.homeycompose/locales/` and manifest translations
in the Homey Compose app, Flow-card, and driver files. App Store descriptions
live in `README.txt` and `README.<language>.txt`. Run `homey app validate` to
regenerate the manifest and runtime locales and validate the package.

## Development packaging

`npm install` and `npm ci` automatically prune dependency documentation, source
maps, type definitions, tests and verified unused alternate builds. Runtime
entry points and licenses are retained. The helpers in `tools/` are excluded
from the Homey package.

The UPnP picker reuses hosted artwork for tracks sharing the same cover within
one listing. If hosting fails, it keeps the original artwork URL.

Use `node tools/prune-dependencies.js --dry-run` to preview pruning, or omit
`--dry-run` to apply it to existing dependencies. Run `npm test` afterward.
For dependency changes, set `UMP_DEPENDENCY_TRACE` to a local output file and run
`node --require ./tools/trace-dependencies.js --test` before and after pruning.
Do not prune additional files based only on their absence from that trace;
check lazy loading and error paths too.

## Changelog

**1.3.0**

- Play directly on Sonos, Google Cast and compatible UPnP/DLNA speakers or saved speaker groups.
- Control playback, browse the library and choose a speaker from the Media player dashboard widget.
- Add speakers and TVs as Playback Devices with their own playback and volume controls. Samsung TVs can also be switched on and off.
- UPnP Player is now called Media Server.
- Click the widget artwork to show a spectrum; choose No, Light, Normal or Detailed visualizer in the widget settings.
- Switch inputs (TV, line-in, HDMI) of supported Sonos and Samsung devices and turn TVs on or off from the widget; inputs also work on the device and in Flows.
- Announcements can turn TVs on and off automatically (off by default).
- Add or remove Sonos rooms in the widget while UMP plays to that group.

- **1.2.14** - Moved source code and issues to GitHub.
- **1.2.13** - Fixed socket connection issues.
- **1.2.11** - Fixed socket connection issues.
- **1.2.10** - Improved pairing response time.
- **1.2.9** - Added Homey Pro (Early 2023) support and more browsing images.
- **1.2.8** - Added contribution options.
- **1.2.7** - Improved App Store tags.
- **1.2.6** - Added Advanced Flow support.
- **1.2.5** - Improved error messages.
- **1.2.4** - Updated the description.
- **1.2.3** - Updated app configuration.
- **1.2.2** - Removed the settings page.
- **1.2.1** - Changed the app category.
- **1.2.0** - Updated the description.
- **1.1.2** - Added Media Url Converter to the description.
- **1.1.1** - Corrected spelling.
- **1.1.0** - Updated images and contributors.
- **1.0.0** - Prepared the app for publication.
- **0.2.1** - Updated to SDK 3.
- **0.1.3** - Changed the app category.
- **0.1.2** - Corrected text.
- **0.1.1** - Small fixes.
- **0.1.0** - Initial version.
- **0.0.1** - Initial publication.