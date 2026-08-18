/**
 * The transcript itself, once it is out of the page.
 *
 * A cue is a phrase and the second it was said. That pair is the whole payload — the text is
 * what you quote, and the moment is what a frame capture needs. Everything else here is a way
 * of arranging those two fields for something downstream.
 *
 * No DOM, no Electron: this half of the library is ordinary data and is tested as such.
 */

/** One phrase, and when it was said. */
export interface Cue {
	/** Seconds into the video. */
	start: number;
	text: string;
}

/** A caption track YouTube says exists for a video. */
export interface CaptionTrack {
	languageCode: string;
	name: string;
	/** Automatic speech recognition rather than a track someone wrote. */
	auto: boolean;
}

export interface Transcript {
	videoId: string;
	title: string;
	author: string;
	/** Seconds, from the player response. Zero when the page did not say. */
	durationSeconds: number;
	/** The track the panel was showing, as far as the page reported it. */
	track?: CaptionTrack;
	cues: Cue[];
}

/**
 * `1:02:03`, `12:04` or `0:00` to seconds.
 *
 * The panel writes a clock, not a number, and it is the only timing the DOM offers on some
 * builds — `data-start-ms` is there on others and is preferred when it is. Returns undefined
 * rather than NaN so a malformed stamp is a skipped cue instead of a poisoned one.
 */
export function parseClock(stamp: string): number | undefined {
	const cleaned = stamp.trim();
	if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(cleaned)) return undefined;

	const parts = cleaned.split(":").map(Number);
	if (parts.some((part) => !Number.isFinite(part))) return undefined;

	// [s], [m, s] or [h, m, s] — fold from the right so all three shapes work.
	return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Roughly how long a paragraph runs before a new one starts, in seconds.
 *
 * Speech does not come with paragraphs, so the seam has to be invented, and time is the honest
 * basis for it: it groups what was said together and stays stable however the recogniser
 * happened to chop up its phrases.
 */
const PARAGRAPH_SECONDS = 30;

export interface Paragraph {
	index: number;
	start: number;
	text: string;
	cues: Cue[];
}

/** The cues as paragraphs you can actually read. */
export function toParagraphs(cues: readonly Cue[], seconds = PARAGRAPH_SECONDS): Paragraph[] {
	const out: Paragraph[] = [];
	let current: Paragraph | undefined;

	for (const cue of cues) {
		if (!current || cue.start - current.start >= seconds) {
			current = { index: out.length + 1, start: cue.start, text: "", cues: [] };
			out.push(current);
		}

		current.cues.push(cue);
		current.text = current.text === "" ? cue.text : `${current.text} ${cue.text}`;
	}

	return out;
}

/** `12:04`. */
export function clockOf(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;

	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Paragraphs separated by blank lines, with no timings. What you paste into a note. */
export function toPlainText(cues: readonly Cue[], seconds = PARAGRAPH_SECONDS): string {
	return toParagraphs(cues, seconds)
		.map((paragraph) => paragraph.text)
		.join("\n\n");
}

/**
 * WebVTT, for anything that already speaks subtitles.
 *
 * A cue ends when the next one starts; the last runs three seconds, which is about the length
 * of a spoken phrase and is only ever a display detail.
 */
export function toVtt(cues: readonly Cue[]): string {
	const lines = ["WEBVTT", ""];

	cues.forEach((cue, i) => {
		const end = cues[i + 1]?.start ?? cue.start + 3;
		lines.push(`${vttTime(cue.start)} --> ${vttTime(end)}`, cue.text, "");
	});

	return lines.join("\n");
}

function vttTime(seconds: number): string {
	const whole = Math.max(0, seconds);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;

	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
