# obsidian-youtube-transcript

Reads a YouTube transcript out of the watch page itself, from inside Obsidian on desktop, using
trusted Electron input.

No undocumented endpoint, no token forgery, no third-party service. It opens the page you would
have opened, clicks the button you would have clicked, and reads the panel that appears.

## How it works

The transcript is fetched by asking YouTube's own player API for the caption track, from inside
a real youtube.com page running in an Obsidian webview. No clicking, no scraping, no undocumented
endpoint reached from outside the browser.

Getting there meant walking into three walls, and the shape of them is the design.

**`timedtext` is gated.** The watch page's caption URLs carry `exp=xpe`, meaning a proof-of-origin
token is required. Fetch one without it — same-origin, from inside the watch page, with the
session's own cookies — and it answers `200` with a zero-byte body. Every library that fetches
captions from that URL is knocking on that door.

**So is the transcript panel.** Clicking "Show transcript" makes the page issue
`POST /youtubei/v1/get_transcript`, which on most videos answers:

```json
{ "error": { "code": 400, "message": "Precondition check failed.",
             "status": "FAILED_PRECONDITION" } }
```

The panel then spins for ever. This was diagnosed by attaching to the guest webview as its own
debugging target and reading its network — not inferred. Opening the panel with a genuinely
trusted click works fine; it is what happens next that fails.

**But the player answers a different client.** The same `/youtubei/v1/player` request, made as
the iOS client, comes back `OK` with caption URLs that carry no `exp=xpe` at all. They fetch in
full, first time, for every video tried. `ANDROID_VR`, `TVHTML5_SIMPLY_EMBEDDED_PLAYER`,
`WEB_EMBEDDED_PLAYER` and `MWEB` were tried against the same video and all returned
`ERROR`/`UNPLAYABLE` with no tracks.

The part that cannot be dropped is *where the request is made from*. It runs inside a real
youtube.com document, so it is same-origin — no CORS, the session's own cookies, YouTube's own
API key read out of `ytcfg`. The same request from Node is a cross-origin request from an unknown
client, which is what is being refused everywhere else. **The webview is still load-bearing. It
just no longer has to be clicked.**

Measured end to end, through `fetchTranscript`, on a hidden webview: **7 of 7 videos, averaging
2.4 seconds each** — 61 cues from a 3:33 video, 992 from a sewing tutorial, 98–100% coverage
throughout. `json3` gives millisecond timings, so the cues are finer than the rendered panel's.

## The panel is still here

`strategy: "panel"` opens the transcript with a trusted `sendInputEvent` click and reads
`transcript-segment-view-model` nodes out of the DOM. It is the fallback when the caption request
is refused, and `auto` — the default — tries the fast route and falls back to it.

It is kept for two reasons. It reads what a person would actually see, which is a real check on
the other route. And a path that depends on an undocumented client is worth having a second
opinion on, because the day the iOS client stops answering is a day this still needs to work.

A synthetic `.click()` will not do it: `element.click()` arrives with `isTrusted === false` and
YouTube's handler ignores it, so the panel stays `VISIBILITY_HIDDEN` silently. Electron's
`sendInputEvent` originates the event in the browser process, which a page script cannot forge.
That is [`src/trusted.ts`](src/trusted.ts).

## Requirements

- **Desktop only.** There is no `<webview>` on Obsidian mobile. `webviewsAvailable()` answers
  this without guessing at the platform.
- **`webviewTag` must be enabled.** It is today, because Obsidian's own Web Viewer needs it.
  That is someone else's decision to change, so the failure is a named one rather than a crash.

## Install

```bash
npm install github:arangutambo/obsidian-youtube-transcript
```

## Use

```ts
import { fetchTranscript, isTranscriptError, toParagraphs } from "obsidian-youtube-transcript";

const transcript = await fetchTranscript("https://youtu.be/dQw4w9WgXcQ", {
    // A persistent partition means a consent answer is given once, not every time.
    partition: "persist:youtube-transcript",
    onProgress: (stage) => console.log(stage),
    // "auto" (default) asks the player API and falls back to the panel; "innertube" or
    // "panel" pin it to one route.
    strategy: "auto",
});

transcript.title;    // "Never Gonna Give You Up"
transcript.cues;     // [{ start: 0, text: "We're no strangers to love" }, …]

toParagraphs(transcript.cues); // grouped on a 30-second seam, for something readable
```

A webview is created and disposed of for you. If you already have one showing the video, use
`readTranscript(view, videoId)` instead and it will read the page you are looking at.

`toPlainText(cues)` and `toVtt(cues)` are there for the two obvious destinations.

## When it fails

Every failure is a `TranscriptError` with a `reason` worth branching on, and a message already
written for a person to read.

| `reason` | What happened | What to do |
| --- | --- | --- |
| `unsupported` | No webview: mobile, or `webviewTag` off | Nothing. Say so. |
| `no-captions` | The video genuinely has no caption track | Nothing. This is not a bug. |
| `consent-required` | YouTube wants a consent decision | Re-run with `visible: true` and a persistent `partition`, answer it once |
| `sign-in-required` | Age-restricted, private, or members only | Sign in to that partition |
| `no-button` | Captions exist, nothing opens them | YouTube moved the control — see below |
| `panel-never-opened` | Clicked, and it stayed shut | Usually transient; retry |
| `no-segments` | Panel opened, rendered nothing | Retry |
| `load-failed` / `cancelled` | The page never loaded / you aborted | — |

`no-captions` is decided from the player response before a single click is sent, so a video
without captions costs one round trip rather than thirty seconds of clicking at nothing.

A consent page is deliberately **not** answered on your behalf. That is a decision for the person
using the plugin, and `visible: true` hands it to them.

## What will break, and where

YouTube's DOM. Every selector is in one file — [`src/page.ts`](src/page.ts) — for exactly that
reason. The watch page is loaded with `hl=en` so the control can be found by its accessible name
without being at the mercy of the account's locale.

If `no-button` starts appearing, that file is the only one to look at.

## Verifying it against a real video

The test suite covers the sequence, not YouTube. Against the live site there is one procedure,
and it is the only thing that settles whether the selectors still match.

`require("obsidian-youtube-transcript")` in Obsidian's console does **not** work: the package is
not resolvable by name from the renderer, and it is ESM, so `require` of it throws
`ERR_REQUIRE_ESM` even by absolute path. Bundle the harness in [`tools/verify.ts`](tools/verify.ts)
to CJS instead, and the console paste is two lines:

```bash
npx esbuild tools/verify.ts --bundle --format=cjs --platform=browser --external:fs --outfile=tools/verify.cjs
```

```ts
// Obsidian's developer console, Cmd-Opt-I. Absolute path; `require` caches, so clear it
// between builds or you will keep testing the bundle you replaced.
Object.keys(require.cache).filter(k => k.includes("verify.cjs")).forEach(k => delete require.cache[k]);
await require("/absolute/path/to/tools/verify.cjs").verify("<video id>", { visible: true });
```

It writes `/tmp/youtube-transcript-verify.json`, which is the point: a failure there carries the
page's own account of itself — which of the three routes in `page.ts` matched, what the control's
accessible name and rect were, which engagement panels exist and what their headers say, and what
a segment node is actually built out of. That is enough to fix a selector without a second run,
which matters when a run costs a minute.

`visible: true` for the first run of a partition, both because a consent decision needs answering
by hand and because a hidden guest is laid out far more lazily — measured at roughly 2s to render
the description controls visible against 12s hidden, for the same video. That is why `controlMs`
is generous.

## Using it from Democratised Read It Later

`Cue` here is the same `{ start, text }` shape as `src/video/transcript.ts` in the plugin, so
cues drop straight into the existing `toParagraphs` and `VideoSurface` without a translation
layer:

```ts
import { fetchTranscript, isTranscriptError } from "obsidian-youtube-transcript";
import { toParagraphs } from "./video/transcript";

try {
    const { cues, title } = await fetchTranscript(url, { partition: "persist:reader-youtube" });
    const paragraphs = toParagraphs(cues);
} catch (error) {
    if (isTranscriptError(error)) new Notice(error.message);
    else throw error;
}
```

That fills the gap the Readwise export leaves: a video that was never in the export, or one saved
after it.

## Tests

```bash
npm test
```

The extraction runs against a fake watch page that changes state **only** in response to
`sendInputEvent`. Nothing a script does through `executeJavaScript` opens its panel — so a
regression back to a synthetic click fails the suite rather than silently doing nothing inside
Obsidian.

## Licence

MIT
