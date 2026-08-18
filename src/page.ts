/**
 * What gets asked of the page, and what comes back.
 *
 * Every one of these runs inside the guest through `executeJavaScript` and returns a JSON
 * string rather than an object. That is deliberate: `executeJavaScript` structure-clones its
 * result, and a live DOM node or a Polymer object anywhere in the graph turns a working script
 * into an opaque serialisation failure. A string always survives the trip.
 *
 * Each script carries an `/@id/`-style marker as its first token, which does two things — it
 * makes a failure greppable in a stack trace, and it gives the test fake something to match on
 * so the whole sequence can be exercised without a browser engine.
 *
 * These selectors are the part of this library that YouTube can break. They are all here, in
 * one file, for that reason.
 */

import type { CaptionTrack } from "./cues.js";
import { TranscriptError } from "./errors.js";
import type { WebviewLike } from "./types.js";

export interface PageScript<T> {
	readonly id: string;
	readonly code: string;
	/** Phantom: the shape this script's JSON parses to. Never present at runtime. */
	readonly __result?: T;
}

/**
 * Finding the control that opens the transcript.
 *
 * Three routes, in descending order of how sure they are. The description's own transcript
 * section is the real thing when it is there. Failing that, anything whose accessible name
 * mentions a transcript — reliable because the page is loaded with `hl=en`, so that name is not
 * at the mercy of the account's locale. Failing that, the description is still collapsed and
 * the transcript section has not been rendered at all, so the answer is the expander and the
 * caller comes back around.
 */
const FIND = `
function find() {
	var section = document.querySelector("ytd-video-description-transcript-section-renderer");
	if (section) {
		var direct = section.querySelector("button, tp-yt-paper-button");
		if (direct) return { kind: "transcript", el: direct };
	}

	var labelled = Array.prototype.slice.call(document.querySelectorAll(
		"button[aria-label], tp-yt-paper-button[aria-label], a[aria-label]"
	)).filter(function (node) {
		var label = (node.getAttribute("aria-label") || "").toLowerCase();
		if (label.indexOf("transcript") === -1) return false;
		// "Close transcript" is the panel's own button; clicking it undoes the work.
		if (label.indexOf("close") !== -1) return false;
		return node.offsetParent !== null;
	});
	if (labelled.length) return { kind: "transcript", el: labelled[0] };

	var expander = document.querySelector(
		"ytd-text-inline-expander tp-yt-paper-button#expand, #description-inline-expander tp-yt-paper-button#expand, ytd-text-inline-expander #expand"
	);
	if (expander && expander.offsetParent !== null) return { kind: "expander", el: expander };

	return { kind: "none", el: null };
}
`;

function script<T>(id: string, body: string, prelude = ""): PageScript<T> {
	return { id, code: `/*@${id}*/(function () {${prelude}${body}})()` };
}

/** What the transcript control is, when there is one. */
export type Target = "transcript" | "expander" | "none";

export interface PageState {
	url: string;
	/** The player response has landed. Until then the page knows nothing worth reading. */
	ready: boolean;
	title: string;
	author: string;
	durationSeconds: number;
	live: boolean;
	/** `OK`, `LOGIN_REQUIRED`, `UNPLAYABLE`, … straight from `playabilityStatus`. */
	playability: string;
	playabilityReason: string;
	/** Every caption track YouTube admits to. Empty means there is nothing to extract. */
	tracks: CaptionTrack[];
	/** `VISIBILITY_EXPANDED`, `VISIBILITY_HIDDEN`, or null when the panel is not in the DOM. */
	panel: string | null;
	segments: number;
	target: Target;
}

/**
 * Everything worth knowing about the page in one round trip.
 *
 * `captionTracks` is read straight out of the player response, which is why a video with no
 * captions can be refused before a single click is sent. That check is the difference between
 * a clear "this video has no captions" and thirty seconds of clicking at nothing.
 */
export const describe: PageScript<PageState> = script(
	"describe",
	`
	var r = window.ytInitialPlayerResponse;
	var tracks = [];
	try { tracks = r.captions.playerCaptionsTracklistRenderer.captionTracks || []; } catch (e) { tracks = []; }

	var details = (r && r.videoDetails) || {};
	var status = (r && r.playabilityStatus) || {};
	var panel = document.querySelector(
		'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
	);
	var found = find();

	return JSON.stringify({
		url: location.href,
		ready: !!r,
		title: details.title || document.title.replace(/ - YouTube$/, ""),
		author: details.author || "",
		durationSeconds: Number(details.lengthSeconds || 0),
		live: !!details.isLiveContent,
		playability: status.status || "",
		playabilityReason: status.reason || "",
		tracks: tracks.map(function (t) {
			var name = "";
			if (t.name) {
				name = t.name.simpleText || (t.name.runs || []).map(function (x) { return x.text; }).join("");
			}
			return { languageCode: t.languageCode || "", name: name, auto: t.kind === "asr" };
		}),
		panel: panel ? (panel.getAttribute("visibility") || "") : null,
		segments: document.querySelectorAll("ytd-transcript-segment-renderer").length,
		target: found.kind
	});
	`,
	FIND,
);

export interface Focus {
	found: boolean;
	kind: Target;
}

/**
 * Scroll the control into view.
 *
 * A trusted click lands at a window coordinate, so the thing being clicked has to be on screen
 * — off-screen there is no coordinate that hits it, and the event goes to whatever is.
 */
export const focus: PageScript<Focus> = script(
	"focus",
	`
	var found = find();
	if (!found.el) return JSON.stringify({ found: false, kind: "none" });

	found.el.scrollIntoView({ block: "center", inline: "center" });
	return JSON.stringify({ found: true, kind: found.kind });
	`,
	FIND,
);

export type Aim =
	| { found: false }
	| {
		found: true;
		kind: Target;
		x: number;
		y: number;
		width: number;
		height: number;
		inView: boolean;
		/** `elementFromPoint` at the centre resolves to the target rather than something over it. */
		clear: boolean;
		/** What was on top, when something was. For the error message. */
		onTop: string;
	};

/**
 * Where to click, and whether clicking there will reach the target.
 *
 * The hit test is not defensive padding. A trusted click is genuinely trusted, so it activates
 * whatever is actually under the point — a consent sheet, a promo dialog, a hover preview — and
 * a click that lands on the wrong thing is worse than one that never happens.
 */
export const aim: PageScript<Aim> = script(
	"aim",
	`
	var found = find();
	if (!found.el) return JSON.stringify({ found: false });

	var el = found.el;
	var box = el.getBoundingClientRect();
	var cx = box.left + box.width / 2;
	var cy = box.top + box.height / 2;

	var hit = document.elementFromPoint(cx, cy);
	var clear = !!hit && (hit === el || el.contains(hit) || hit.contains(el));

	return JSON.stringify({
		found: true,
		kind: found.kind,
		x: cx,
		y: cy,
		width: box.width,
		height: box.height,
		inView: box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= (window.innerHeight || 0),
		clear: clear,
		onTop: hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") : ""
	});
	`,
	FIND,
);

export interface RawSegment {
	/** Milliseconds from `data-start-ms`, when the build provides it. */
	ms: number | null;
	/** The clock the panel prints, as a fallback. */
	stamp: string;
	text: string;
}

/**
 * The transcript, as rendered.
 *
 * Two sources of timing because builds differ: `data-start-ms` is exact when it is there, and
 * the printed clock is always there but only to the second. Preferring the attribute costs
 * nothing and keeps sub-second cues honest where they exist.
 */
export const read: PageScript<RawSegment[]> = script(
	"read",
	`
	var out = [];
	var nodes = document.querySelectorAll("ytd-transcript-segment-renderer");

	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		var seg = node.querySelector(".segment") || node;
		var raw = seg.getAttribute("data-start-ms") || node.getAttribute("data-start-ms");
		var ms = raw === null || raw === undefined || raw === "" ? null : Number(raw);

		var stampNode = node.querySelector(".segment-timestamp");
		var textNode = node.querySelector(".segment-text");
		var stamp = ((stampNode && stampNode.textContent) || "").trim();
		var text = (((textNode && textNode.textContent) || node.textContent) || "").replace(/\\s+/g, " ").trim();

		// Without .segment-text the stamp is glued to the front of the node's text.
		if (stamp && text.indexOf(stamp) === 0) text = text.slice(stamp.length).trim();
		if (text === "") continue;

		out.push({ ms: ms !== null && isFinite(ms) ? ms : null, stamp: stamp, text: text });
	}

	return JSON.stringify(out);
	`,
);

/** Run a script in the guest and parse what it says. */
export async function runScript<T>(view: WebviewLike, page: PageScript<T>): Promise<T> {
	let raw: unknown;
	try {
		raw = await view.executeJavaScript(page.code);
	} catch (error) {
		throw new TranscriptError(
			"load-failed",
			"The page would not run the script that reads the transcript.",
			`${page.id}: ${String(error)}`,
		);
	}

	if (typeof raw !== "string") {
		throw new TranscriptError("load-failed", "The page returned something unreadable.", page.id);
	}

	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new TranscriptError("load-failed", "The page returned malformed JSON.", page.id);
	}
}
