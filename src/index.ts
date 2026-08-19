/**
 * Reading a YouTube transcript from inside Obsidian, out of the page itself.
 *
 * The short version of why this exists: YouTube's `timedtext` endpoint now requires a
 * proof-of-origin token, and no amount of request shaping gets around it — the request was
 * tested same-origin, from inside the watch page, with the session's own cookies, and still
 * came back empty. Every library that fetches captions is knocking on that same door.
 *
 * But the transcript is right there in the page. The only thing standing between a plugin and
 * it is that YouTube's handler ignores untrusted events, so a synthetic `.click()` on "Show
 * transcript" leaves the panel `VISIBILITY_HIDDEN`. Electron's `sendInputEvent` originates
 * input in the browser process, which a page script cannot forge — so the click works, the
 * panel opens, and the segments can be read straight out of the DOM.
 *
 * Desktop only. There is no webview on mobile, and this depends on Obsidian keeping
 * `webviewTag` enabled — which it does, because its own Web Viewer needs it.
 */

export { type CaptionTrack, clockOf, type Cue, type Paragraph, parseClock, type Transcript, toParagraphs, toPlainText, toVtt } from "./cues.js";
export { isTranscriptError, TranscriptError, type TranscriptFailure } from "./errors.js";
export { type ExtractOptions, fetchTranscript, readTranscript, type Timings } from "./extract.js";
export { type Host, type HostOptions, navigate, openHost, webviewsAvailable } from "./host.js";
export { homeUrl, isVideoUrl, videoIdFrom, watchUrl } from "./id.js";
export { type InnertubeResult, playerScript, readViaInnertube } from "./innertube.js";
export { trustedClick } from "./trusted.js";
export type { MouseInput, Stage, WebviewLike } from "./types.js";
