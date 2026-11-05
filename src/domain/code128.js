// Code 128 (subsets B and C, automatic switching, checksum).  Works in Node and in the browser (window.Code128).
// Table: the 106 symbol patterns (11 modules each, 1 = bar). Stop = 11000111010 + 11.
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.Code128 = factory(); })(typeof self !== "undefined" ? self : this, function () {
  const PAT = ["11011001100","11001101100","11001100110","10010011000","10010001100","10001001100","10011001000","10011000100","10001100100","11001001000","11001000100","11000100100","10110011100","10011011100","10011001110","10111001100","10011101100","10011100110","11001110010","11001011100","11001001110","11011100100","11001110100","11101101110","11101001100","11100101100","11100100110","11101100100","11100110100","11100110010","11011011000","11011000110","11000110110","10100011000","10001011000","10001000110","10110001000","10001101000","10001100010","11010001000","11000101000","11000100010","10110111000","10110001110","10001101110","10111011000","10111000110","10001110110","11101110110","11010001110","11000101110","11011101000","11011100010","11011101110","11101011000","11101000110","11100010110","11101101000","11101100010","11100011010","11101111010","11001000010","11110001010","10100110000","10100001100","10010110000","10010000110","10000101100","10000100110","10110010000","10110000100","10011010000","10011000010","10000110100","10000110010","11000010010","11001010000","11110111010","11000010100","10001111010","10100111100","10010111100","10010011110","10111100100","10011110100","10011110010","11110100100","11110010100","11110010010","11011011110","11011110110","11110110110","10101111000","10100011110","10001011110","10111101000","10111100010","11110101000","11110100010","10111011110","10111101110","11101011110","11110101110","11010000100","11010010000","11010011100"];
  const STOP = "1100011101011";
  const digitsFrom = (t, i) => { let n = 0; while (i + n < t.length && t.charCodeAt(i + n) >= 48 && t.charCodeAt(i + n) <= 57) n++; return n; };

  // text -> symbol values (start, data..., checksum, stop). Printable ASCII only (space..~), which includes | = / - . and letters.
  function values(text) {
    text = String(text == null ? "" : text);
    if (!text) throw new Error("Nothing to encode");
    const v = []; let mode = null, i = 0;
    while (i < text.length) {
      let run = digitsFrom(text, i);
      if (run >= 4) {
        if (run % 2 === 1) { // odd run: first digit goes in subset B so the rest pairs up
          if (mode === null) { v.push(104); mode = "B"; } else if (mode === "C") { v.push(100); mode = "B"; }
          v.push(text.charCodeAt(i) - 32); i++; run--;
        }
        if (mode !== "C") { v.push(mode === null ? 105 : 99); mode = "C"; }
        for (let k = 0; k < run; k += 2) v.push(parseInt(text.substr(i + k, 2), 10));
        i += run;
      } else {
        const c = text.charCodeAt(i) - 32;
        if (c < 0 || c > 95) throw new Error("Character not supported in Code 128: " + JSON.stringify(text[i]));
        if (mode === null) { v.push(104); mode = "B"; } else if (mode === "C") { v.push(100); mode = "B"; }
        v.push(c); i++;
      }
    }
    let sum = v[0]; for (let k = 1; k < v.length; k++) sum += v[k] * k;
    v.push(sum % 103); v.push(106);
    return v;
  }
  // text -> string of 1/0 modules (no quiet zone)
  function modules(text) { return values(text).map((x) => (x === 106 ? STOP : PAT[x])).join(""); }

  // text -> SVG string. 1 unit = 1 module; scale it with CSS (width). quiet = blank modules each side.
  function svg(text, { height = 50, quiet = 10, color = "#000", label = "" } = {}) {
    const m = modules(text), w = m.length + quiet * 2; let r = "", i = 0;
    while (i < m.length) { if (m[i] === "1") { let j = i; while (j < m.length && m[j] === "1") j++; r += `<rect x="${quiet + i}" y="0" width="${j - i}" height="${height}"/>`; i = j; } else i++; }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Code 128 ${esc(label || text)}"><rect width="${w}" height="${height}" fill="#fff"/><g fill="${color}">${r}</g></svg>`;
  }
  return { values, modules, svg, PAT, STOP };
});
