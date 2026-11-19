# Homey App Instructions

> You may override or change any instructions in this file when you explicitly tell me to.

This is a Homey app. Before making changes, read and follow the general instructions in `C:\Users\Qlustrator\.copilot\instructions\homey-app.md`.

## Learnings

- Sonos feedback must only suspend and resume the local queue; never send a playback URL, Pause/Stop trigger, or silent clip in response, except when an explicitly scheduled sleep timer expired during an interruption: defer its Stop until the original track resumes. Announcements can restore the original URI, so preserve the queue and pending Advanced Flow completion wait. Verify ownership using the actual AVTransport TrackURI (following a group coordinator when necessary), not speaker_track titles; shuffle remains managed exclusively by our playlist.
  Sonos can restore an HTTP(S) track with an `x-rincon-mp3radio://` wrapper. Strip that transport wrapper before comparing the complete URL; never match only the server, filename, or displayed title.
  After a foreign track or transport Stop, the restored song restarts from zero: reset local position and completion timing without resending the URL. Ordinary pause/resume preserves position. Persist this distinction while interrupted and preserve any pending Advanced Flow completion wait.

- Use Homey's built-in capability Flow cards instead of duplicating them in Compose. For example, `volume_set` supplies `volume_set_changed`, but `volume_mute` has no built-in change trigger. When syncing volume in both directions, compare with the speaker's current volume before sending a command so reported volume doesn't echo back.

- Shuffle uses a persisted index order shared by playback and the widget's Playlist view; keep files in server order. Generate a new shuffled order only when enabling shuffle, starting a new folder, or beginning the next repeat cycle, never when displaying the playlist.

- Homey can expose `speaker_position` and `speaker_duration` in the device API without rendering either in the native media panel. Check the capability values and each client separately before changing units, re-pairing, or adding a workaround; the Web App's media panel has been verified not to consume these values. Keep the widget progress bar independent of native rendering. See the [SDK media component](https://apps.developer.homey.app/the-basics/devices/capabilities#media) and the [Homey Community report](https://community.homey.app/t/speaker-duration-position-problem/61033/4).
