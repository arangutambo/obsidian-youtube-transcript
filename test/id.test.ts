import { describe, expect, it } from "vitest";
import { isVideoUrl, videoIdFrom, watchUrl } from "../src/id.js";

describe("videoIdFrom", () => {
	it("reads the usual shapes", () => {
		const id = "dQw4w9WgXcQ";
		for (const input of [
			id,
			`https://www.youtube.com/watch?v=${id}`,
			`https://youtu.be/${id}`,
			`https://m.youtube.com/watch?v=${id}&t=42s`,
			`https://music.youtube.com/watch?v=${id}`,
			`https://www.youtube.com/embed/${id}`,
			`https://www.youtube.com/shorts/${id}`,
			`https://www.youtube.com/live/${id}`,
			`youtube.com/watch?v=${id}`,
		]) {
			expect(videoIdFrom(input), input).toBe(id);
		}
	});

	it("survives the tracking parameters a share sheet adds", () => {
		expect(videoIdFrom("https://youtu.be/dQw4w9WgXcQ?si=abcdef&t=90")).toBe("dQw4w9WgXcQ");
	});

	it("unwraps a redirector rather than searching the outer URL", () => {
		const wrapped = `https://www.google.com/url?q=${encodeURIComponent("https://youtu.be/dQw4w9WgXcQ")}&usg=AOv`;
		expect(videoIdFrom(wrapped)).toBe("dQw4w9WgXcQ");
	});

	it("refuses anything that is not an eleven-character id", () => {
		for (const input of ["", "	 ", "https://example.com", "https://www.youtube.com/watch?v=short", "https://vimeo.com/12345"]) {
			expect(videoIdFrom(input), input).toBeUndefined();
		}
	});

	it("pins the interface language, because the control is found by its name", () => {
		expect(watchUrl("dQw4w9WgXcQ")).toContain("hl=en");
	});

	it("answers the same question as isVideoUrl", () => {
		expect(isVideoUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
		expect(isVideoUrl("https://example.com")).toBe(false);
	});
});
