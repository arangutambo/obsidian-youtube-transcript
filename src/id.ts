/**
 * Getting a video id out of whatever was pasted.
 *
 * The id is the only stable handle: it survives the tracking parameters a share sheet adds,
 * the `si=` token, the redirect wrapper a search result arrives in, and the difference between
 * `youtube.com/watch`, `youtu.be` and an embed. The watch page is loaded from the id, never
 * from the string someone handed over.
 */

/** Eleven characters of URL-safe base64. YouTube has never used anything else. */
const ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id in a URL or a bare id, or undefined. */
export function videoIdFrom(input: string): string | undefined {
	const raw = input.trim();
	if (raw === "") return undefined;

	if (ID.test(raw)) return raw;

	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		return undefined;
	}

	// A redirector carries the real URL in a parameter; recurse into it rather than guessing.
	const wrapped = url.searchParams.get("url") ?? url.searchParams.get("q");
	if (wrapped && /youtu/.test(wrapped)) return videoIdFrom(wrapped);

	const host = url.hostname.replace(/^(www|m|music)\./, "");

	if (host === "youtu.be") return check(url.pathname.slice(1));

	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		const v = url.searchParams.get("v");
		if (v) return check(v);

		// /embed/<id>, /shorts/<id>, /live/<id>, /v/<id> all put it in the path.
		const match = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
		if (match) return check(match[1]);
	}

	return undefined;
}

function check(candidate: string): string | undefined {
	return ID.test(candidate) ? candidate : undefined;
}

/**
 * The watch URL to load, in English.
 *
 * `hl=en` is not cosmetic. The transcript control is found partly by its accessible name, and
 * pinning the interface language means that name is "Show transcript" on every machine rather
 * than whatever the account's locale happens to be.
 */
export function watchUrl(id: string): string {
	return `https://www.youtube.com/watch?v=${id}&hl=en`;
}

/**
 * The lightest youtube.com document that still carries an InnerTube key.
 *
 * The caption request is same-origin rather than page-specific, so it does not need the watch
 * page — and not loading one saves a couple of megabytes of markup and a video that would
 * otherwise start buffering.
 */
export function homeUrl(): string {
	return "https://www.youtube.com/?hl=en";
}

export function isVideoUrl(input: string): boolean {
	return videoIdFrom(input) !== undefined;
}
