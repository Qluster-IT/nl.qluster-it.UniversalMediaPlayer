# Homey App Instructions

> You may override or change any instructions in this file when you explicitly tell me to.

This is a Homey app. Before making changes, follow `C:\Users\Qlustrator\.copilot\instructions\homey-app.md` for app conventions and `C:\Users\Qlustrator\.copilot\instructions\homey-develop.md` for development, builds, testing, and deployment. Follow the task-specific image, color, Wiki, and forum guides referenced there when applicable.

## Learnings

- Discovery freshness is separate from remembered speaker identity. Verify persistent LAN addresses against the live device identity before reuse after restart, then refresh discovery in the background. A connection failure can invalidate an endpoint, but must never trigger a blind replay of an unconfirmed write.

- Normalize typed SOAP scalar leaves at the shared response boundary: Microsoft renderers can return `{_: '100', $: {...}}` instead of `'100'`. Preserve structural XML objects and attributes. Windows Digital Media Renderer can acknowledge Stop and settle paused at zero; accept that only for the identified renderer after exact ownership and successful command acknowledgment.
- Windows queue EOF can also reset to paused at zero. Require the exact owned URI, recent observed near-end progress and the matching end deadline; never infer completion from a normal pause, an early reset or stale progress. Direct-session operations reload their journal, so persist near-end proof together with the updated deadline, not before updating it.

- DLNA queue edits must only clear/re-arm the next URI, not reload or seek the current track. Generate DIDL media classes from the actual MIME type (video must not be advertised as music). Verify test media URLs before attributing a renderer rejection to UMP: UPnP servers can list deleted files.

- Widget speaker mode follows the Sonos group coordinator for transport and queue reads, but uses the selected room for volume. Read live topology before changing membership and never move rooms out of unrelated groups or regroup rooms owned by UMP playback. Group and room volume remain adjustable during playback.
- Widget destination changes are per-instance selection only: retain independent persisted playback contexts, reuse an existing UMP owner, and never invoke the paired player's global target handover. Forward owned speaker-source controls to that owner; observing unknown native playback must not load media. Preserve Library path even while Playlist is visible, and commit a pending filter before saving its context.
- Observe existing Cast sessions through a media request/response channel, not the default receiver media controller: its close handler attempts Stop. Selecting a source may read state, but must never load media or launch a receiver.

- UPnP Browse uses SOAP 1.1 (`text/xml; charset="utf-8"` and quoted `SOAPAction`) for strict servers such as Synology. Sending `application/soap+xml` with a SOAP 1.1 envelope can yield HTTP 415 even while existing tracks play. Reuse hosted artwork only within a single picker response: Homey image registrations are short-lived, and the original artwork URL is the fallback if hosting fails.

- Homey Compose source files such as `driver.settings.compose.json` are not included in the installed app. Runtime code needing driver settings must read the generated `app.json` instead; verify pairing and repair against a packaged app.

- Sonos feedback must only suspend and resume the local queue; never send a playback URL, Pause/Stop trigger, or silent clip in response, except when an explicitly scheduled sleep timer expired during an interruption: defer its Stop until the original track resumes. Announcements can restore the original URI, so preserve the queue and pending Advanced Flow completion wait. Verify ownership using the actual AVTransport TrackURI (following a group coordinator when necessary), not speaker_track titles; shuffle remains managed exclusively by our playlist.
  Sonos can restore an HTTP(S) track with an `x-rincon-mp3radio://` wrapper. Strip that transport wrapper before comparing the complete URL; never match only the server, filename, or displayed title.
  After a foreign track or transport Stop, the restored song restarts from zero: reset local position and completion timing without resending the URL. Ordinary pause/resume preserves position. Persist this distinction while interrupted and preserve any pending Advanced Flow completion wait.

- Use Homey's built-in capability Flow cards instead of duplicating them in Compose. For example, `volume_set` supplies `volume_set_changed`, but `volume_mute` has no built-in change trigger. When syncing volume in both directions, compare with the speaker's current volume before sending a command so reported volume doesn't echo back.

- Shuffle uses a persisted index order shared by playback and the widget's Playlist view; keep files in server order. Generate a new shuffled order only when enabling shuffle, starting a new folder, or beginning the next repeat cycle, never when displaying the playlist.

- Homey can expose `speaker_position` and `speaker_duration` in the device API without rendering either in the native media panel. Check the capability values and each client separately before changing units, re-pairing, or adding a workaround; the Web App's media panel has been verified not to consume these values. Keep the widget progress bar independent of native rendering. See the [SDK media component](https://apps.developer.homey.app/the-basics/devices/capabilities#media) and the [Homey Community report](https://community.homey.app/t/speaker-duration-position-problem/61033/4).
