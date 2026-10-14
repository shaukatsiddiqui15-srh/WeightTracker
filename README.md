# Morning Scale

A daily fasting weigh-in tracker. Plain HTML, CSS and JavaScript, no build step, ready for GitHub Pages.

## How it works

- **First open:** set the starting weight (100 kg), start date, target loss per month (5 kg), an optional goal weight, and the morning cutoff time (default 11:00 AM).
- **Every morning:** tap *Log this morning's weight*, take a photo of the scale display, type the number, and save.
- **Verification:** each entry is checked for:
  - a scale photo (required, the entry can't be saved without one)
  - the photo being taken **today**, read from the camera's capture time
  - the photo being taken **before the cutoff time**
  - the *fasting* box being ticked
  - no unusual jump (more than 2.5 kg) from the last entry

  All checks pass → **Verified**. Any check fails → **Needs a look**. Tap any entry to see the photo beside the typed number.
- **Missed days:** any day without an entry shows **Not logged**. After the cutoff, today's card turns red: *"Today's weight has not been given."*
- **Progress:** the chart shows daily weights, the 7-day average and the target pace line. The stats show the latest weight, total lost, the 7-day average against pace, and the logging streak.

## Where the data lives

Entries and photos are stored in the browser on the phone (IndexedDB). Nothing is uploaded, so the GitHub Pages URL can be public: anyone else who opens it just sees an empty tracker of their own.

Because the data stays on one phone:
- use the tracker in the same browser every day
- use **Download backup** now and then (one JSON file with the photos), and **Restore backup** on a new phone

## Deploy to GitHub Pages

1. Create a new repository on GitHub, for example `morning-scale`.
2. Upload `index.html`, `style.css` and `app.js` to the root of the repository.
3. Open **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`. Save.
4. After a minute or so the site is live at `https://<your-username>.github.io/morning-scale/`.
5. Open the link on her phone and use **Add to Home Screen** so it opens like an app.

## Customising

- Pace, goal and cutoff time can be changed any time from the settings button.
- To change the size of jump that gets flagged, edit `2.5` in `runChecks()` in `app.js`.
