import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceLine } from "../lib/source.js";

test("sourceLine maps rendered-text anchors to source lines through markdown syntax", () => {
  const markdown = [
    "# Title",
    "",
    "Some **bold** and _em_ text with `code` and a [link](https://example.com) ![logo](logo.png).",
    "",
    "> Quoted line one",
    "> continues **here**.",
    "",
    "- item one",
    "1. item two",
    "",
    "| A | B |",
    "|---|---|",
    "| x | y |",
    "",
    "```js",
    "const a = b * c;",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Title] --> B",
    "```",
    "",
    "Title again, escaped \\*star\\*.",
  ].join("\n");
  const line = (quote, prefix = "", suffix = "") => sourceLine(markdown, { kind: "text", quote, prefix, suffix });

  assert.equal(line("bold and em text with code and a link."), 3);
  assert.equal(line("one\ncontinues here."), 5);
  assert.equal(line("item one\nitem two"), 8);
  assert.equal(line("item two"), 9);
  assert.equal(line("B\n\n\nx"), 11);
  assert.equal(line("const a = b * c;"), 16);
  assert.equal(line("Title"), 1);
  assert.equal(line("Title", "", " again"), 24);
  assert.equal(line("escaped *star*"), 24);
  assert.equal(line("A[Title]"), null);
  assert.equal(line("absent"), null);

  assert.equal(sourceLine(markdown, { kind: "diagram", diagram: 0, target: "node", id: "A", label: "Title" }), 19);
  assert.equal(sourceLine(markdown, { kind: "diagram", diagram: 1, target: "node", id: "A", label: "Title" }), null);
});
