/**
 * Why a transcript did not come back.
 *
 * Every failure here wants a different answer from the person reading it. A video with no
 * captions is not a bug and never will be; a consent page needs a human and cannot be clicked
 * through on their behalf; a missing webview means the wrong platform entirely. Collapsing
 * those into one "could not fetch transcript" throws away the only useful part.
 *
 * So there is one error type with a `reason` the caller can branch on, and a message already
 * written for a human to read.
 */

export type TranscriptFailure =
	/** No `<webview>`: Obsidian mobile, or a desktop build with `webviewTag` turned off. */
	| "unsupported"
	/** The watch page never loaded, or never got far enough to have a player response. */
	| "load-failed"
	/** YouTube served a consent interstitial. Someone has to answer it themselves. */
	| "consent-required"
	/** Age-restricted, private, or otherwise gated behind a signed-in account. */
	| "sign-in-required"
	/** The video genuinely has no caption track. Nothing to extract. */
	| "no-captions"
	/** Captions exist, but no control that opens the transcript could be found in the page. */
	| "no-button"
	/** The control was clicked and the panel stayed shut. */
	| "panel-never-opened"
	/** The panel opened and rendered nothing. */
	| "no-segments"
	/** The caller aborted. */
	| "cancelled";

export class TranscriptError extends Error {
	readonly reason: TranscriptFailure;
	/** What the page reported when it failed, when there was anything worth keeping. */
	readonly detail?: string;

	constructor(reason: TranscriptFailure, message: string, detail?: string) {
		super(message);
		this.name = "TranscriptError";
		this.reason = reason;
		this.detail = detail;
	}
}

/** True when `error` is one of ours, narrowed for a `catch`. */
export function isTranscriptError(error: unknown): error is TranscriptError {
	return error instanceof TranscriptError;
}
