# Changelog

All notable changes to **CineSnack** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-16

First release.

### Changed before release

- Renamed from NitroClip to CineSnack, with a new icon and a dark, blue desktop-editor interface: toolbar, viewer, timeline with a ruler, export settings panel and status bar.
- Native menu bar with every action and its shortcut, a keyboard shortcuts sheet (`F1`), and global `Ctrl+Alt+K` (record the focused window) and `Ctrl+K` (pick what to record) that work from any app and stop a running recording. Every shortcut can be rebound in the shortcuts sheet.
- Timeline handles are keyboard sliders (arrow keys move one frame, `Shift` one second). Dialogs trap focus and close on `Esc`. Controls have accessible names and visible focus rings.
- The recording bar stays visible but no longer appears in recordings. Windows and macOS exclude it from capture. On X11, window recordings exclude it naturally, and full-screen recordings refill its spot every frame from the window underneath. The tray icon turns red while recording, and clicking it stops.
- Launches faster: the window opens immediately with a loading screen, and the editor no longer waits on the ffmpeg check (icons are imported one by one instead of the whole icon set).
- Exports stream smoothly in chat apps and browsers: Auto resolution tops out at 1080p, video is capped at about 12 Mbps at 1080p60 (it was up to ~45 Mbps for short 1440p clips), the frame rate is snapped to a standard value, peaks are capped, and there's a keyframe every 2 seconds. Size limits now use decimal megabytes (50 MB = 50,000,000 bytes).
- Auto-export: an Export Settings switch (`A`) that exports and copies every recording as soon as it stops, using a faster x264 preset, with a notification instead of popping up the window.
- Exports from screen recordings no longer fail with "Incomplete MB-tree stats file". Both encode passes now see the same constant-rate frames.

### Added

- Open any video ffmpeg can read, by drag and drop or file picker, with a quick preview proxy for formats the player can't show.
- Filmstrip timeline with in and out handles, playhead scrubbing, and frame stepping.
- Size presets for 10 MB, 50 MB and 500 MB, with a live estimate of resolution, bitrate, quality and output size.
- Size-targeted two-pass H.264 + AAC encoder that checks the finished file and re-encodes smaller if it overshoots.
- 30 / 60 fps choice that never invents frames, Auto or fixed resolution, a mute toggle, and mixing for multi-track audio.
- Automatic copy of the exported file to the clipboard on Windows, macOS and Linux, plus drag-out and "Show in folder".
- Screen and window recording with a 5 second countdown, computer audio on by default and a 5 minute hard cap. A small recording bar shows the countdown and elapsed time. Recordings open in the trimmer when they finish.
- Tray icon with Record / Stop, Open video, exports folder and Quit. Closing the window keeps CineSnack running in the tray.
- Taskbar and launcher right-click actions: Windows jump list, macOS dock menu, and Linux desktop actions, all routed to the running copy with `--record` / `--open`. Opening a video file with CineSnack loads it.
