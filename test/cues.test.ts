import { describe, expect, it } from "vitest";
import { clockOf, parseClock, toParagraphs, toPlainText, toVtt } from "../src/cues.js";

describe("parseClock", () => {
	it("reads every shape the panel prints", () => {
		expect(parseClock("0:00")).toBe(0);
		expect(parseClock("12:04")).toBe(724);
		expect(parseClock("1:02:03")).toBe(3723);
		expect(parseClock(" 9:59 ")).toBe(599);
	});

	it("returns undefined rather than NaN for a malformed stamp", () => {
		for (const input of ["", "later", "1:2:3:4", "12", "--"]) {
			expect(parseClock(input), input).toBeUndefined();
		}
	});

	it("round-trips with clockOf", () => {
		for (const seconds of [0, 59, 60, 724, 3723]) {
			expect(parseClock(clockOf(seconds))).toBe(seconds);
		}
	});
});

describe("toParagraphs", () => {
	const cues = [
		{ start: 0, text: "one" },
		{ start: 10, text: "two" },
		{ start: 29, text: "three" },
		{ start: 31, text: "four" },
		{ start: 90, text: "five" },
	];

	it("breaks on elapsed time, not on cue count", () => {
		const paragraphs = toParagraphs(cues);

		expect(paragraphs.map((p) => p.text)).toEqual(["one two three", "four", "five"]);
		expect(paragraphs.map((p) => p.start)).toEqual([0, 31, 90]);
		expect(paragraphs.map((p) => p.index)).toEqual([1, 2, 3]);
	});

	it("keeps the cues, because a frame needs the moment a phrase was said", () => {
		expect(toParagraphs(cues)[0].cues).toHaveLength(3);
	});

	it("takes the seam length as an argument", () => {
		// At five seconds the 29s and 31s cues still land together; everything else splits.
		expect(toParagraphs(cues, 5).map((p) => p.text)).toEqual(["one", "two", "three four", "five"]);
	});

	it("has nothing to say about no cues", () => {
		expect(toParagraphs([])).toEqual([]);
	});
});

describe("toPlainText", () => {
	it("separates paragraphs with a blank line and writes no timings", () => {
		const text = toPlainText([
			{ start: 0, text: "before" },
			{ start: 60, text: "after" },
		]);

		expect(text).toBe("before\n\nafter");
		expect(text).not.toMatch(/\d:\d/);
	});
});

describe("toVtt", () => {
	it("ends each cue where the next one starts", () => {
		const vtt = toVtt([
			{ start: 0, text: "one" },
			{ start: 2.5, text: "two" },
		]);

		expect(vtt.startsWith("WEBVTT")).toBe(true);
		expect(vtt).toContain("00:00:00.000 --> 00:00:02.500");
		// The last cue has no successor, so it runs a phrase's worth.
		expect(vtt).toContain("00:00:02.500 --> 00:00:05.500");
	});
});
