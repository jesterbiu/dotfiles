import { findAnchor } from "./anchor.js";

const markup = /[\s<>*_`~|#]/g;

export function sourceLine(markdown, anchor) {
  const { text, lines, diagrams } = flatten(markdown);
  if (anchor.kind === "diagram") return diagrams[anchor.diagram] ?? null;
  const range = findAnchor(text, { quote: squeeze(anchor.quote), prefix: squeeze(anchor.prefix), suffix: squeeze(anchor.suffix) });
  return range ? lines[range.start] : null;
}

function flatten(markdown) {
  let text = "";
  const lines = [];
  const diagrams = [];
  let fence = null;
  for (const [i, line] of markdown.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
    let visible = "";
    if (fence) {
      if (marker && marker[1].startsWith(fence.marker) && !marker[2]) fence = null;
      else if (!fence.mermaid) visible = line;
    } else if (marker) {
      fence = { marker: marker[1], mermaid: marker[2] === "mermaid" };
      if (fence.mermaid) diagrams.push(i + 1);
    } else {
      visible = plain(line);
    }
    const squeezed = squeeze(visible);
    text += squeezed;
    for (let k = 0; k < squeezed.length; k++) lines.push(i + 1);
  }
  return { text, lines, diagrams };
}

function plain(line) {
  if (/^[\s|:=*_-]*$/.test(line)) return "";
  return line
    .replace(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function squeeze(text = "") {
  return text.replace(markup, "");
}
