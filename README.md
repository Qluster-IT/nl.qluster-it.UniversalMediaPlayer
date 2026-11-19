Universal Media Player browses a UPnP server and provides file URLs for speakers or TVs.
The available folders depend on the server. Flow selections use the browsing path so
the app can find the file again if the server changes its ID.

## Playback setup

1. Add a UPnP Player and select a file or folder in a Flow card.
2. Create a Flow with **Playback URL changed** as the trigger.
3. Add your speaker's play-URL action and use the trigger's **URL** tag.

The player sends URLs; it does not play audio itself. **Pause** freezes the
position and fires **Playback paused**. The separate **Stop** button fires
**Playback stopped**. Connect those triggers to the corresponding actions on
your speaker. Pressing Play sends the current URL again and starts the track
from the beginning.

The **Playback duration elapsed** trigger and waiting cards use the duration
reported by the UPnP server plus the configured delay. Duration tags are in
milliseconds. If the server does not provide a valid duration, timing and
automatic folder advancement may be inaccurate.

Thanks for Johan Bendz for the excellent images and icons!

## Dashboard widget

Add **Media player** to a Homey dashboard, select a UPnP Player, and choose
Compact or Large. The widget shows the player, artwork, track, artist, album,
and estimated playback time, with previous, play/pause, stop, next, shuffle, and playlist
repeat controls. A read-only progress bar appears when the track duration is known.
Compact uses tighter vertical spacing and shows elapsed and total time alongside the artwork.
Play/Pause is blue, and active Shuffle, Repeat, and Library buttons are tinted.
The widget has minus and plus buttons beside its volume slider and a Mute icon alongside the playback buttons,
with Play/Pause in the center. The volume slider has a white handle in light and dark mode. **Volume step (%)** sets how much the widget's
minus and plus buttons change the volume (5% by default). Only Large shows the
volume percentage next to the slider and the playback status in the header.
Compact uses smaller volume-button circles while keeping their touch targets.
The source button opens a menu over the widget. It closes when pressed again,
when a source is chosen, or after 10 seconds.
Controls stay visually steady while a command is being sent.
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
or stays visible. Playback still uses the **Playback URL changed** Flow to
send the file to your speaker.

Use **Previous page** and **Next page** to browse the library. **Items per page**
sets the page size (50 by default, from 1 to 200). Filtering searches the whole
current folder, including entries not loaded yet, and pages the matching results.
Returning to a parent restores its page, filter, and scroll position. Expand
**Folder path** to jump directly to an ancestor.

**Playlist** (list with a music note), beside Library, opens at the current track in the playback sequence.
Play and Pause update the track status without interrupting browsing or moving the list.
When the current track is fully visible, the list follows the next track; scrolling away leaves your position alone.
Tap any numbered row to start that track and continue with the following tracks in that order. Shuffle
generates the sequence in advance and remembers it across app restarts.
Previous and Next follow that sequence; repeating a shuffled playlist generates
a new sequence for the next cycle. Tap the track title for its full details.
Open a Library track's actions and choose **Play next** to move it next in the current sequence;
tracks from other folders are added to the playlist. The current track cannot be
queued next. Open **Recently played folders** in Library to return to a folder;
the player setting controls how many are remembered (10 by default).

The **Sleep timer** stops playback after 15, 30 or 60 minutes, or at the end of
the current track. It continues counting while paused and survives app and Homey
restarts. When its deadline passes during a speaker interruption, Stop waits until
the original track resumes. The usual Stop Flow or silent Stop setting controls
how the speaker is stopped. Speaker interruptions are shown separately from Pause.
While a command runs, a ring marks the pressed button and library navigation
remains available. Connection failures keep the last known information visible,
mark it as stale, and retry a few times; Retry remains available afterward.

Enable **Send silent audio on Stop** or **Send silent audio on Pause** in the
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

## Changelog

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