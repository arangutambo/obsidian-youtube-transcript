/**
 * The Electron surface this needs, and not one method more.
 *
 * Everything that touches a real `<webview>` goes through this interface, which is what makes
 * the extraction testable at all: a fake implementing four methods can stand in for a browser
 * engine, and the ordering logic — expand, click, wait, read — gets asserted without Obsidian
 * running.
 *
 * It is deliberately structural rather than an import from `electron`. Obsidian bundles its own
 * Electron and the plugin never depends on the package.
 */

/** A mouse event as `sendInputEvent` wants it. Coordinates are CSS pixels inside the guest. */
export interface MouseInput {
	type: "mouseDown" | "mouseUp" | "mouseMove";
	x: number;
	y: number;
	button?: "left" | "middle" | "right";
	clickCount?: number;
}

/**
 * The parts of Electron's `<webview>` element used here.
 *
 * `sendInputEvent` is the whole reason this library exists: it originates the event in the
 * browser process, so the page receives it with `isTrusted === true`. A script in the page
 * cannot forge that, which is exactly why YouTube's handler ignores a synthetic `.click()`.
 */
export interface WebviewLike {
	executeJavaScript(code: string): Promise<unknown>;
	sendInputEvent(event: MouseInput): void | Promise<void>;
	getURL(): string;
	/** Present on a real webview. A hidden guest that plays sound is a bug you can hear. */
	setAudioMuted?(muted: boolean): void;
	/** Present on a real webview. Used to stop a page that is still loading when disposed. */
	stop?(): void;
	addEventListener(type: string, listener: (event?: unknown) => void): void;
	removeEventListener(type: string, listener: (event?: unknown) => void): void;
}

/** How far along the extraction is, for a status bar or a notice. */
export type Stage =
	| "loading"
	| "reading-page"
	| "expanding-description"
	| "opening-panel"
	| "collecting"
	| "done";
