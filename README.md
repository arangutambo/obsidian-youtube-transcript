# obsidian-youtube-transcript

Reads a YouTube transcript out of the watch page itself, from inside Obsidian on desktop, using
trusted Electron input.

No undocumented endpoint, no token forgery, no third-party service. It opens the page you would
have opened, clicks the button you would have clicked, and reads the panel that appears.

## Why it works this way

Three findings, in the order they closed off the alternatives.

**`timedtext` is gated.** YouTube's caption endpoint now requires a proof-of-origin token. This
was tested rather than assumed: the request was issued from inside the watch page itself,
same-origin, with the session's own cookies, in a real browser. It still returned zero bytes.
That is not a headers problem, and no amount of request shaping fixes it. Every library that
fetches captions from that endpoint is knocking on the same closed door.

**The transcript is in the page.** The engagement panel is right there in the DOM —
`ytd-transcript-segment-renderer`, one node per phrase, timestamp included.

**A synthetic click will not open it.** `element.click()` and a hand-built `MouseEvent` arrive
with `isTrusted === false`, because only the browser may set that flag. YouTube's handler checks
it. Dispatch a synthetic click at "Show transcript" and the panel stays `VISIBILITY_HIDDEN` —
silently, with no error anywhere.

Which is the specification for the fix. Electron's `webContents.sendInputEvent()` originates
input in the browser process, so the page receives it as real input and a page script cannot
forge it. That is [`src/trusted.ts`](src/trusted.ts), and it is the only interesting line in the
library:

```ts
await view.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
```

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

## What is actually verified

Against live YouTube from inside Obsidian 1.13.7 (Electron 34.3.0), on 19 August 2026:

- **The mechanism works.** A trusted `sendInputEvent` click opens the panel, and real cues come
  back — 24 from a 3:33 video, 143 from a 19-minute one, correctly timed and complete to the end
  of the video. Nothing about the approach is in doubt.
- **It is not yet reliable.** Two of seven videos tested succeeded. The rest fail at
  `no-segments` or `panel-never-opened`: the control is found, aimed at and clicked — `aim`
  reports `button [Show transcript]`, in view and unobstructed — and the transcript panel stays
  `VISIBILITY_HIDDEN` while a **decoy panel sharing the same `target-id`**, headed "In this
  video", opens instead and never populates.

So this reads a transcript; it does not yet read *a* transcript reliably enough to put behind a
command. The open question is what the "Show transcript" click actually activates on a video with
chapters, which is where every failure so far has been.

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
