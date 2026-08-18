/**
 * Waiting for a page that renders when it feels like it.
 *
 * None of the steps here have an event to listen for. Polymer upgrades its elements over
 * several frames, the engagement panel is populated after its own request comes back, and the
 * transcript list grows as it renders. So the shape is always the same: ask the page, decide
 * whether the answer is good enough yet, ask again.
 */

import { TranscriptError } from "./errors.js";

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new TranscriptError("cancelled", "Cancelled."));
			return;
		}

		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		function onAbort(): void {
			clearTimeout(timer);
			reject(new TranscriptError("cancelled", "Cancelled."));
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface UntilOptions {
	timeoutMs: number;
	intervalMs?: number;
	signal?: AbortSignal;
}

/**
 * Poll `probe` until `done` accepts its answer.
 *
 * Returns the last answer either way, rather than throwing on timeout. Whether a timeout is
 * fatal depends on what was being waited for — a panel that never opened is an error worth a
 * retry, a segment count that stopped growing is just the end of the transcript — and only the
 * caller knows which.
 */
export async function until<T>(
	probe: () => Promise<T>,
	done: (value: T) => boolean,
	options: UntilOptions,
): Promise<{ value: T; settled: boolean }> {
	const interval = options.intervalMs ?? 200;
	const deadline = Date.now() + options.timeoutMs;

	let value = await probe();
	if (done(value)) return { value, settled: true };

	while (Date.now() < deadline) {
		await delay(interval, options.signal);
		value = await probe();
		if (done(value)) return { value, settled: true };
	}

	return { value, settled: false };
}
