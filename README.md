<h1><img src="icon.svg" alt="" width="40" height="40" align="top"> CompTracker</h1>

A mobile-friendly web app for keeping track of how your friends are doing at West Coast Swing competitions hosted on [scoring.dance](https://scoring.dance).

Instead of searching for each person on the event wall one by one, you build a watch list of bib numbers once and see everyone's progress on a single page.

## Features
- **One event, many people:** pick an event that is happening now on scoring.dance (or enter its ID), then add the bib numbers of everyone you want to follow.
- **Everything at a glance:** for each person, see every competition they are entered in, their role (and partner in Strictly competitions), which rounds they made, and their heat numbers.
- **Collapsible cards:** tap a person's name to fold their card down to one line per competition: the latest round they danced and its result or heat. *Collapse all* folds every card at once.
- **Sort the watch list:** in the order you added people, most recently added first, alphabetically, or by most recent changes (with the time each person's info last changed).
- **Find people by name:** load the event's competitor list once, then type part of a first or last name and pick from the suggestions. The list shows when it was loaded and can be reloaded to pick up late changes.
- **All rounds:** the *All rounds* tab lists every round of the event. Open one to see its heat lists (who dances in which heat, with your people highlighted), or the full results with every judge's marks once they are published.
- **Tap a round:** tapping a round on someone's card opens that round's heat lists on their heat, or, once results are out, jumps to their scores on the results page.
- **Results:** once an event publishes results, each round shows the callback outcome or final placement, and *Show results* lists every judge's score (with full judge names) for every round your people danced.
- **Favourites from SwingPoints:** before you pick an event, the home screen has a *Favourites* tab. It signs in to your [SwingPoints](https://apps.apple.com/app/swingpoints/id1214670404) account and lists the dancers you follow there, with their WSDC ID, roles and highest division. Tap ↻ or pull down to sync the list again. SwingPoints has no public API, so this uses the API of its own app and may stop working if that changes.
- **Bulk add (opt-in):** during an event, *Add person → By name* shows a banner once the competitor list is loaded: how many of your favourites compete there but aren't on your watch list yet. *Review and add* lists them, matched by name, and adds the ones you tick in one go. It is hidden until you turn it on: open CompTracker with `?enable=bulk-add` (`?disable=bulk-add` turns it off), or tap the *Favourites* title five times in a row (handy for a home-screen app, which keeps its own storage).
- **Change highlighting:** after a refresh, people whose results changed are briefly marked as *CHANGED*.
- **Refresh on demand:** results only update when you pull down, tap the refresh button or reload the page, so the app never polls scoring.dance in the background.
- **Works like an app:** add it to your home screen. The last fetched results stay visible even when the connection drops.
- **Light on traffic:** CompTracker reads scoring.dance's JSON API (`scoring.dance/api/`) instead of loading whole web pages.
- **Private by design:** your event and watch list are stored only in your browser's local storage. There is no CompTracker account and no server.
- **Your SwingPoints login stays on your device:** it is encrypted (AES-GCM) with a key your browser creates and keeps in IndexedDB as non-extractable, so the key can be used by CompTracker but never read out. The login is sent only to SwingPoints, over HTTPS. *Log out* (next to the sync time on the Favourites tab) deletes the login, the key and the favourites. A web page cannot hide data from code running on the page itself, so this protects the stored login, not a compromised page.

## How to use
1. Pick your event under *Happening now*. CompTracker lists the scoring.dance events that are running right now.
2. For any other event, open it on scoring.dance and copy the number from the URL instead. For example, in `scoring.dance/enUS/events/393/wall` the event ID is `393`. Enter it in CompTracker and confirm the event name.
3. Add people by their bib number, or switch to *By name*, load the competitor list and search for them.
4. Pull down or tap ↻ whenever you want the latest results.
5. Tap any round to see its heat lists or results, or browse every round under *All rounds*.

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
