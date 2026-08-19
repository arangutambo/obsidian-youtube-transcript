/**
 * A YouTube watch page, modelled just far enough to test the sequence against.
 *
 * The one rule that makes this worth having: the fake changes state only in response to
 * `sendInputEvent`. Nothing a script does through `executeJavaScript` can open the panel, which
 * is exactly the behaviour that forced this design in the first place. A regression that goes
 * back to a synthetic click therefore fails here rather than in Obsidian.
 */

import type { CaptionTrack } from "../src/cues.js";
import type { Aim, Focus, PageState, RawSegment, Target } from "../src/page.js";
import type { MouseInput, WebviewLike } from "../src/types.js";

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const EXPANDER: Rect = { x: 100, y: 200, width: 220, height: 40 };
const TRANSCRIPT: Rect = { x: 100, y: 300, width: 220, height: 40 };

export interface FakeOptions {
	url?: string;
	ready?: boolean;
	title?: string;
	author?: string;
	durationSeconds?: number;
	live?: boolean;
	playability?: string;
	playabilityReason?: string;
	tracks?: CaptionTrack[];
	/** Whether the description starts expanded, i.e. whether the control is already there. */
	expanded?: boolean;
	/** Captions exist but no control opens them — YouTube moved it. */
	controlMissing?: boolean;
	segments?: RawSegment[];
	/** How many segments each `read` reveals, to model progressive rendering. */
	batch?: number;
	/** Report the first N aims as covered by something. */
	blockFor?: number;
	/** Ignore this many trusted clicks on the transcript control before opening. */
	swallowClicks?: number;
}

export class FakeWebview implements WebviewLike {
	readonly clicks: MouseInput[] = [];
	readonly scripts: string[] = [];

	private url: string;
	private expanded: boolean;
	private panelOpen = false;
	private revealed = 0;
	private aims = 0;
	private swallowed = 0;

	constructor(private readonly options: FakeOptions = {}) {
		this.url = options.url ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en";
		this.expanded = options.expanded ?? false;
	}

	getURL(): string {
		return this.url;
	}

	addEventListener(): void {
		// The host is not exercised here; these tests drive a view directly.
	}

	removeEventListener(): void {
		// As above.
	}

	async executeJavaScript(code: string): Promise<unknown> {
		const id = /^\/\*@([a-z]+)\*\//.exec(code)?.[1];
		this.scripts.push(id ?? "unknown");

		switch (id) {
			case "describe":
				return JSON.stringify(this.describe());
			case "focus":
				return JSON.stringify(this.focus());
			case "aim":
				return JSON.stringify(this.aim());
			case "read":
				return JSON.stringify(this.read());
			default:
				throw new Error(`the fake was asked to run an unknown script: ${code.slice(0, 60)}`);
		}
	}

	sendInputEvent(event: MouseInput): void {
		this.clicks.push(event);
		if (event.type !== "mouseUp") return;

		const target = this.target();
		const rect = target === "expander" ? EXPANDER : target === "transcript" ? TRANSCRIPT : undefined;
		if (!rect || !inside(rect, event)) return;

		if (target === "expander") {
			this.expanded = true;
			return;
		}

		if (this.swallowed < (this.options.swallowClicks ?? 0)) {
			this.swallowed++;
			return;
		}

		this.panelOpen = true;
	}

	private target(): Target {
		if (!(this.options.ready ?? true)) return "none";
		if (!this.expanded) return "expander";
		return this.options.controlMissing ? "none" : "transcript";
	}

	private describe(): PageState {
		return {
			url: this.url,
			ready: this.options.ready ?? true,
			title: this.options.title ?? "A video",
			author: this.options.author ?? "A channel",
			durationSeconds: this.options.durationSeconds ?? 212,
			live: this.options.live ?? false,
			playability: this.options.playability ?? "OK",
			playabilityReason: this.options.playabilityReason ?? "",
			tracks: this.options.tracks ?? [{ languageCode: "en", name: "English (auto-generated)", auto: true }],
			panel: this.panelOpen ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" : null,
			segments: this.panelOpen ? this.revealed : 0,
			target: this.target(),
		};
	}

	private focus(): Focus {
		const target = this.target();
		return { found: target !== "none", kind: target };
	}

	private aim(): Aim {
		const target = this.target();
		if (target === "none") return { found: false };

		const rect = target === "expander" ? EXPANDER : TRANSCRIPT;
		const covered = this.aims++ < (this.options.blockFor ?? 0);

		return {
			found: true,
			kind: target,
			control: target === "expander" ? 'tp-yt-paper-button [Show more]' : 'button [Show transcript]',
			x: rect.x + rect.width / 2,
			y: rect.y + rect.height / 2,
			width: rect.width,
			height: rect.height,
			inView: true,
			clear: !covered,
			onTop: covered ? "tp-yt-iron-overlay-backdrop" : "button",
		};
	}

	private read(): RawSegment[] {
		if (!this.panelOpen) return [];

		const all = this.options.segments ?? [];
		this.revealed = Math.min(all.length, this.revealed + (this.options.batch ?? all.length));
		return all.slice(0, this.revealed);
	}
}

function inside(rect: Rect, at: { x: number; y: number }): boolean {
	return at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;
}

/** Segments the way a build that carries `data-start-ms` renders them. */
export function withMs(phrases: string[], everyMs = 2_000): RawSegment[] {
	return phrases.map((text, i) => ({ ms: i * everyMs, stamp: "", text }));
}

/** Segments the way a build that only prints a clock renders them. */
export function withStamps(phrases: string[], everySeconds = 2): RawSegment[] {
	return phrases.map((text, i) => {
		const total = i * everySeconds;
		const stamp = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
		return { ms: null, stamp, text };
	});
}
