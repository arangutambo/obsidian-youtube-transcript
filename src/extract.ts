/**
 * Opening the transcript and reading it out.
 *
 * The order here is the whole design, and each step exists because the one before it can fail
 * in a way worth naming.
 *
 * Wait for the player response, because until it lands the page knows nothing. Read the caption
 * tracks out of it, because a video with no captions can then be refused in one round trip
 * instead of thirty seconds of clicking at a control that will never appear. Expand the
 * description, because the transcript section is not rendered until it is. Click — trusted, and
 * only after checking what is actually under the point. Then wait for the list to stop growing,
 * because the panel renders progressively and a transcript read too early is a transcript
 * missing its second half.
 */

import { type Cue, parseClock, type Transcript } from "./cues.js";
import { TranscriptError } from "./errors.js";
import { type Host, type HostOptions, openHost } from "./host.js";
import { videoIdFrom, watchUrl } from "./id.js";
import { aim, describe, focus, type PageState, read, runScript, type Target } from "./page.js";
import { trustedClick } from "./trusted.js";
import type { Stage, WebviewLike } from "./types.js";
import { delay, until } from "./wait.js";

/**
 * The internal waits.
 *
 * Exposed because none of these are knowable in advance — they are how long YouTube takes to do
 * things on the machine it is running on, and a slow laptop on a slow connection is a different
 * set of numbers from a fast one. The defaults are generous on purpose.
 */
export interface Timings {
	/** Pause between scrolling the control into view and measuring where it landed. */
	settleMs: number;
	/** How often to re-ask the page what it looks like. */
	pollMs: number;
	/** How long to wait for the panel after a click, per attempt. */
	panelMs: number;
	/** How long to wait for the transcript control to appear after expanding the description. */
	expandMs: number;
	/** Pause before trying again when something was covering the control. */
	retryMs: number;
}

const DEFAULT_TIMINGS: Timings = {
	settleMs: 200,
	pollMs: 250,
	panelMs: 6_000,
	expandMs: 5_000,
	retryMs: 500,
};

export interface ExtractOptions extends HostOptions {
	signal?: AbortSignal;
	onProgress?: (stage: Stage) => void;
	/** How long to spend waiting for the transcript to finish rendering. */
	timeoutMs?: number;
	timings?: Partial<Timings>;
}

/** How many times to click the control before accepting that the panel will not open. */
const ATTEMPTS = 3;

/** How long to keep waiting for whatever is covering the control to go away. */
const COVERED_ATTEMPTS = 3;

/**
 * The transcript for a video, from a URL or a bare id.
 *
 * Creates its own webview and takes it down again, whatever happens. Desktop only.
 */
export async function fetchTranscript(input: string, options: ExtractOptions = {}): Promise<Transcript> {
	const videoId = videoIdFrom(input);
	if (videoId === undefined) {
		throw new TranscriptError("load-failed", `Not a YouTube video: ${input}`);
	}

	options.onProgress?.("loading");

	let host: Host;
	try {
		host = await openHost(watchUrl(videoId), options);
	} catch (error) {
		throw error instanceof TranscriptError
			? error
			: new TranscriptError("load-failed", "The watch page would not open.", String(error));
	}

	try {
		return await readTranscript(host.view, videoId, options);
	} finally {
		host.dispose();
	}
}

/**
 * The same work against a webview someone else owns.
 *
 * Separated so the sequence can be tested against a fake, and so a caller already showing the
 * video in a webview can read its transcript without opening a second one.
 */
export async function readTranscript(
	view: WebviewLike,
	videoId: string,
	options: ExtractOptions = {},
): Promise<Transcript> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const timings = { ...DEFAULT_TIMINGS, ...options.timings };
	const signal = options.signal;

	options.onProgress?.("reading-page");
	const state = await settledPage(view, timeoutMs, timings, signal);

	refuseUnreadable(state);

	options.onProgress?.("expanding-description");
	await openPanel(view, state, options, timings, signal);

	options.onProgress?.("collecting");
	const cues = await collect(view, timeoutMs, timings, signal);

	options.onProgress?.("done");

	return {
		videoId,
		title: state.title,
		author: state.author,
		durationSeconds: state.durationSeconds,
		// The panel opens on YouTube's default track, which is the first one it lists.
		track: state.tracks[0],
		cues,
	};
}

/** Poll until the player response exists, so everything after it is reading real values. */
async function settledPage(
	view: WebviewLike,
	timeoutMs: number,
	timings: Timings,
	signal?: AbortSignal,
): Promise<PageState> {
	const { value, settled } = await until(
		() => runScript(view, describe),
		(state) => state.ready,
		{ timeoutMs, intervalMs: timings.pollMs, signal },
	);

	if (!settled) {
		throw new TranscriptError(
			"load-failed",
			"The watch page loaded but never produced a player.",
			value.url,
		);
	}

	return value;
}

/**
 * The failures that are not worth clicking through.
 *
 * A consent page is deliberately not answered here. Accepting terms on someone's behalf is not
 * this library's decision to make, and the honest move is to say so and offer them the visible
 * webview, where they can answer it once against a persistent partition.
 */
function refuseUnreadable(state: PageState): void {
	if (/\bconsent\.(youtube|google)\.[a-z.]+/i.test(state.url)) {
		throw new TranscriptError(
			"consent-required",
			"YouTube is asking for a consent decision. Run this once with `visible: true` and a persistent `partition`, answer it yourself, and it will be remembered.",
			state.url,
		);
	}

	if (state.playability === "LOGIN_REQUIRED" || /sign in|confirm your age/i.test(state.playabilityReason)) {
		throw new TranscriptError(
			"sign-in-required",
			"This video needs a signed-in account — age-restricted, private, or members only.",
			state.playabilityReason || state.playability,
		);
	}

	if (state.tracks.length === 0) {
		throw new TranscriptError(
			"no-captions",
			state.live
				? "This is a live stream, and YouTube does not offer a transcript for it."
				: "This video has no captions, so there is no transcript to read.",
			state.playabilityReason || undefined,
		);
	}
}

/** Expand the description if it is collapsed, then click the control until the panel opens. */
async function openPanel(
	view: WebviewLike,
	state: PageState,
	options: ExtractOptions,
	timings: Timings,
	signal?: AbortSignal,
): Promise<void> {
	let target: Target = state.target;

	if (target === "expander") {
		const expanded = await press(view, timings, signal);
		if (!expanded.clicked) throw blocked(expanded.blockedBy, "expand the description");

		const after = await until(
			() => runScript(view, describe),
			(next) => next.target === "transcript",
			{ timeoutMs: timings.expandMs, intervalMs: timings.pollMs, signal },
		);
		target = after.value.target;
	}

	if (target !== "transcript") {
		throw new TranscriptError(
			"no-button",
			"This video has captions, but nothing in the page opens a transcript. YouTube may have moved the control.",
			`target=${target}`,
		);
	}

	options.onProgress?.("opening-panel");

	let lastBlocker: string | undefined;

	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const hit = await press(view, timings, signal);
		if (!hit.clicked) {
			lastBlocker = hit.blockedBy;
			await delay(timings.retryMs, signal);
			continue;
		}

		const opened = await until(
			() => runScript(view, describe),
			(next) => next.segments > 0 || (next.panel ?? "").includes("EXPANDED"),
			{ timeoutMs: timings.panelMs, intervalMs: timings.pollMs, signal },
		);

		if (opened.settled) return;
	}

	throw new TranscriptError(
		"panel-never-opened",
		lastBlocker
			? "Something kept covering the transcript button."
			: "The transcript button was clicked and the panel never opened.",
		lastBlocker,
	);
}

interface Press {
	clicked: boolean;
	blockedBy?: string;
}

/**
 * Scroll to the control, check what is under the point, and click it for real.
 *
 * The pause between scrolling and measuring is not superstition: `scrollIntoView` returns
 * before the layout it caused has settled, and a rect measured in that gap is a coordinate
 * pointing at whatever used to be there.
 *
 * Being covered is treated as temporary rather than fatal. A hover card, a promo dialog or a
 * consent backdrop sits over the control for a moment and then goes; a trusted click during
 * that moment does not fail, it activates the thing on top, which is worse. So it waits.
 */
async function press(view: WebviewLike, timings: Timings, signal?: AbortSignal): Promise<Press> {
	let blockedBy: string | undefined;

	for (let attempt = 0; attempt < COVERED_ATTEMPTS; attempt++) {
		const found = await runScript(view, focus);
		if (!found.found) return { clicked: false };

		await delay(timings.settleMs, signal);

		const shot = await runScript(view, aim);
		if (!shot.found) return { clicked: false };

		if (shot.clear) {
			await trustedClick(view, shot);
			return { clicked: true };
		}

		blockedBy = shot.onTop;
		await delay(timings.retryMs, signal);
	}

	return { clicked: false, blockedBy };
}

function blocked(by: string | undefined, what: string): TranscriptError {
	return new TranscriptError(
		"no-button",
		by ? `Could not ${what}: a ${by} was in the way.` : `Could not ${what}.`,
		by,
	);
}

/**
 * Read the panel once it has stopped growing.
 *
 * The list renders progressively, so "there are segments" is not the same as "there are all the
 * segments". Two consecutive reads at the same count is the cheapest honest end condition, and
 * a timeout here is not fatal — whatever has rendered by then is still a transcript.
 */
async function collect(
	view: WebviewLike,
	timeoutMs: number,
	timings: Timings,
	signal?: AbortSignal,
): Promise<Cue[]> {
	let previous = -1;

	const { value: segments } = await until(
		() => runScript(view, read),
		(found) => {
			const stable = found.length > 0 && found.length === previous;
			previous = found.length;
			return stable;
		},
		{ timeoutMs, intervalMs: timings.pollMs, signal },
	);

	if (segments.length === 0) {
		throw new TranscriptError("no-segments", "The transcript panel opened but rendered nothing.");
	}

	const cues: Cue[] = [];
	let last = 0;

	for (const segment of segments) {
		// Exact when the build carries it, the printed clock otherwise, and failing both the
		// previous cue's moment — losing a second of precision beats losing the words.
		const start = segment.ms !== null ? segment.ms / 1000 : (parseClock(segment.stamp) ?? last);
		last = start;
		cues.push({ start, text: segment.text });
	}

	return cues;
}
