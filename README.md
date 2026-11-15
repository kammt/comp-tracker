<h1><img src="icon.svg" alt="" width="40" height="40" align="top"> CompTracker</h1>

A mobile-friendly web app for keeping track of how your friends are doing at West Coast Swing competitions hosted on [scoring.dance](https://scoring.dance).

Instead of searching for each person on the event wall one by one, you build a watch list of bib numbers once and see everyone's progress on a single page.

## Features
- **One event, many people:** pick an event that is happening now on scoring.dance (or enter its ID), then add the bib numbers of everyone you want to follow.
- **Everything at a glance:** for each person, see every competition they are entered in, their role (and partner in Strictly competitions), which rounds they made, and their heat numbers.
- **Find people by name:** load the event's competitor list once, then type part of a first or last name and pick from the suggestions. The list shows when it was loaded and can be reloaded to pick up late changes.
- **Results:** once an event publishes results, each round shows the callback outcome or final placement, and *Show results* lists every judge's score (with full judge names) for every round your people danced.
- **Change highlighting:** after a refresh, people whose results changed are briefly marked as *CHANGED*.
- **Refresh on demand:** results only update when you press the refresh button, so the app never polls scoring.dance in the background.
- **Works like an app:** add it to your home screen. The last fetched results stay visible even when the connection drops.
- **Light on traffic:** CompTracker reads scoring.dance's JSON API (`scoring.dance/api/`) instead of loading whole web pages.
- **Private by design:** your event and watch list are stored only in your browser's local storage. There is no account and no server.

## How to use
1. Pick your event under *Happening now*. CompTracker lists the scoring.dance events that are running right now.
2. For any other event, open it on scoring.dance and copy the number from the URL instead. For example, in `scoring.dance/enUS/events/393/wall` the event ID is `393`. Enter it in CompTracker and confirm the event name.
3. Add people by their bib number, or switch to *By name*, load the competitor list and search for them.
4. Tap ↻ whenever you want the latest results.

## Running locally
CompTracker is plain HTML, CSS and JavaScript with no build step. Serve the folder with any static web server, for example:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Caution
- This entire project is vibe-coded. Use at your own risk.
- All the traffic generated to scoring.dance is your responsibility.

## License
MIT, see [LICENSE](LICENSE).
