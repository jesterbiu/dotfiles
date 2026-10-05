const CONTEXT = 32;

export function captureAnchor(text, start, end) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

export function findAnchor(text, { quote, prefix = "", suffix = "" }) {
  if (!quote) return null;
  let best = null;
  let bestScore = -1;
  for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    const score = matchingTail(prefix, text.slice(0, start)) + matchingHead(suffix, text.slice(end));
    if (score > bestScore) {
      best = { start, end };
      bestScore = score;
    }
  }
  return best;
}

function matchingTail(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function matchingHead(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
