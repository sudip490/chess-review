# Chess Analysis + Play vs a Legend

A web app like [nextchessmove.com](https://nextchessmove.com): set up a position and get the
**best move**, **or** play a full game against a chess legend who answers with their *real* moves.

## How it works

| Feature | Powered by |
|---------|-----------|
| **Play vs a Legend** | The legend's **real games** from the [Lichess](https://lichess.org) opening-explorer **database** (e.g. Magnus Carlsen = his account `DrNykterstein`). |
| **Analysis (⚡ Analyze)** | **Lichess cloud Stockfish** — modern, deep engine analysis (depth 70+). |
| **Offline fallback** | A local Stockfish (in your browser) is used only when the cloud/database has nothing for a position. |
| **Board & rules** | chessboard.js + chess.js. |

Everything is **free**, needs **no API key**, and is just static files — so it hosts anywhere.

## Run locally

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. (Opening `index.html` via `file://` won't work — the databases and
engine are loaded over the network.)

## Host it online (free)

Static files only (`index.html`, `styles.css`, `app.js`):

- **Netlify** — drag-and-drop this folder onto <https://app.netlify.com/drop>.
- **GitHub Pages** — push the files, enable Pages.
- **Vercel / Cloudflare Pages** — point at the repo, no build step.

> The Lichess database + cloud APIs send `Access-Control-Allow-Origin: *`, so they work from any
> hosted origin. They are rate-limited for very heavy use, which is fine for normal play.

## Play vs a Legend

The right-hand panel pits you against a legend whose moves come from a **real game database**:

| Legend | Database source |
|--------|-----------------|
| Magnus Carlsen | his Lichess account `DrNykterstein` |
| Hikaru Nakamura | his Lichess account `Hikaru` |
| Alireza Firouzja | his Lichess account `alireza2003` |
| Daniel Naroditsky | his Lichess account `RebeccaHarris` |
| World Champions | the historical **masters** database (Fischer, Kasparov, Carlsen, …) |

1. Pick an **opponent** and your **color**, then **♟ New Game**.
2. Drag your piece. The legend replies with the move **they actually played** in that position,
   showing how many of their games it came from (e.g. *"Magnus Carlsen: Nf3 · 412 games"*).
3. **💡 What would they play?** shows the legend's move for *your* position without committing it.
4. When the game leaves the legend's known games (their database runs out), the local engine
   quietly continues so the game can finish — those moves are labelled *"(engine)"*.

**Add or edit legends** — open [app.js](app.js), edit the `LEGENDS` array:

```js
// A modern player who has a Lichess account (uses their real games):
{ name: "Vladimir Kramnik", source: "player", handle: "VladimirKramnik", skill: 20,
  note: "14th World Champion." }

// A historical legend (uses the collective masters database):
{ name: "Paul Morphy", source: "masters", handle: null, skill: 20, note: "Romantic-era genius." }
```

- `source: "player"` + a real **Lichess `handle`** → that player's own games.
- `source: "masters"` → the shared masters database.
- `skill` (0–20) is only used by the offline fallback engine.

## Analysis

Click **⚡ Analyze** to get the best move + evaluation from **Lichess's cloud Stockfish** (a modern,
deep engine — much stronger than the old local fallback). If a position isn't in the cloud cache,
it falls back to the in-browser engine using the **Thinking time** selector.

## Notes / limits

- The legend databases cover the positions those players have actually reached. Common openings are
  rich; once you steer into rare positions, expect the *(engine)* fallback sooner.
- The cloud-eval API only stores popular positions; obscure ones use the local fallback.
- Lichess handles for players can change — if a legend always falls straight to the engine, verify
  the `handle` in `app.js` still matches an existing Lichess account.
