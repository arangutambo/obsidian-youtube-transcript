/**
 * Which control actually opens the transcript.
 *
 * The extraction finds a button whose accessible name is "Show transcript", aims at it, reports
 * the point as unobstructed, clicks it for real — and on most videos the transcript panel stays
 * hidden while a decoy panel under the *same* target-id, headed "In this video", opens instead.
 *
 * A page carries more than one control that says "Show transcript": one in the inline
 * description, one inside the structured-description panel, sometimes more. `find()` takes the
 * first visible one, which was never a reasoned choice. This tries each of them in turn, one per
 * page load so no click contaminates the next, and reports which one — if any — actually opens a
 * panel that fills with segments.
 */

import { openHost } from "../src/host.js";
import { aim, describe, focus, runScript } from "../src/page.js";
import { trustedClick } from "../src/trusted.js";
import type { WebviewLike } from "../src/types.js";
import { videoIdFrom } from "../src/id.js";

declare const require: (id: string) => any;

/** Every control that claims to show a transcript, and where in the page it lives. */
const CANDIDATES = `/*@candidates*/(function () {
	function where(el) {
		// The panel it lives in, if any — that is the distinction that matters, because a
		// control inside an engagement panel and one in the description are different things.
		var panel = el.closest("ytd-engagement-panel-section-list-renderer");
		if (panel) {
			var header = panel.querySelector("h2#title, #title-text");
			return "panel[" + (panel.getAttribute("target-id") || "?") + "]" +
				(header ? " header=" + (header.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24) : "");
		}
		if (el.closest("ytd-watch-metadata")) return "watch-metadata (inline description)";
		if (el.closest("#below")) return "#below";
		if (el.closest("#secondary")) return "#secondary";
		return "elsewhere";
	}

	var seen = [];
	var nodes = document.querySelectorAll("button, tp-yt-paper-button, a, yt-button-shape, ytd-button-renderer");

	for (var i = 0; i < nodes.length; i++) {
		var el = nodes[i];
		var label = (el.getAttribute("aria-label") || "").toLowerCase();
		var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
		var lower = text.toLowerCase();

		if (label.indexOf("transcript") === -1 && lower.indexOf("transcript") === -1) continue;
		if (label.indexOf("close") !== -1) continue;
		if (el.offsetParent === null) continue;

		var box = el.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0) continue;

		// Only the innermost clickable of a nest: ytd-button-renderer wraps yt-button-shape
		// wraps button, and all three match. Clicking the wrapper is not the same act.
		var nested = false;
		for (var s = 0; s < seen.length; s++) {
			if (seen[s].el !== el && seen[s].el.contains(el)) { seen[s].superseded = true; }
			if (el.contains(seen[s].el)) nested = true;
		}

		seen.push({ el: el, nested: nested, box: box, label: label, text: text });
	}

	var out = [];
	for (var k = 0; k < seen.length; k++) {
		var c = seen[k];
		if (c.nested) continue;

		var cx = c.box.left + c.box.width / 2;
		var cy = c.box.top + c.box.height / 2;
		var hit = document.elementFromPoint(cx, cy);

		var relation = "none";
		if (hit === c.el) relation = "self";
		else if (c.el.contains(hit)) relation = "descendant";
		else if (hit && hit.contains(c.el)) relation = "ANCESTOR";
		else if (hit) relation = "unrelated";

		out.push({
			index: out.length,
			tag: c.el.tagName.toLowerCase(),
			label: c.el.getAttribute("aria-label") || "",
			text: c.text.slice(0, 40),
			where: where(c.el),
			box: { x: Math.round(cx), y: Math.round(cy), w: Math.round(c.box.width), h: Math.round(c.box.height) },
			inView: c.box.top >= 0 && c.box.bottom <= (window.innerHeight || 0),
			hit: hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + "." + String(hit.className || "").split(" ")[0] : "",
			// "ANCESTOR" means the button is not the top element at its own centre: a real
			// click there goes to the ancestor and never reaches the button's handler.
			relation: relation
		});
	}

	return JSON.stringify(out);
})()`;

/** Scroll candidate `i` into view and re-measure it, because scrolling moves everything. */
function focusCandidate(i: number): string {
	return `/*@focus-candidate*/(function () {
		var nodes = document.querySelectorAll("button, tp-yt-paper-button, a, yt-button-shape, ytd-button-renderer");
		var seen = [];
		for (var n = 0; n < nodes.length; n++) {
			var el = nodes[n];
			var label = (el.getAttribute("aria-label") || "").toLowerCase();
			var lower = (el.textContent || "").toLowerCase();
			if (label.indexOf("transcript") === -1 && lower.indexOf("transcript") === -1) continue;
			if (label.indexOf("close") !== -1) continue;
			if (el.offsetParent === null) continue;
			var b = el.getBoundingClientRect();
			if (b.width <= 0 || b.height <= 0) continue;
			var nested = false;
			for (var s = 0; s < seen.length; s++) if (el.contains(seen[s])) nested = true;
			if (nested) continue;
			seen.push(el);
		}

		var target = seen[${i}];
		if (!target) return JSON.stringify({ found: false });

		target.scrollIntoView({ block: "center", inline: "center" });
		var box = target.getBoundingClientRect();
		var cx = box.left + box.width / 2;
		var cy = box.top + box.height / 2;
		var hit = document.elementFromPoint(cx, cy);

		return JSON.stringify({
			found: true,
			x: cx,
			y: cy,
			relation: hit === target ? "self" : (target.contains(hit) ? "descendant" : (hit && hit.contains(target) ? "ANCESTOR" : "unrelated")),
			hit: hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") : ""
		});
	})()`;
}

/** Which transcript-ish panels exist, what they are headed, and whether they filled. */
const PANEL_STATE = `/*@panel-state*/(function () {
	var panels = Array.prototype.slice.call(document.querySelectorAll("ytd-engagement-panel-section-list-renderer"));
	return JSON.stringify({
		panels: panels.map(function (p) {
			var h = p.querySelector("h2#title, #title-text");
			return {
				targetId: p.getAttribute("target-id") || "",
				visibility: (p.getAttribute("visibility") || "").replace("ENGAGEMENT_PANEL_VISIBILITY_", ""),
				header: h ? (h.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 28) : "",
				segments: p.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer").length
			};
		}),
		totalSegments: document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer").length
	});
})()`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run<T>(view: WebviewLike, code: string): Promise<T> {
	return JSON.parse(String(await view.executeJavaScript(code))) as T;
}

export interface ProbeOptions {
	reportPath?: string;
	partition?: string;
	/** Leave the guest attached afterwards, so it can be inspected as its own CDP target. */
	keepOpen?: boolean;
	/** Present a different user agent to the page. */
	userAgent?: string;
	/** Which candidate to click. Omitted means enumerate only. */
	candidate?: number;
	/**
	 * Candidates to click in order, re-enumerating between each.
	 *
	 * The indices shift as the page responds — opening a panel puts new controls on screen —
	 * so each index is read against the enumeration made just before that click, not the first.
	 */
	sequence?: number[];
}

/**
 * Load the video, expand the description, and either list the candidates or click one.
 *
 * One click per page load. A click that opens the wrong panel changes what the next click would
 * even hit, so testing several against one page would measure the order rather than the buttons.
 */
export async function probe(input: string, options: ProbeOptions = {}): Promise<unknown> {
	const videoId = videoIdFrom(input);
	const reportPath = options.reportPath ?? "/tmp/probe.json";
	const report: Record<string, unknown> = { videoId, candidate: options.candidate ?? null };

	const write = () => {
		try { require("fs").writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch {}
	};

	if (!videoId) { report.fatal = "not a video"; write(); return report; }

	const host = await openHost(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
		partition: options.partition ?? "persist:youtube-transcript-verify",
		visible: true,
		userAgent: options.userAgent,
	});

	try {
		const view = host.view;

		// Wait for the page to build something rather than reading the shell it starts as.
		for (let i = 0; i < 60; i++) {
			const state = await runScript(view, describe);
			if (state.target !== "none") break;
			await sleep(500);
		}

		let state = await runScript(view, describe);
		report.targetBeforeExpand = state.target;

		// Expand the description, which is what puts the controls on screen at all.
		if (state.target === "expander") {
			await runScript(view, focus);
			await sleep(300);
			const shot = await runScript(view, aim);
			if (shot.found && shot.clear) await trustedClick(view, shot);
			for (let i = 0; i < 30; i++) {
				state = await runScript(view, describe);
				if (state.target === "transcript") break;
				await sleep(400);
			}
		}

		report.targetAfterExpand = state.target;
		await sleep(1200);

		report.candidates = await run(view, CANDIDATES);
		report.panelsBefore = await run(view, PANEL_STATE);
		write();

		if (options.sequence) {
			const steps: unknown[] = [];

			for (const index of options.sequence) {
				const listing = await run<{ index: number; label: string; text: string; where: string }[]>(view, CANDIDATES);
				const chosen = listing[index];

				const spot = await run<{ found: boolean; x: number; y: number; relation: string }>(view, focusCandidate(index));
				if (!spot.found) { steps.push({ index, missing: true }); break; }

				await sleep(400);
				const fresh = await run<typeof spot>(view, focusCandidate(index));
				await trustedClick(view, { x: fresh.x, y: fresh.y });

				const seen: unknown[] = [];
				for (let i = 0; i < 8; i++) {
					await sleep(1500);
					const st = await run<{ totalSegments: number }>(view, PANEL_STATE);
					seen.push({ atMs: (i + 1) * 1500, segments: st.totalSegments });
					if (st.totalSegments > 0) break;
				}

				steps.push({ index, clicked: chosen, aim: fresh, watched: seen });
				report.steps = steps;
				write();
			}

			report.panelsAfter = await run(view, PANEL_STATE);
			report.candidatesAfter = await run(view, CANDIDATES);
			write();
		} else if (options.candidate !== undefined) {
			const spot = await run<{ found: boolean; x: number; y: number; relation: string; hit: string }>(
				view,
				focusCandidate(options.candidate),
			);
			report.aimed = spot;

			if (spot.found) {
				await sleep(400);
				const fresh = await run<typeof spot>(view, focusCandidate(options.candidate));
				report.aimedFresh = fresh;
				await trustedClick(view, { x: fresh.x, y: fresh.y });

				// Give the panel time to open *and* to fill, which are two different waits.
				const seen: unknown[] = [];
				for (let i = 0; i < 12; i++) {
					await sleep(1500);
					const st = await run<{ totalSegments: number }>(view, PANEL_STATE);
					seen.push({ atMs: (i + 1) * 1500, ...(st as object) });
					if (st.totalSegments > 0) break;
				}
				report.after = seen;
				// What the click revealed. If opening "In this video" merely puts a second
				// control on screen, this is a two-step flow and the extraction stops one
				// step short — which would look exactly like a panel that never filled.
				report.candidatesAfter = await run(view, CANDIDATES);
				report.panelsAfter = await run(view, PANEL_STATE);
			}
		}

		write();
	} finally {
		if (options.keepOpen) {
			// Stashed rather than disposed: the guest is its own WebContents, so with the
			// window kept alive it shows up as a separate debugging target and its network
			// and console can be read directly.
			(window as any).__probeHost = host;
		} else {
			host.dispose();
		}
	}

	return report;
}
