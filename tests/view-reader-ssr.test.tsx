/**
 * Dev server rendering seals useRef objects (React Fizz, development), so
 * a ref that later gains a `changed` property crashes the session page
 * under `npm run dev` ("Cannot add property changed, object is not
 * extensible"). View readers are plain state-held objects instead.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useRef } from "react";
import { renderToString } from "react-dom/server";
import { useViewReader } from "../components/session-view-readers.ts";

describe("view readers under server rendering", () => {
	it("a sealed useRef cannot take a changed property (the original crash)", () => {
		function Broken() {
			const ref = useRef<(() => string) | null>(null) as { current: (() => string) | null; changed?: () => void };
			ref.changed = () => {};
			return null;
		}
		assert.throws(() => renderToString(<Broken />), /not extensible/);
	});
	it("useViewReader accepts changed during server rendering", () => {
		function Fixed() {
			const reader = useViewReader<string>();
			reader.changed = () => {};
			reader.current = () => "x";
			return <span>{typeof reader.changed}</span>;
		}
		assert.match(renderToString(<Fixed />), /function/);
	});
});
