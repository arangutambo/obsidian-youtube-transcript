/**
 * The webview the page is read out of.
 *
 * A `<webview>` is a whole separate renderer, which is what makes this work: YouTube gets the
 * origin, the cookies and the layout it expects, and the transcript is read out of the page it
 * actually built. Nothing is fetched from an undocumented endpoint and no token is forged.
 *
 * Two details are load-bearing. The guest is sized to a desktop viewport, because the control
 * that opens the transcript only exists in the desktop layout. And it is hidden with `opacity`
 * rather than `display: none` — a `display: none` webview is not attached, so it never loads,
 * never renders, and has no coordinates to click at.
 */

import { TranscriptError } from "./errors.js";
import type { WebviewLike } from "./types.js";

export interface HostOptions {
	/** Where to attach. Defaults to `document.body` with the library's own hidden styling. */
	parent?: HTMLElement;
	/** Session partition. A persistent one keeps a consent answer from being asked twice. */
	partition?: string;
	width?: number;
	height?: number;
	/** Show the guest. Needed once if YouTube wants a consent answer, and useful when debugging. */
	visible?: boolean;
	/** How long to wait for `dom-ready` before giving up. */
	readyTimeoutMs?: number;
	/**
	 * The user agent the guest presents.
	 *
	 * Defaults to Obsidian's own string with its `obsidian/…` and `Electron/…` tokens removed,
	 * which is what makes `get_transcript` answer at all. Set it to override that.
	 */
	userAgent?: string;
}

export interface Host {
	view: WebviewLike;
	dispose(): void;
}

/** Wide enough for the desktop layout, which is the only one with a transcript control. */
const WIDTH = 1280;
const HEIGHT = 800;

/**
 * The user agent, with the parts that are not a browser taken out.
 *
 * Obsidian identifies itself as `obsidian/1.8.9 … Chrome/132.0.6834.210 Electron/34.3.0`, and
 * those two extra tokens are load-bearing in the worst way: with them, YouTube's own
 * `get_transcript` call answers `400 FAILED_PRECONDITION` and the transcript panel spins for
 * ever. Take them out and the same request returns 200 with the whole transcript in it —
 * measured, on a video that returned nothing at all beforehand.
 *
 * This is not pretending to be something else. The engine really is Chrome 132; the tokens
 * removed are the ones describing the application wrapped around it, and what remains is the
 * truth about what is rendering the page. It is derived from the real string rather than
 * hard-coded so the Chrome version stays honest as Obsidian updates.
 */
function browserUserAgent(): string | undefined {
	if (typeof navigator === "undefined") return undefined;

	const real = navigator.userAgent;
	const stripped = real
		.replace(/\s*obsidian\/[\d.]+/i, "")
		.replace(/\s*Electron\/[\d.]+/i, "")
		.replace(/\s{2,}/g, " ")
		.trim();

	return stripped === real ? undefined : stripped;
}

/**
 * Whether this build of Obsidian can host a webview at all.
 *
 * Obsidian's own Web Viewer needs `webviewTag`, so it is on today, and the tag is absent on
 * mobile entirely. Probing the element is better than probing the platform: it answers the
 * question actually being asked, and it keeps answering it correctly if that setting ever moves.
 */
export function webviewsAvailable(): boolean {
	if (typeof document === "undefined") return false;

	const probe = document.createElement("webview") as Partial<WebviewLike>;
	return typeof probe.executeJavaScript === "function";
}

/** Attach a webview at `url` and resolve once its DOM is ready. */
export async function openHost(url: string, options: HostOptions = {}): Promise<Host> {
	if (!webviewsAvailable()) {
		throw new TranscriptError(
			"unsupported",
			"Reading a transcript needs the desktop app — there is no webview on mobile.",
		);
	}

	const width = options.width ?? WIDTH;
	const height = options.height ?? HEIGHT;

	const element = document.createElement("webview");
	element.setAttribute("allowpopups", "false");
	// Stops a hidden guest from streaming the video it was never asked to play.
	element.setAttribute("webpreferences", "autoplayPolicy=document-user-activation-required");
	if (options.partition) element.setAttribute("partition", options.partition);

	const userAgent = options.userAgent ?? browserUserAgent();
	if (userAgent) element.setAttribute("useragent", userAgent);

	// Blank first, then the real page. The `useragent` attribute is quietly ignored for the
	// load that attaching the element starts, so a guest created with its `src` already set
	// fetches the watch page under Obsidian's own user agent whatever the attribute says —
	// verified by reading `navigator.userAgent` inside the guest. Setting it on the live
	// guest and navigating afterwards is the only order that actually takes.
	element.setAttribute("src", "about:blank");

	style(element, options, width, height);

	const parent = options.parent ?? document.body;
	parent.appendChild(element);

	const view = element as unknown as WebviewLike;

	const timeout = options.readyTimeoutMs ?? 30_000;

	try {
		// about:blank, which is what makes the guest real enough to configure.
		await ready(view, timeout);

		if (userAgent) view.setUserAgent?.(userAgent);

		// Listen before navigating: `dom-ready` for a fast page can arrive before a listener
		// attached afterwards would exist.
		const loaded = ready(view, timeout);
		if (view.loadURL) void view.loadURL(url).catch(() => undefined);
		else element.setAttribute("src", url);
		await loaded;
	} catch (error) {
		element.remove();
		throw error;
	}

	view.setAudioMuted?.(true);

	return {
		view,
		dispose(): void {
			try {
				view.stop?.();
			} catch {
				// Already gone; removing it is what matters.
			}
			element.remove();
		},
	};
}

function style(element: HTMLElement, options: HostOptions, width: number, height: number): void {
	if (options.parent) {
		// The caller placed it; they own how it looks.
		element.style.cssText = "width: 100%; height: 100%; border: 0;";
		return;
	}

	const base = `position: fixed; top: 0; left: 0; width: ${width}px; height: ${height}px; border: 0;`;

	element.style.cssText = options.visible
		? `${base} z-index: 9999; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);`
		: // Laid out and rendering, but unseen and click-through. Not `display: none`, which
		  // would stop it loading altogether.
		  `${base} opacity: 0; pointer-events: none;`;
}

function ready(view: WebviewLike, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = (settle: () => void) => () => {
			clearTimeout(timer);
			view.removeEventListener("dom-ready", onReady);
			view.removeEventListener("did-fail-load", onFail);
			settle();
		};

		const onReady = done(resolve);
		const onFail = done(() =>
			reject(new TranscriptError("load-failed", "The watch page would not load.")),
		);

		const timer = setTimeout(
			done(() => reject(new TranscriptError("load-failed", "The watch page timed out."))),
			timeoutMs,
		);

		view.addEventListener("dom-ready", onReady);
		view.addEventListener("did-fail-load", onFail);
	});
}
