<h1><img src="icon.svg" alt="" width="40" height="40" align="top"> CompTracker</h1>

A mobile-friendly web app for keeping track of how your friends are doing at West Coast Swing competitions hosted on [scoring.dance](https://scoring.dance).

Instead of searching for each person on the event wall one by one, you build a watch list of bib numbers once and see everyone's progress on a single page.

## Features
- **Everyone on one page:** pick an event on scoring.dance and follow any number of people, added by bib number or by name.
- **Progress at a glance:** see each person's competitions, role, partner, rounds made, heat numbers and results.
- **Heat lists and results:** browse every round of the event, with heat lists and every judge's scores once results are published.
- **Sort your way:** by when people were added, by name, by latest changes, or in your own order.
- **SwingPoints favourites:** see the dancers you follow on [SwingPoints](https://apps.apple.com/app/swingpoints/id1214670404) and add the ones competing at the event in one go. SwingPoints has no public API, so this may stop working if its app changes.
- **Change highlighting:** people whose results changed are marked after a refresh.
- **Refresh on demand:** results only update when you ask, so the app never polls scoring.dance in the background.
- **Works like an app:** add it to your home screen. The last fetched results stay visible offline.
- **Private by design:** everything is stored in your browser, with no account and no server. Your SwingPoints login is encrypted on your device and sent only to SwingPoints.

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
