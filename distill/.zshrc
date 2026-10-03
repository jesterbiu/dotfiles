#!/usr/bin/awk -f
/PATH=/ { held = ""; next }
held != "" { emit(held); held = "" }
/^#/ { held = $0; next }
{ emit($0) }
END { if (held != "") emit(held) }
function emit(line) {
  if (line == "") { blank = 1; return }
  if (blank && printed) print ""
  print line; blank = 0; printed = 1
}
