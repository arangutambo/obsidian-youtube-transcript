/**
 * Asking YouTube's own player API for the captions, from inside a page it already trusts.
 *
 * This is the path that works, and it is worth being precise about why, because the obvious
 * reading — "so it was an HTTP request all along" — is the wrong lesson.
 *
 * The watch page's caption URLs carry `exp=xpe`, which means a proof-of-origin token is
 * required; fetch one without a token and it answers `200` with an empty body, which is exactly
 * what the `timedtext` investigation found. Clicking the transcript control instead makes the
 * page issue `get_transcript`, and on most videos that answers `400 FAILED_PRECONDITION` and
 * the panel spins for ever.
 *
 * But the player request can be made *as a different client*, and the caption URLs the iOS
 * client is given carry no `exp=xpe` at all. They fetch, in full, first time.
 *
 * The part that cannot be skipped is where the request is made from. This runs inside a real
 * youtube.com document in a real browser, so it is same-origin — no CORS, the session's own
 * cookies, YouTube's own API key read from `ytcfg`. An identical request from Node is a
 * cross-origin request from an unknown client, which is the thing being refused everywhere else.
 * The webview is still load-bearing; it just no longer has to be clicked.
 *
 * What comes back is better than what the panel showed: `json3` carries millisecond timings and
 * every phrase, where the rendered panel groups them and drops sub-second precision.
 */

import type { CaptionTrack, Cue, Transcript } from "./cues.js";
import { TranscriptError, type TranscriptFailure } from "./errors.js";
import type { WebviewLike } from "./types.js";

/**
 * The client the request claims to be.
 *
 * Not disguise for its own sake: it is a published client of the same API, and it is the one
 * whose caption URLs are not gated. `ANDROID_VR`, `TVHTML5_SIMPLY_EMBEDDED_PLAYER`,
 * `WEB_EMBEDDED_PLAYER` and `MWEB` were all tried against the same video and returned
 * `ERROR`/`UNPLAYABLE` with no caption tracks; `IOS` returned `OK` with a track that fetched
 * 151 KB of captions.
 */
const IOS_CLIENT = {
	clientName: "IOS",
	clientVersion: "20.03.02",
	deviceMake: "Apple",
	deviceModel: "iPhone16,2",
	osName: "iPhone",
	osVersion: "18.2.1.22C161",
	hl: "en",
	gl: "US",
} as const;

/** InnerTube's numeric id for the iOS client, which the header has to agree with. */
const IOS_CLIENT_ID = "5";

export interface InnertubeResult {
	ok: boolean;
	reason?: TranscriptFailure;
	detail?: string;
	live?: boolean;
	title?: string;
	author?: string;
	durationSeconds?: number;
	track?: CaptionTrack;
	tracks?: CaptionTrack[];
	cues?: Cue[];
}

/**
 * The whole thing, as one script run inside the guest.
 *
 * One round trip rather than several: the player response, the track choice and the caption
 * fetch all happen in the page, and only the finished cues cross back. A transcript is a few
 * hundred KB at worst, and `executeJavaScript` structure-clones its result — so a string is
 * returned, as everywhere else here.
 */
export function playerScript(videoId: string, language?: string): string {
	return `/*@innertube*/(async function () {
	function fail(reason, detail, extra) {
		return JSON.stringify(Object.assign({ ok: false, reason: reason, detail: detail || "" }, extra || {}));
	}

	var key = window.ytcfg && window.ytcfg.get && window.ytcfg.get("INNERTUBE_API_KEY");
	if (!key) return fail("load-failed", "no InnerTube key on this page");

	var response;
	try {
		var res = await fetch("/youtubei/v1/player?key=" + key + "&prettyPrint=false", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-YouTube-Client-Name": ${JSON.stringify(IOS_CLIENT_ID)},
				"X-YouTube-Client-Version": ${JSON.stringify(IOS_CLIENT.clientVersion)}
			},
			body: JSON.stringify({
				videoId: ${JSON.stringify(videoId)},
				context: { client: ${JSON.stringify(IOS_CLIENT)} },
				contentCheckOk: true,
				racyCheckOk: true
			})
		});
		if (!res.ok) return fail("load-failed", "player request answered " + res.status);
		response = await res.json();
	} catch (e) {
		return fail("load-failed", "player request failed: " + String(e));
	}

	var playability = (response && response.playabilityStatus) || {};
	var details = (response && response.videoDetails) || {};
	var status = playability.status || "";
	var why = playability.reason || "";

	if (status === "LOGIN_REQUIRED" || /sign in|confirm your age/i.test(why)) {
		return fail("sign-in-required", why || status);
	}

	var tracks = [];
	try { tracks = response.captions.playerCaptionsTracklistRenderer.captionTracks || []; } catch (e) { tracks = []; }

	function describeTrack(t) {
		var name = "";
		if (t.name) name = t.name.simpleText || (t.name.runs || []).map(function (x) { return x.text; }).join("");
		return { languageCode: t.languageCode || "", name: name, auto: t.kind === "asr" };
	}

	if (!tracks.length) {
		if (status !== "OK" && status !== "") return fail("load-failed", why || status);
		return fail("no-captions", why || "", { live: !!details.isLiveContent });
	}

	// The requested language when one was asked for, otherwise a track someone wrote in
	// preference to one a recogniser guessed, otherwise whatever YouTube lists first — which
	// is the same track the transcript panel would have opened on.
	var wanted = ${JSON.stringify(language ?? "")};
	var chosen = null;
	if (wanted) {
		for (var i = 0; i < tracks.length; i++) {
			if ((tracks[i].languageCode || "").toLowerCase().indexOf(wanted.toLowerCase()) === 0) { chosen = tracks[i]; break; }
		}
	}
	if (!chosen) {
		for (var j = 0; j < tracks.length; j++) { if (tracks[j].kind !== "asr") { chosen = tracks[j]; break; } }
	}
	if (!chosen) chosen = tracks[0];

	var data;
	try {
		// json3 rather than the default XML: millisecond timings, and no entity decoding to
		// get wrong.
		var capRes = await fetch(chosen.baseUrl + "&fmt=json3");
		if (!capRes.ok) return fail("no-segments", "captions answered " + capRes.status);
		var body = await capRes.text();
		// The gated URLs answer 200 with nothing in them. That is the failure this whole
		// approach exists to get around, so it is named rather than parsed.
		if (body.length === 0) return fail("no-segments", "captions came back empty (gated URL)");
		data = JSON.parse(body);
	} catch (e) {
		return fail("no-segments", "captions failed: " + String(e));
	}

	var cues = [];
	var events = (data && data.events) || [];
	for (var k = 0; k < events.length; k++) {
		var ev = events[k];
		if (!ev.segs) continue;
		var text = ev.segs.map(function (s) { return s.utf8 || ""; }).join("").replace(/\\s+/g, " ").trim();
		if (text === "") continue;
		cues.push({ start: (ev.tStartMs || 0) / 1000, text: text });
	}

	if (!cues.length) return fail("no-segments", "caption track parsed to nothing");

	return JSON.stringify({
		ok: true,
		title: details.title || "",
		author: details.author || "",
		durationSeconds: Number(details.lengthSeconds || 0),
		track: describeTrack(chosen),
		tracks: tracks.map(describeTrack),
		cues: cues
	});
})()`;
}

/** Run the request in the guest and turn what comes back into a transcript or a named failure. */
export async function readViaInnertube(
	view: WebviewLike,
	videoId: string,
	language?: string,
): Promise<Transcript> {
	let raw: unknown;
	try {
		raw = await view.executeJavaScript(playerScript(videoId, language));
	} catch (error) {
		throw new TranscriptError("load-failed", "The page would not run the caption request.", String(error));
	}

	if (typeof raw !== "string") {
		throw new TranscriptError("load-failed", "The caption request returned something unreadable.");
	}

	let result: InnertubeResult;
	try {
		result = JSON.parse(raw) as InnertubeResult;
	} catch {
		throw new TranscriptError("load-failed", "The caption request returned malformed JSON.");
	}

	if (!result.ok) {
		throw new TranscriptError(result.reason ?? "load-failed", messageFor(result), result.detail);
	}

	return {
		videoId,
		title: result.title ?? "",
		author: result.author ?? "",
		durationSeconds: result.durationSeconds ?? 0,
		track: result.track,
		cues: result.cues ?? [],
	};
}

function messageFor(result: InnertubeResult): string {
	switch (result.reason) {
		case "no-captions":
			return result.live
				? "This is a live stream, and YouTube does not offer a transcript for it."
				: "This video has no captions, so there is no transcript to read.";
		case "sign-in-required":
			return "This video needs a signed-in account — age-restricted, private, or members only.";
		case "no-segments":
			return "YouTube offered a caption track and then would not hand it over.";
		default:
			return "The transcript could not be read from YouTube's player.";
	}
}
