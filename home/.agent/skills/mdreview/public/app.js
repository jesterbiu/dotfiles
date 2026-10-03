import { Marked } from "https://cdnjs.cloudflare.com/ajax/libs/marked/18.0.14/lib/marked.esm.min.js";
import { findAnchor, captureAnchor } from "/_/anchor.js";

const docPath = decodeURIComponent(location.pathname);
const api = (name) => `/_/api/${name}?path=${encodeURIComponent(docPath)}`;
document.title = docPath.split("/").pop();

const SVG_NS = "http://www.w3.org/2000/svg";
const docEl = document.getElementById("doc");
const entriesEl = document.getElementById("entries");
const summaryEl = document.getElementById("summary");
const commentButton = document.getElementById("comment-button");
const box = document.getElementById("comment-box");
const boxWhere = box.querySelector(".where");
const boxText = box.querySelector("textarea");

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", suppressErrorRendering: true });

let diagramSources = [];
const marked = new Marked({
  renderer: {
    code({ text, lang }) {
      if ((lang ?? "").trim().split(/\s+/)[0] !== "mermaid") return false;
      diagramSources.push(text);
      return `<div class="diagram" data-index="${diagramSources.length - 1}"></div>\n`;
    },
  },
});

let comments = [];
let mtimes = { doc: -1, comments: -1 };
let diagramTargets = [];
let anchorEls = new Map();
let selectedAnchor = null;
let pendingAnchor = null;
let activeId = null;
let renderCount = 0;

async function renderDoc() {
  const markdown = await fetch(api("doc")).then((r) => r.text());
  diagramSources = [];
  const fresh = document.createElement("div");
  fresh.innerHTML = marked.parse(markdown);
  await renderDiagrams(fresh);
  const scroll = window.scrollY;
  hide(commentButton);
  docEl.replaceChildren(...fresh.childNodes);
  diagramTargets = [...docEl.querySelectorAll(".diagram")].flatMap(bindDiagram);
  window.scrollTo(0, scroll);
}

async function renderDiagrams(container) {
  renderCount++;
  for (const el of container.querySelectorAll(".diagram")) {
    const source = diagramSources[el.dataset.index];
    try {
      const { svg } = await mermaid.render(`mdr-${renderCount}-${el.dataset.index}`, source);
      el.innerHTML = svg;
    } catch (err) {
      const pre = document.createElement("pre");
      pre.className = "diagram-error";
      pre.textContent = `Mermaid error: ${err.message}\n\n${source}`;
      el.replaceChildren(pre);
    }
  }
}

function bindDiagram(el) {
  const diagram = Number(el.dataset.index);
  const nodes = [...el.querySelectorAll("g.node")]
    .map((g) => ({ el: g, anchor: { kind: "diagram", diagram, target: "node", id: nodeId(g), label: clean(g.textContent) } }))
    .filter((t) => t.anchor.id);
  const ids = new Set(nodes.map((t) => t.anchor.id));
  const edgePaths = new Set(el.querySelectorAll("path[data-edge], .edgePaths path, path.flowchart-link"));
  const edges = [...edgePaths].flatMap((path) => {
    const raw = path.dataset.id || path.id;
    const ends = edgeEnds(raw, ids);
    if (!ends) return [];
    const label = el.querySelector(`.edgeLabel [data-id="${CSS.escape(raw)}"]`)?.textContent ?? "";
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("d", path.getAttribute("d"));
    hit.setAttribute("class", "edge-hit");
    if (path.getAttribute("transform")) hit.setAttribute("transform", path.getAttribute("transform"));
    path.after(hit);
    const anchor = { kind: "diagram", diagram, target: "edge", id: `${ends[0]}-->${ends[1]}`, label: clean(label) };
    return [{ el: path, hit, anchor }];
  });
  for (const t of [...nodes, ...edges]) {
    (t.hit ?? t.el).addEventListener("click", (e) => {
      e.stopPropagation();
      openBox(t.anchor, e.pageX, e.pageY);
    });
  }
  return [...nodes, ...edges];
}

function nodeId(g) {
  return g.dataset.id || /flowchart-(.+)-\d+$/.exec(g.id)?.[1] || "";
}

function edgeEnds(raw, ids) {
  const middle = /(?:^|[-_])L[-_](.+)[-_]\d+$/.exec(raw ?? "")?.[1];
  if (!middle) return null;
  for (let k = 1; k < middle.length - 1; k++) {
    if ("-_".includes(middle[k]) && ids.has(middle.slice(0, k)) && ids.has(middle.slice(k + 1))) {
      return [middle.slice(0, k), middle.slice(k + 1)];
    }
  }
  return null;
}

function clean(text) {
  return text.replace(/\s+/g, " ").trim();
}

function textIndex() {
  const nodes = [];
  let text = "";
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(".diagram") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  return { text, nodes };
}

function offsetOf(index, container, offset) {
  const own = index.nodes.find((e) => e.node === container);
  if (own) return own.start + offset;
  const point = document.createRange();
  point.setStart(container, offset);
  const after = index.nodes.find((e) => point.comparePoint(e.node, 0) >= 0);
  return after ? after.start : index.text.length;
}

function wrap(range, comment) {
  const marks = [];
  for (const { node, start } of textIndex().nodes) {
    const end = start + node.data.length;
    if (end <= range.start || start >= range.end || !node.data.trim()) continue;
    let target = node;
    if (range.end < end) target.splitText(range.end - start);
    if (range.start > start) target = target.splitText(range.start - start);
    const mark = document.createElement("mark");
    mark.dataset.id = comment.id;
    if (comment.status === "resolved") mark.classList.add("resolved");
    target.before(mark);
    mark.append(target);
    marks.push(mark);
  }
  return marks;
}

function findTarget(anchor) {
  const same = diagramTargets.filter(
    (t) => t.anchor.diagram === anchor.diagram && t.anchor.target === anchor.target && t.anchor.id === anchor.id,
  );
  return same.find((t) => t.anchor.label === anchor.label) ?? same[0];
}

function locate(comment) {
  const anchor = comment.anchor;
  if (anchor.kind === "text") {
    const range = findAnchor(textIndex().text, anchor);
    return range ? wrap(range, comment) : [];
  }
  const target = findTarget(anchor);
  if (!target) return [];
  target.el.classList.add(comment.status === "resolved" ? "c-resolved" : "c-open");
  return [target.el];
}

function clearHighlights() {
  for (const mark of docEl.querySelectorAll("mark")) mark.replaceWith(...mark.childNodes);
  docEl.normalize();
  for (const t of diagramTargets) t.el.classList.remove("c-open", "c-resolved", "active");
}

function applyComments() {
  clearHighlights();
  anchorEls = new Map(comments.map((c) => [c.id, locate(c)]));
  renderSidebar();
  setActive(activeId, false);
}

function describe(anchor) {
  if (anchor.kind === "text") return `“${anchor.quote}”`;
  return `Diagram ${anchor.diagram} ${anchor.target} ${anchor.id}${anchor.label ? ` · ${anchor.label}` : ""}`;
}

function renderSidebar() {
  const open = comments.filter((c) => c.status !== "resolved").length;
  summaryEl.textContent = `Comments: ${open} open, ${comments.length - open} resolved`;
  entriesEl.replaceChildren(...comments.map(entryFor));
}

function entryFor(comment) {
  const resolved = comment.status === "resolved";
  const entry = el("div", `entry${resolved ? " resolved" : ""}`);
  entry.dataset.id = comment.id;
  const meta = el("div", "meta", el("span", "", comment.id), el("span", "badge", comment.status));
  if (!anchorEls.get(comment.id)?.length) meta.append(el("span", "badge orphaned", "orphaned"));
  const toggle = el("button", "", resolved ? "Reopen" : "Resolve");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    mutate((list) => list.map((c) => (c.id === comment.id ? { ...c, status: resolved ? "open" : "resolved" } : c)));
  });
  const remove = el("button", "", "Delete");
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`Delete comment ${comment.id}?`)) mutate((list) => list.filter((c) => c.id !== comment.id));
  });
  meta.append(el("span", "spacer"), toggle, remove);
  entry.append(el("div", "where", describe(comment.anchor)), el("div", "text", comment.text), meta);
  entry.addEventListener("click", () => setActive(comment.id, true));
  return entry;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function setActive(id, scrollToAnchor) {
  activeId = id;
  for (const node of document.querySelectorAll(".active")) node.classList.remove("active");
  if (!id) return;
  const targets = anchorEls.get(id) ?? [];
  for (const node of targets) node.classList.add("active");
  const entry = entriesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  entry?.classList.add("active");
  if (scrollToAnchor) targets[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  else entry?.scrollIntoView({ block: "nearest" });
}

async function mutate(change) {
  const current = await fetch(api("comments")).then((r) => r.json());
  const res = await fetch(api("comments"), { method: "PUT", body: JSON.stringify({ comments: change(current.comments) }) });
  if (!res.ok) return alert(await res.text());
  comments = (await res.json()).comments;
  applyComments();
}

function show(node, x, y) {
  node.style.display = "block";
  node.style.left = `${Math.max(window.scrollX + 8, Math.min(x, window.scrollX + window.innerWidth - node.offsetWidth - 8))}px`;
  node.style.top = `${y}px`;
}

function hide(node) {
  node.style.display = "none";
}

function openBox(anchor, x, y) {
  pendingAnchor = anchor;
  boxWhere.textContent = describe(anchor);
  boxText.value = "";
  show(box, x, y);
  boxText.focus();
}

function closeBox() {
  pendingAnchor = null;
  hide(box);
}

async function saveBox() {
  const text = boxText.value.trim();
  if (!text || !pendingAnchor) return;
  const anchor = pendingAnchor;
  closeBox();
  getSelection().removeAllRanges();
  await mutate((list) => [...list, { anchor, text }]);
}

function onSelectionEnd(e) {
  if (box.contains(e.target) || e.target === commentButton) return;
  const selection = getSelection();
  if (selection.isCollapsed || !selection.rangeCount) return hide(commentButton);
  const range = selection.getRangeAt(0);
  if (!docEl.contains(range.commonAncestorContainer)) return hide(commentButton);
  const index = textIndex();
  const start = offsetOf(index, range.startContainer, range.startOffset);
  const end = offsetOf(index, range.endContainer, range.endOffset);
  if (end <= start || !index.text.slice(start, end).trim()) return hide(commentButton);
  selectedAnchor = { kind: "text", ...captureAnchor(index.text, start, end) };
  const rect = range.getBoundingClientRect();
  show(commentButton, rect.right + window.scrollX, rect.bottom + window.scrollY + 4);
}

document.addEventListener("mouseup", (e) => setTimeout(() => onSelectionEnd(e)));
document.addEventListener("keyup", (e) => (e.key === "Shift" || e.shiftKey) && onSelectionEnd(e));
commentButton.addEventListener("mousedown", (e) => e.preventDefault());
commentButton.addEventListener("click", () => {
  hide(commentButton);
  openBox(selectedAnchor, parseFloat(commentButton.style.left), parseFloat(commentButton.style.top));
});
box.querySelector('[data-action="save"]').addEventListener("click", saveBox);
box.querySelector('[data-action="cancel"]').addEventListener("click", closeBox);
boxText.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBox();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBox();
});
docEl.addEventListener("click", (e) => {
  const mark = e.target.closest("mark");
  if (mark && getSelection().isCollapsed) setActive(mark.dataset.id, false);
});

async function poll() {
  try {
    const next = await fetch(api("mtimes")).then((r) => r.json());
    if (next.doc !== mtimes.doc) await renderDoc();
    if (next.doc !== mtimes.doc || next.comments !== mtimes.comments) {
      comments = (await fetch(api("comments")).then((r) => r.json())).comments;
      applyComments();
    }
    mtimes = next;
  } catch (err) {
    console.error(err);
  }
  setTimeout(poll, 2000);
}

poll();
