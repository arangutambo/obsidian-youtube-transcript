/**
 * A click the page will believe.
 *
 * This is the entire trick, and it is worth being precise about why nothing simpler works.
 * `element.click()` and a hand-built `MouseEvent` both arrive with `isTrusted === false`,
 * because only the browser itself may set that flag. YouTube's transcript handler checks it —
 * dispatch a synthetic click at the control and the engagement panel stays
 * `VISIBILITY_HIDDEN`, silently, with no error anywhere.
 *
 * `sendInputEvent` does not go through the DOM at all. It hands the event to the browser
 * process, which routes it into the guest's input pipeline exactly as it would a real mouse.
 * The page cannot tell the difference, which is the point, and cannot forge it either, which is
 * why the check exists.
 *
 * The consequence is that this is a real click at a real coordinate: it activates whatever is
 * under that point. Aiming is checked before firing, never after.
 */

import type { MouseInput, WebviewLike } from "./types.js";

export interface Point {
	x: number;
	y: number;
}

/**
 * Move, press, release.
 *
 * The move matters. Some of YouTube's controls bind their handler on first hover, and a press
 * that arrives with the pointer nowhere near the button can land before that has happened.
 */
export async function trustedClick(view: WebviewLike, at: Point): Promise<void> {
	const x = Math.round(at.x);
	const y = Math.round(at.y);

	await send(view, { type: "mouseMove", x, y });
	await send(view, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
	await send(view, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

async function send(view: WebviewLike, event: MouseInput): Promise<void> {
	await view.sendInputEvent(event);
}
