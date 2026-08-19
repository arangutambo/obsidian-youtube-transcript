/**
 * Running the extraction against real YouTube, from inside Obsidian.
 *
 * The README tells you to `require("obsidian-youtube-transcript")` in the console. That cannot
 * work: the package is not resolvable by name from Obsidian's renderer, and it is ESM, so
 * `require` of it throws `ERR_REQUIRE_ESM` even by absolute path. This file is bundled to CJS
 * so the console paste is two lines and the whole library comes with it.
 *
 * It does more than call `fetchTranscript`, on purpose. A failed run of the real thing tells you
 * one bit — `no-button`, say — and not which of the three routes in `page.ts` missed or what the
 * page actually had. So the page is surveyed first, in its own right, and everything is written
 * to a JSON file. A failure here should be enough to fix `page.ts` without a second run.
 */

import { isTranscriptError } from "../src/errors.js";
import { readTranscript } from "../src/extract.js";
import { openHost } from "../src/host.js";
import { videoIdFrom } from "../src/id.js";
import { describe, aim, focus, runScript } from "../src/page.js";
import type { Stage, WebviewLike } from "../src/types.js";

declare const require: (id: string) => any;

/**
 * What the page actually contains, independent of whether `find()` agrees.
 *
 * Every question `page.ts` asks is asked here in its raw form as well: not "did the transcript
 * route match" but "what does that selector match, what is its accessible name, is it on
 * screen". When FIND is wrong, the difference between those two is the fix.
 */
const SURVEY = `/*@survey*/(function () {
	function box(el) {
		var r = el.getBoundingClientRect();
		return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
	}

	function visible(el) {
		return el.offsetParent !== null;
	}

	function describeEl(el) {
		var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
		return {
			tag: el.tagName.toLowerCase(),
			id: el.id || "",
			label: el.getAttribute("aria-label") || "",
			text: text.length > 80 ? text.slice(0, 80) + "…" : text,
			visible: visible(el),
			box: box(el)
		};
	}

	// A census of what the page has actually built. ytInitialPlayerResponse arrives in the
	// initial HTML, so it being present says nothing about whether the app has rendered.
	var census = {};
	var all = document.getElementsByTagName("*");
	for (var i = 0; i < all.length; i++) {
		var tag = all[i].tagName.toLowerCase();
		if (tag.indexOf("-") > 0) census[tag] = (census[tag] || 0) + 1;
	}
	var topTags = Object.keys(census).sort(function (a, b) { return census[b] - census[a]; })
		.slice(0, 20).map(function (k) { return k + ":" + census[k]; });

	var r = window.ytInitialPlayerResponse;
	var tracks = [];
	try { tracks = r.captions.playerCaptionsTracklistRenderer.captionTracks || []; } catch (e) { tracks = []; }

	// Anything at all that mentions a transcript, by accessible name or by its own words.
	// Deliberately wider than find(): the point is to see what find() is choosing between.
	var mentions = Array.prototype.slice.call(
		document.querySelectorAll("button, tp-yt-paper-button, a, yt-button-shape, ytd-button-renderer")
	).filter(function (el) {
		var label = (el.getAttribute("aria-label") || "").toLowerCase();
		var text = (el.textContent || "").toLowerCase();
		return label.indexOf("transcript") !== -1 || text.indexOf("transcript") !== -1;
	}).slice(0, 25).map(describeEl);

	// The three routes in FIND, each reported separately so a miss is attributable.
	var section = document.querySelector("ytd-video-description-transcript-section-renderer");
	var expanderSelectors = [
		"ytd-text-inline-expander tp-yt-paper-button#expand",
		"#description-inline-expander tp-yt-paper-button#expand",
		"ytd-text-inline-expander #expand"
	];

	var panels = Array.prototype.slice.call(
		document.querySelectorAll("ytd-engagement-panel-section-list-renderer")
	).map(function (p) {
		var h = p.querySelector("h2#title, #title-text");
		return {
			targetId: p.getAttribute("target-id") || "",
			visibility: p.getAttribute("visibility") || "",
			title: h ? (h.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) : ""
		};
	});

	// Whatever panel is actually open, and what it is built out of. The panel that opens is
	// not necessarily the one the library watches for, and its segment nodes are not
	// necessarily the tag the library reads.
	var openPanel = document.querySelector('ytd-engagement-panel-section-list-renderer[visibility*="EXPANDED"]');
	var panelCensus = null;
	var panelSample = null;
	if (openPanel) {
		var pc = {};
		var inside = openPanel.getElementsByTagName("*");
		for (var j = 0; j < inside.length; j++) {
			var pt = inside[j].tagName.toLowerCase();
			if (pt.indexOf("-") > 0) pc[pt] = (pc[pt] || 0) + 1;
		}
		panelCensus = {
			targetId: openPanel.getAttribute("target-id") || "",
			visibility: openPanel.getAttribute("visibility") || "",
			elementCount: inside.length,
			tags: Object.keys(pc).sort(function (a, b) { return pc[b] - pc[a]; }).slice(0, 25).map(function (k) { return k + ":" + pc[k]; })
		};
		var ph = openPanel.outerHTML || "";
		panelSample = ph.length > 3000 ? ph.slice(0, 3000) + "…" : ph;
	}

	// The modern panel's segment node, whatever it turns out to be built from.
	var modern = document.querySelectorAll("transcript-segment-view-model");
	var modernSample = null;
	if (modern.length) {
		var mh = modern[0].outerHTML || "";
		modernSample = {
			count: modern.length,
			outerHTML: mh.length > 1800 ? mh.slice(0, 1800) + "…" : mh,
			text: (modern[0].textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
			attrs: Array.prototype.slice.call(modern[0].attributes).map(function (a) { return a.name + "=" + a.value; })
		};
	}

	var segments = document.querySelectorAll("ytd-transcript-segment-renderer");
	var firstSegment = null;
	if (segments.length) {
		var html = segments[0].outerHTML || "";
		firstSegment = {
			outerHTML: html.length > 1200 ? html.slice(0, 1200) + "…" : html,
			hasSegmentClass: !!segments[0].querySelector(".segment"),
			hasTimestamp: !!segments[0].querySelector(".segment-timestamp"),
			hasText: !!segments[0].querySelector(".segment-text"),
			startMs: (segments[0].querySelector(".segment") || segments[0]).getAttribute("data-start-ms")
		};
	}

	return JSON.stringify({
		url: location.href,
		title: document.title,
		readyState: document.readyState,
		ua: navigator.userAgent,
		htmlLength: document.documentElement.outerHTML.length,
		elementCount: all.length,
		topTags: topTags,
		rendered: {
			watchFlexy: !!document.querySelector("ytd-watch-flexy"),
			below: !!document.querySelector("#below"),
			watchMetadata: !!document.querySelector("ytd-watch-metadata"),
			description: !!document.querySelector("#description"),
			inlineExpander: !!document.querySelector("ytd-text-inline-expander"),
			buttonCount: document.querySelectorAll("button").length
		},
		hasPlayerResponse: !!r,
		trackCount: tracks.length,
		consentLooking: /consent\\.(youtube|google)\\./i.test(location.href),

		transcriptSection: section ? describeEl(section) : null,
		transcriptSectionButton: section && section.querySelector("button, tp-yt-paper-button")
			? describeEl(section.querySelector("button, tp-yt-paper-button"))
			: null,

		mentions: mentions,

		expanders: expanderSelectors.map(function (sel) {
			var el = document.querySelector(sel);
			return { selector: sel, found: !!el, visible: !!el && visible(el), box: el ? box(el) : null };
		}),

		panels: panels,
		panelCensus: panelCensus,
		modernSample: modernSample,
		panelSample: panelSample,
		segmentCount: segments.length,
		firstSegment: firstSegment,
		viewport: { w: window.innerWidth, h: window.innerHeight }
	});
})()`;

export interface VerifyOptions {
	/** Where the report lands. Read it from a shell rather than squinting at the console. */
	reportPath?: string;
	partition?: string;
	visible?: boolean;
	/** Leave the webview up afterwards so the page can be inspected by hand. */
	keepOpen?: boolean;
	/** When to snapshot the page, in ms after dom-ready. */
	snapshotsAtMs?: number[];
	/** Passed through to the extraction, for measuring how long a slow panel really takes. */
	timeoutMs?: number;
	/** After a failure, keep polling the open panel and report when segments finally land. */
	watchAfterFailMs?: number;
}

const DEFAULT_REPORT = "/tmp/youtube-transcript-verify.json";

/**
 * Load the page, survey it, then run the real extraction against it.
 *
 * The survey runs twice — before any click and again after the attempt — because the useful
 * question when it fails is which of the two states was wrong: a page that never offered the
 * control, or a panel that never came back.
 */
export async function verify(input: string, options: VerifyOptions = {}): Promise<unknown> {
	const reportPath = options.reportPath ?? DEFAULT_REPORT;
	const videoId = videoIdFrom(input);

	const report: Record<string, unknown> = {
		at: new Date().toISOString(),
		input,
		videoId,
		obsidian: (window as any).app?.appId ? "yes" : "unknown",
		electron: (process as any)?.versions?.electron ?? "unknown",
		chrome: (process as any)?.versions?.chrome ?? "unknown",
		stages: [] as string[],
	};

	const write = () => {
		try {
			require("fs").writeFileSync(reportPath, JSON.stringify(report, null, 2));
		} catch (error) {
			console.error("[verify] could not write report", error);
		}
	};

	if (videoId === undefined) {
		report.fatal = `not a YouTube video: ${input}`;
		write();
		console.error("[verify]", report.fatal);
		return report;
	}

	let host: { view: WebviewLike; dispose(): void } | undefined;

	try {
		console.log("[verify] opening watch page…");
		host = await openHost(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
			partition: options.partition ?? "persist:youtube-transcript-verify",
			visible: options.visible ?? true,
		});

		const view = host.view;

		// dom-ready fires long before YouTube's app has rendered anything below the player, so
		// snapshot on a schedule: a control that is absent at 2s and present at 8s is a waiting
		// bug, not a selector bug, and those need opposite fixes.
		const schedule = options.snapshotsAtMs ?? [2000, 5000, 9000, 14000];
		const snapshots: unknown[] = [];
		let waited = 0;

		for (const at of schedule) {
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - waited)));
			waited = at;
			const snap = JSON.parse(String(await view.executeJavaScript(SURVEY)));
			const probe = await runScript(view, describe);
			snapshots.push({ atMs: at, target: probe.target, panel: probe.panel, segments: probe.segments, survey: snap });
			console.log(`[verify] t=${at}ms target=${probe.target} panels=${snap.panels.length} expander=${snap.rendered.inlineExpander} mentions=${snap.mentions.length}`);
			report.snapshots = snapshots;
			write();
		}

		console.log("[verify] surveying page…");
		report.surveyBefore = JSON.parse(String(await view.executeJavaScript(SURVEY)));
		report.describeBefore = await runScript(view, describe);
		report.focusBefore = await runScript(view, focus);
		report.aimBefore = await runScript(view, aim);

		console.log("[verify] survey:", report.surveyBefore);
		console.log("[verify] describe:", report.describeBefore);
		write();

		console.log("[verify] running extraction…");
		try {
			const transcript = await readTranscript(view, videoId, {
				timeoutMs: options.timeoutMs,
				onProgress: (stage: Stage) => {
					(report.stages as string[]).push(stage);
					console.log("[verify] stage:", stage);
					write();
				},
			});

			report.ok = true;
			report.title = transcript.title;
			report.author = transcript.author;
			report.durationSeconds = transcript.durationSeconds;
			report.track = transcript.track;
			report.cueCount = transcript.cues.length;
			report.firstCues = transcript.cues.slice(0, 8);
			report.lastCues = transcript.cues.slice(-3);

			console.log(`[verify] OK — ${transcript.cues.length} cues from "${transcript.title}"`);
			console.log("[verify] first cues:", report.firstCues);
		} catch (error) {
			report.ok = false;
			report.error = isTranscriptError(error)
				? { reason: error.reason, message: error.message, detail: (error as any).detail }
				: { reason: "unknown", message: String(error) };
			console.error("[verify] extraction failed:", report.error);
		}

		// A panel that opened but had rendered nothing may simply not have finished fetching.
		// Watching it afterwards turns "it failed" into a number to set the timeout from.
		if (report.ok === false && (options.watchAfterFailMs ?? 0) > 0) {
			const deadline = Date.now() + (options.watchAfterFailMs ?? 0);
			const started = Date.now();
			const seen: unknown[] = [];

			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				const probe = await runScript(view, describe);
				seen.push({ atMs: Date.now() - started, segments: probe.segments, panel: probe.panel });
				console.log(`[verify] watch t=${Date.now() - started}ms segments=${probe.segments}`);
				if (probe.segments > 0) break;
			}

			report.watch = seen;
			write();
		}

		// Whatever happened, the state it happened into is the evidence.
		report.surveyAfter = JSON.parse(String(await view.executeJavaScript(SURVEY)));
		report.describeAfter = await runScript(view, describe);
		report.focusAfter = await runScript(view, focus);
		report.aimAfter = await runScript(view, aim);
		write();
	} catch (error) {
		report.ok = false;
		report.fatal = isTranscriptError(error)
			? { reason: error.reason, message: error.message, detail: (error as any).detail }
			: String(error);
		console.error("[verify] fatal:", report.fatal);
		write();
	} finally {
		if (host && !options.keepOpen) host.dispose();
	}

	console.log(`[verify] report written to ${reportPath}`);
	return report;
}
