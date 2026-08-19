/**
 * The caption request, exercised as the browser would run it.
 *
 * `playerScript` is a string that executes inside the guest, so testing the function that
 * returns it would assert nothing. Instead the script itself is evaluated here with `window`
 * and `fetch` supplied as parameters — the same free variables it uses in the page — against
 * canned InnerTube responses. What is under test is the logic that actually ships.
 */

import { describe, expect, it } from "vitest";

import { playerScript } from "../src/innertube.js";

interface Canned {
	player: unknown;
	playerStatus?: number;
	captions?: string;
	captionStatus?: number;
}

/** Run the guest script with a stubbed page around it, and return what it decided. */
async function run(videoId: string, canned: Canned, language?: string): Promise<Record<string, unknown>> {
	const calls: string[] = [];

	const fetchStub = async (url: string): Promise<unknown> => {
		calls.push(url);

		if (url.includes("/youtubei/v1/player")) {
			const status = canned.playerStatus ?? 200;
			return { ok: status >= 200 && status < 300, status, json: async () => canned.player };
		}

		const status = canned.captionStatus ?? 200;
		return { ok: status >= 200 && status < 300, status, text: async () => canned.captions ?? "" };
	};

	const windowStub = { ytcfg: { get: (key: string) => (key === "INNERTUBE_API_KEY" ? "TEST_KEY" : undefined) } };

	const factory = new Function("window", "fetch", `return ${playerScript(videoId, language)}`);
	const raw = (await factory(windowStub, fetchStub)) as string;

	return { ...(JSON.parse(raw) as Record<string, unknown>), __calls: calls };
}

function track(languageCode: string, name: string, kind?: string) {
	return { languageCode, name: { simpleText: name }, kind, baseUrl: `https://youtube.com/api/timedtext?lang=${languageCode}` };
}

function playerWith(tracks: unknown[], extra: Record<string, unknown> = {}) {
	return {
		playabilityStatus: { status: "OK" },
		videoDetails: { title: "A video", author: "Someone", lengthSeconds: "213" },
		captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
		...extra,
	};
}

const JSON3 = JSON.stringify({
	events: [
		{ tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " there" }] },
		{ tStartMs: 1500, segs: [{ utf8: "\n" }] },
		{ tStartMs: 2250, segs: [{ utf8: "second   cue" }] },
		{ tStartMs: 9000 },
	],
});

describe("the caption request", () => {
	it("turns a player response and a json3 track into cues", async () => {
		const result = await run("abc12345678", { player: playerWith([track("en", "English")]), captions: JSON3 });

		expect(result.ok).toBe(true);
		expect(result.title).toBe("A video");
		expect(result.durationSeconds).toBe(213);
		expect(result.cues).toEqual([
			{ start: 0, text: "Hello there" },
			{ start: 2.25, text: "second cue" },
		]);
	});

	it("asks for json3, because the default format has coarser timings", async () => {
		const result = await run("abc12345678", { player: playerWith([track("en", "English")]), captions: JSON3 });
		expect((result.__calls as string[]).some((url) => url.includes("fmt=json3"))).toBe(true);
	});

	it("says there are no captions rather than inventing an empty transcript", async () => {
		const result = await run("abc12345678", { player: playerWith([]) });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no-captions");
	});

	it("marks a live stream, so the message can say why", async () => {
		const player = playerWith([], { videoDetails: { title: "Live", isLiveContent: true, lengthSeconds: "0" } });
		const result = await run("abc12345678", { player });
		expect(result.reason).toBe("no-captions");
		expect(result.live).toBe(true);
	});

	it("names an account wall instead of retrying at it", async () => {
		const player = { playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" } };
		const result = await run("abc12345678", { player });
		expect(result.reason).toBe("sign-in-required");
	});

	/**
	 * The whole reason this route exists: a gated caption URL answers 200 with nothing in it.
	 * Parsing that as "a transcript with no cues" would report success and write an empty note.
	 */
	it("treats an empty 200 as a refusal, not as a transcript", async () => {
		const result = await run("abc12345678", { player: playerWith([track("en", "English")]), captions: "" });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no-segments");
		expect(String(result.detail)).toContain("gated");
	});

	it("prefers a written track over a recogniser's guess", async () => {
		const player = playerWith([track("en", "English (auto-generated)", "asr"), track("en", "English")]);
		const result = await run("abc12345678", { player, captions: JSON3 });
		expect((result.track as { auto: boolean }).auto).toBe(false);
	});

	it("honours a requested language even when another is listed first", async () => {
		const player = playerWith([track("en", "English"), track("fr", "French")]);
		const result = await run("abc12345678", { player, captions: JSON3 }, "fr");
		expect((result.track as { languageCode: string }).languageCode).toBe("fr");
	});

	it("reports a refused player request rather than throwing something shapeless", async () => {
		const result = await run("abc12345678", { player: {}, playerStatus: 400 });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("load-failed");
		expect(String(result.detail)).toContain("400");
	});
});
