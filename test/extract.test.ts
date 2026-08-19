/**
 * The sequence, asserted against a page that only answers to trusted input.
 *
 * The single most important assertion in this file is the one about `sendInputEvent`: the fake
 * changes nothing in response to a script, so any regression back to a synthetic `.click()`
 * turns these green tests red rather than silently doing nothing in Obsidian.
 */

import { describe, expect, it } from "vitest";
import { isTranscriptError, TranscriptError } from "../src/errors.js";
import { readTranscript, type Timings } from "../src/extract.js";
import { webviewsAvailable } from "../src/host.js";
import type { Stage } from "../src/types.js";
import { FakeWebview, type FakeOptions, withMs, withStamps } from "./fake-webview.js";

/** Fast enough for a test suite; the shape of the waiting is what is being asserted. */
const QUICK: Timings = {
	settleMs: 1,
	pollMs: 5,
	panelMs: 120,
	expandMs: 120,
	retryMs: 5,
	controlMs: 120,
};

function run(options: FakeOptions = {}, extra: { onProgress?: (stage: Stage) => void } = {}) {
	const view = new FakeWebview(options);
	return { view, result: readTranscript(view, "dQw4w9WgXcQ", { timings: QUICK, timeoutMs: 500, ...extra }) };
}

async function failure(options: FakeOptions): Promise<TranscriptError> {
	const { result } = run(options);
	try {
		await result;
	} catch (error) {
		if (isTranscriptError(error)) return error;
		throw error;
	}
	throw new Error("expected the extraction to fail");
}

describe("readTranscript", () => {
	it("expands the description, opens the panel and reads it out", async () => {
		const { view, result } = run({ segments: withMs(["hello there", "general kenobi"]) });
		const transcript = await result;

		expect(transcript.cues).toEqual([
			{ start: 0, text: "hello there" },
			{ start: 2, text: "general kenobi" },
		]);
		expect(transcript.videoId).toBe("dQw4w9WgXcQ");
		expect(view.scripts).toContain("focus");
	});

	it("opens the panel with trusted input, never with a script", async () => {
		const { view, result } = run({ segments: withMs(["a"]) });
		await result;

		// Two presses: one to expand the description, one on the control itself.
		const downs = view.clicks.filter((click) => click.type === "mouseDown");
		const ups = view.clicks.filter((click) => click.type === "mouseUp");
		const moves = view.clicks.filter((click) => click.type === "mouseMove");

		expect(downs).toHaveLength(2);
		expect(ups).toHaveLength(2);
		// The hover comes first, because some handlers bind on it.
		expect(moves).toHaveLength(2);
		expect(view.clicks[0].type).toBe("mouseMove");

		// Aimed at the control's centre, in the guest's own coordinates.
		expect(ups[1]).toMatchObject({ x: 210, y: 320, button: "left", clickCount: 1 });
	});

	it("skips the expander when the description is already open", async () => {
		const { view, result } = run({ expanded: true, segments: withMs(["a"]) });
		await result;

		expect(view.clicks.filter((click) => click.type === "mouseUp")).toHaveLength(1);
	});

	it("carries the video's own details through", async () => {
		const { result } = run({
			title: "A talk about caching",
			author: "Some channel",
			durationSeconds: 1_234,
			tracks: [{ languageCode: "en", name: "English", auto: false }],
			segments: withMs(["a"]),
		});

		const transcript = await result;

		expect(transcript.title).toBe("A talk about caching");
		expect(transcript.author).toBe("Some channel");
		expect(transcript.durationSeconds).toBe(1_234);
		expect(transcript.track).toEqual({ languageCode: "en", name: "English", auto: false });
	});

	it("reports each stage as it happens", async () => {
		const seen: Stage[] = [];
		const { result } = run({ segments: withMs(["a"]) }, { onProgress: (stage) => seen.push(stage) });
		await result;

		expect(seen).toEqual(["reading-page", "expanding-description", "opening-panel", "collecting", "done"]);
	});
});

describe("timings", () => {
	it("waits for the list to stop growing rather than reading it half-rendered", async () => {
		const phrases = ["one", "two", "three", "four", "five", "six"];
		const { result } = run({ segments: withMs(phrases), batch: 2 });

		const transcript = await result;

		expect(transcript.cues.map((cue) => cue.text)).toEqual(phrases);
	});

	it("prefers data-start-ms, and falls back to the printed clock", async () => {
		const exact = await run({ segments: [{ ms: 1_500, stamp: "0:01", text: "a" }] }).result;
		expect(exact.cues[0].start).toBe(1.5);

		const stamped = await run({ segments: withStamps(["a", "b"], 65) }).result;
		expect(stamped.cues.map((cue) => cue.start)).toEqual([0, 65]);
	});

	it("keeps the words when a segment has no usable timing at all", async () => {
		const transcript = await run({
			segments: [
				{ ms: 10_000, stamp: "", text: "timed" },
				{ ms: null, stamp: "", text: "untimed" },
			],
		}).result;

		expect(transcript.cues).toEqual([
			{ start: 10, text: "timed" },
			{ start: 10, text: "untimed" },
		]);
	});
});

describe("refusing early", () => {
	it("will not click at anything when the video has no captions", async () => {
		const view = new FakeWebview({ tracks: [] });
		await expect(readTranscript(view, "dQw4w9WgXcQ", { timings: QUICK })).rejects.toThrow(/no captions/i);

		// The whole point of reading the player response first.
		expect(view.clicks).toHaveLength(0);
	});

	it("says so when it is a live stream", async () => {
		const error = await failure({ tracks: [], live: true });

		expect(error.reason).toBe("no-captions");
		expect(error.message).toMatch(/live stream/i);
	});

	it("refuses a consent page instead of answering it", async () => {
		const error = await failure({ url: "https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com" });

		expect(error.reason).toBe("consent-required");
		expect(error.message).toMatch(/visible: true/);
	});

	it("names a sign-in wall for what it is", async () => {
		const error = await failure({ playability: "LOGIN_REQUIRED", playabilityReason: "Sign in to confirm your age" });

		expect(error.reason).toBe("sign-in-required");
	});

	it("says the control has moved when captions exist but nothing opens them", async () => {
		const error = await failure({ expanded: true, controlMissing: true, segments: withMs(["a"]) });

		expect(error.reason).toBe("no-button");
		expect(error.message).toMatch(/moved the control/);
	});

	it("gives up on a page that never produces a player", async () => {
		const view = new FakeWebview({ ready: false });
		const error = await readTranscript(view, "dQw4w9WgXcQ", { timings: QUICK, timeoutMs: 40 }).catch((e) => e);

		expect(isTranscriptError(error) && error.reason).toBe("load-failed");
	});
});

describe("retrying", () => {
	it("tries again when the click is swallowed, and gets there", async () => {
		const { view, result } = run({ swallowClicks: 2, segments: withMs(["a"]) });
		const transcript = await result;

		expect(transcript.cues).toHaveLength(1);
		// One press to expand, three at the control.
		expect(view.clicks.filter((click) => click.type === "mouseUp")).toHaveLength(4);
	});

	it("stops after three attempts and says the panel never opened", async () => {
		const error = await failure({ swallowClicks: 99, segments: withMs(["a"]) });

		expect(error.reason).toBe("panel-never-opened");
	});

	it("waits out something covering the control rather than clicking through it", async () => {
		// A backdrop is over the expander for one aim, then clears.
		const { view, result } = run({ blockFor: 1, segments: withMs(["a"]) });
		const transcript = await result;

		expect(transcript.cues).toHaveLength(1);
		// Nothing was clicked while it was covered.
		expect(view.clicks.filter((click) => click.type === "mouseUp")).toHaveLength(2);
	});

	it("gives up if the thing covering the control never goes away", async () => {
		const error = await failure({ blockFor: 99, segments: withMs(["a"]) });

		expect(error.reason).toBe("no-button");
		expect(error.detail).toBe("tp-yt-iron-overlay-backdrop");
	});

	it("tells an empty panel apart from one that never opened", async () => {
		const error = await failure({ segments: [] });

		expect(error.reason).toBe("no-segments");
	});
});

describe("webviewsAvailable", () => {
	it("is false where there is no document at all", () => {
		expect(webviewsAvailable()).toBe(false);
	});
});
