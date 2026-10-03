import { test } from "node:test";
import assert from "node:assert/strict";
import { findAnchor, captureAnchor } from "../lib/anchor.js";

test("findAnchor locates a quote, uses prefix and suffix for repeats, and returns null when absent", () => {
  const text = "The pipeline runs on every push. The pipeline must stay under ten minutes.";

  assert.deepEqual(findAnchor(text, { quote: "every push" }), { start: 21, end: 31 });

  const second = captureAnchor(text, 37, 45);
  assert.equal(second.quote, "pipeline");
  assert.equal(second.prefix, "ipeline runs on every push. The ");
  assert.equal(second.suffix, " must stay under ten minutes.");
  assert.deepEqual(findAnchor(text, second), { start: 37, end: 45 });
  assert.deepEqual(findAnchor(text, { quote: "pipeline", prefix: "", suffix: " must" }), { start: 37, end: 45 });
  assert.deepEqual(findAnchor(text, { quote: "pipeline", prefix: "The ", suffix: " runs" }), { start: 4, end: 12 });

  assert.equal(findAnchor(text, { quote: "nightly", prefix: "", suffix: "" }), null);
  assert.equal(findAnchor(text, { quote: "", prefix: "", suffix: "" }), null);
});
