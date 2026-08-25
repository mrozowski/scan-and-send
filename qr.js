/*
 * qr.js — self-contained QR code generator + camera scanner
 *
 * QR generator: byte mode, error-correction level L, versions 1-40
 * Scanner: BarcodeDetector API (Chrome/Edge/Android)
 *
 * Public API
 *   makeQR(text, container)  – renders an SVG QR code into container
 *   QRScanner               – camera scanner class (same interface as Html5Qrcode)
 */

(function (global) {
  "use strict";

  // ── GF(256) ──────────────────────────────────────────────────────────────

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);

  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
  }

  // ── Reed-Solomon ─────────────────────────────────────────────────────────

  // Returns generator polynomial coefficients [g_{n-1}, ..., g_0]
  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], GF_EXP[i]);
      }
      g = ng;
    }
    return g.slice(1); // drop leading 1
  }

  function rsRemainder(data, gen) {
    const n = gen.length;
    const rem = new Uint8Array(n);
    for (const byte of data) {
      const factor = byte ^ rem[0];
      for (let i = 0; i < n - 1; i++) {
        rem[i] = rem[i + 1] ^ gfMul(gen[i], factor);
      }
      rem[n - 1] = gfMul(gen[n - 1], factor);
    }
    return rem;
  }

  // ── EC blocks table (level L) ────────────────────────────────────────────
  // [ec_cw_per_blk, b1_count, b1_data_cw, b2_count, b2_data_cw]

  const EC_L = [
    null,
    [ 7, 1, 19, 0,   0], //  1
    [10, 1, 34, 0,   0], //  2
    [15, 1, 55, 0,   0], //  3
    [20, 1, 80, 0,   0], //  4
    [26, 1,108, 0,   0], //  5
    [18, 2, 68, 0,   0], //  6
    [20, 2, 78, 0,   0], //  7
    [24, 2, 97, 0,   0], //  8
    [30, 2,116, 0,   0], //  9
    [18, 2, 68, 2,  69], // 10
    [20, 4, 81, 0,   0], // 11
    [24, 2, 92, 2,  93], // 12
    [26, 4,107, 0,   0], // 13
    [30, 3,115, 1, 116], // 14
    [22, 5, 87, 1,  88], // 15
    [24, 5, 98, 1,  99], // 16
    [28, 1,107, 5, 108], // 17
    [30, 5,120, 1, 121], // 18
    [28, 3,113, 4, 114], // 19
    [28, 3,107, 5, 108], // 20
    [28, 4,116, 4, 117], // 21
    [28, 2,111, 7, 112], // 22
    [30, 4,121, 5, 122], // 23
    [30, 6,117, 4, 118], // 24
    [26, 8,106, 4, 107], // 25
    [28,10,114, 2, 115], // 26
    [30, 8,122, 4, 123], // 27
    [30, 3,117,10, 118], // 28
    [30, 7,116, 7, 117], // 29
    [30, 5,115,10, 116], // 30
    [30,13,115, 3, 116], // 31
    [30,17,115, 0,   0], // 32
    [30,17,115, 1, 116], // 33
    [30,13,115, 6, 116], // 34
    [30,12,121, 7, 122], // 35
    [30, 6,121,14, 122], // 36
    [30,17,122, 4, 123], // 37
    [30, 4,122,18, 123], // 38
    [30,20,117, 4, 118], // 39
    [30,19,118, 6, 119], // 40
  ];

  // Byte-mode capacity at EC-L for each version
  const CAP_L = [
    0,17,32,53,78,106,134,154,192,230,271,
    321,367,425,458,520,586,644,718,792,858,
    929,1003,1091,1171,1273,1367,1465,1528,
    1628,1732,1840,1952,2068,2188,2303,2431,
    2563,2699,2809,2953
  ];

  // Alignment pattern center positions per version
  const ALIGN = [
    [],[], // 0,1
    [6,18],[6,22],[6,26],[6,30],[6,34],
    [6,22,38],[6,24,42],[6,26,46],[6,28,50],
    [6,30,54],[6,32,58],[6,34,62],
    [6,26,46,66],[6,26,48,70],[6,26,50,74],
    [6,30,54,78],[6,30,56,82],[6,30,58,86],
    [6,34,62,90],
    [6,28,50,72,94],[6,26,50,74,98],
    [6,30,54,78,102],[6,28,54,80,106],
    [6,32,58,84,110],[6,30,58,86,114],
    [6,34,62,90,118],
    [6,26,50,74,98,122],[6,30,54,78,102,126],
    [6,26,52,78,104,130],[6,30,56,82,108,134],
    [6,34,60,86,112,138],[6,30,58,86,114,142],
    [6,34,62,90,118,146],
    [6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
    [6,28,54,80,106,132,158],[6,32,58,84,110,136,162],
    [6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
  ];

  // Remainder bits per version (appended after codewords)
  const REM = [0,0,7,7,7,7,7,0,0,0,0,0,0,0,3,3,3,3,3,3,3,4,4,4,4,4,4,4,3,3,3,3,3,3,3,0,0,0,0,0,0];

  // ── Data encoding ─────────────────────────────────────────────────────────

  function encodeData(bytes, version) {
    const [, b1c, b1d, b2c, b2d] = EC_L[version];
    const totalDataCW = b1c * b1d + b2c * b2d;

    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    push(0b0100, 4); // byte mode indicator
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);

    // Terminator (up to 4 zero bits)
    for (let i = 0; i < 4 && bits.length < totalDataCW * 8; i++) bits.push(0);

    // Pad to byte boundary
    while (bits.length % 8) bits.push(0);

    // Pad codewords
    const PAD = [0xec, 0x11];
    let pi = 0;
    while (bits.length < totalDataCW * 8) push(PAD[pi++ % 2], 8);

    const data = new Uint8Array(totalDataCW);
    for (let i = 0; i < totalDataCW; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] || 0);
      data[i] = b;
    }
    return data;
  }

  // ── Interleave data + EC codewords ────────────────────────────────────────

  function buildCodewords(data, version) {
    const [ec, b1c, b1d, b2c, b2d] = EC_L[version];
    const gen = rsGenerator(ec);
    const blocks = [];
    let off = 0;

    for (let i = 0; i < b1c; i++) {
      const d = data.slice(off, off + b1d);
      blocks.push({ d, e: rsRemainder(d, gen) });
      off += b1d;
    }
    for (let i = 0; i < b2c; i++) {
      const d = data.slice(off, off + b2d);
      blocks.push({ d, e: rsRemainder(d, gen) });
      off += b2d;
    }

    const cw = [];
    const maxD = Math.max(b1d, b2d);
    for (let i = 0; i < maxD; i++)
      for (const blk of blocks)
        if (i < blk.d.length) cw.push(blk.d[i]);
    for (let i = 0; i < ec; i++)
      for (const blk of blocks)
        cw.push(blk.e[i]);

    return cw;
  }

  // ── Version information (ver >= 7) ────────────────────────────────────────

  function versionInfo(ver) {
    const POLY = 0x1f25;
    let val = ver << 12;
    for (let i = 17; i >= 12; i--) {
      if (val & (1 << i)) val ^= POLY << (i - 12);
    }
    return (ver << 12) | val;
  }

  // ── Format information ────────────────────────────────────────────────────

  function formatInfo(mask) {
    // EC level L = 0b01
    const data = (0b01 << 3) | mask;
    const POLY = 0x537;
    let val = data << 10;
    for (let i = 14; i >= 10; i--) {
      if (val & (1 << i)) val ^= POLY << (i - 10);
    }
    return ((data << 10) | val) ^ 0x5412;
  }

  // ── Matrix builder ────────────────────────────────────────────────────────

  function buildMatrix(version, cw) {
    const size = 4 * version + 17;
    // mat: null = unset data module; 0/1 = light/dark
    // func: true = function module (not overwritten by data)
    const mat  = Array.from({ length: size }, () => new Array(size).fill(null));
    const func = Array.from({ length: size }, () => new Array(size).fill(false));

    function set(r, c, dark) {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      mat[r][c] = dark ? 1 : 0;
      func[r][c] = true;
    }

    // Finder pattern + separator at top-left corner (tr,tc)
    function drawFinder(tr, tc) {
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 7; c++) {
          const dark = r === 0 || r === 6 || c === 0 || c === 6 ||
                       (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          set(tr + r, tc + c, dark);
        }
      // separator (light ring)
      for (let i = -1; i <= 7; i++) {
        set(tr - 1, tc + i, 0);
        set(tr + 7, tc + i, 0);
        set(tr + i, tc - 1, 0);
        set(tr + i, tc + 7, 0);
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Dark module
    set(size - 8, 8, 1);

    // Alignment patterns
    const ap = ALIGN[version] || [];
    for (let ai = 0; ai < ap.length; ai++) {
      for (let aj = 0; aj < ap.length; aj++) {
        const cr = ap[ai], cc = ap[aj];
        if (func[cr][cc]) continue;
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const dark = dr === -2 || dr === 2 || dc === -2 || dc === 2 || (dr === 0 && dc === 0);
            set(cr + dr, cc + dc, dark);
          }
      }
    }

    // Reserve format info positions (mark as function, light placeholder)
    for (let i = 0; i <= 8; i++) {
      if (!func[8][i]) set(8, i, 0);
      if (!func[i][8]) set(i, 8, 0);
      if (!func[8][size - 1 - i]) set(8, size - 1 - i, 0);
      if (!func[size - 1 - i][8]) set(size - 1 - i, 8, 0);
    }

    // Version info (version >= 7)
    if (version >= 7) {
      const vi = versionInfo(version);
      for (let i = 0; i < 18; i++) {
        const dark = (vi >> i) & 1;
        const r = Math.floor(i / 3), c = i % 3;
        set(r, size - 11 + c, dark);
        set(size - 11 + c, r, dark);
      }
    }

    // Data placement — zigzag scan
    const dataBits = [];
    for (const byte of cw)
      for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);
    for (let i = 0; i < REM[version]; i++) dataBits.push(0);

    let bi = 0;
    let up = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip vertical timing column
      for (let row = 0; row < size; row++) {
        const r = up ? size - 1 - row : row;
        for (let d = 0; d < 2; d++) {
          const c = right - d;
          if (!func[r][c]) {
            mat[r][c] = bi < dataBits.length ? dataBits[bi++] : 0;
          }
        }
      }
      up = !up;
    }

    return { mat, func, size };
  }

  // ── Masking ───────────────────────────────────────────────────────────────

  const MASK_FN = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  function applyMask(mat, func, size, m) {
    const out = mat.map(row => row.slice());
    const fn = MASK_FN[m];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!func[r][c] && fn(r, c)) out[r][c] ^= 1;
    return out;
  }

  function penalty(mat, size) {
    let p = 0;

    // Rule 1: runs of 5+ same color
    for (let r = 0; r < size; r++) {
      for (let s = 0; s < size; ) {
        let e = s;
        while (e < size && mat[r][e] === mat[r][s]) e++;
        if (e - s >= 5) p += 3 + (e - s - 5);
        s = e;
      }
      for (let s = 0; s < size; ) {
        let e = s;
        while (e < size && mat[e][r] === mat[s][r]) e++;
        if (e - s >= 5) p += 3 + (e - s - 5);
        s = e;
      }
    }

    // Rule 2: 2×2 same-color blocks
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++)
        if (mat[r][c] === mat[r][c+1] &&
            mat[r][c] === mat[r+1][c] &&
            mat[r][c] === mat[r+1][c+1]) p += 3;

    // Rule 3: finder-like patterns
    const P1 = [1,0,1,1,1,0,1,0,0,0,0];
    const P2 = [0,0,0,0,1,0,1,1,1,0,1];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c + 11 <= size; c++) {
        let m1 = true, m2 = true, m3 = true, m4 = true;
        for (let i = 0; i < 11; i++) {
          if (mat[r][c+i] !== P1[i]) m1 = false;
          if (mat[r][c+i] !== P2[i]) m2 = false;
          if (mat[c+i] === undefined || mat[c+i][r] !== P1[i]) m3 = false;
          if (mat[c+i] === undefined || mat[c+i][r] !== P2[i]) m4 = false;
        }
        if (m1) p += 40;
        if (m2) p += 40;
        if (m3) p += 40;
        if (m4) p += 40;
      }
    }

    // Rule 4: proportion of dark modules
    let dark = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (mat[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    p += Math.min(
      Math.abs(Math.floor(pct / 5) * 5 - 50),
      Math.abs(Math.ceil(pct / 5) * 5 - 50)
    ) * 2;

    return p;
  }

  // ── Place format info into final matrix ───────────────────────────────────

  function placeFormatInfo(mat, size, maskIdx) {
    const fi = formatInfo(maskIdx);
    // Bits 14..0 of fi, MSB first
    const bit = i => (fi >> (14 - i)) & 1;

    // Around top-left finder
    let i = 0;
    for (let c = 0; c <= 5; c++) mat[8][c] = bit(i++);
    mat[8][7] = bit(i++); // skip col 6 (timing)
    mat[8][8] = bit(i++);
    mat[7][8] = bit(i++);
    for (let r = 5; r >= 0; r--) {
      if (r === 6) continue; // skip row 6 (timing)
      mat[r][8] = bit(i++);
    }

    // Around top-right finder (bits 7..0 right-to-left along row 8)
    for (let c = size - 8; c <= size - 1; c++) mat[8][c] = bit(14 - (size - 1 - c));

    // Around bottom-left finder (bits 6..0 bottom-to-top along col 8)
    for (let r = size - 7; r <= size - 1; r++) mat[r][8] = bit(6 - (r - (size - 7)));
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 1;
    while (version <= 40 && CAP_L[version] < bytes.length) version++;
    if (version > 40) throw new Error("Data too large for QR code");

    const data = encodeData(bytes, version);
    const cw   = buildCodewords(data, version);
    const { mat, func, size } = buildMatrix(version, cw);

    // Choose best mask
    let bestMask = 0, bestPen = Infinity;
    for (let m = 0; m < 8; m++) {
      const masked = applyMask(mat, func, size, m);
      const pen = penalty(masked, size);
      if (pen < bestPen) { bestPen = pen; bestMask = m; }
    }

    const final = applyMask(mat, func, size, bestMask);
    placeFormatInfo(final, size, bestMask);
    return { mat: final, size };
  }

  // ── SVG render ────────────────────────────────────────────────────────────

  function toSVG(mat, size) {
    const px = Math.max(2, Math.floor(280 / size));
    const dim = size * px;
    let rects = "";
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (mat[r][c]) rects += `<rect x="${c * px}" y="${r * px}" width="${px}" height="${px}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
           `width="${dim}" height="${dim}" style="background:#fff;display:block">` +
           `<g fill="#000">${rects}</g></svg>`;
  }

  // ── Public: makeQR ────────────────────────────────────────────────────────

  global.makeQR = function makeQR(text, container) {
    const { mat, size } = encode(text);
    container.innerHTML = toSVG(mat, size);
  };

  // ── Public: QRScanner ─────────────────────────────────────────────────────
  //
  // Wraps the BarcodeDetector API with the same interface as Html5Qrcode:
  //   scanner.start(cameraConstraints, config, onSuccess, onFailure)
  //   scanner.pause(deep)
  //   scanner.resume()
  //   scanner.stop()

  class QRScanner {
    constructor(elementId) {
      this._container = document.getElementById(elementId);
      this._stream  = null;
      this._video   = null;
      this._paused  = false;
      this._running = false;
      this._timer   = null;
    }

    async start(cameraConstraints, _config, onSuccess, _onFailure) {
      if (!("BarcodeDetector" in window)) {
        throw new Error(
          "BarcodeDetector is not supported in this browser. " +
          "Please use Chrome or Edge on desktop/Android."
        );
      }

      this._detector = new BarcodeDetector({ formats: ["qr_code"] });

      this._video = document.createElement("video");
      this._video.setAttribute("playsinline", "");
      this._video.setAttribute("autoplay",    "");
      this._video.setAttribute("muted",       "");
      this._video.style.cssText = "width:100%;border-radius:8px";
      this._container.innerHTML = "";
      this._container.appendChild(this._video);

      this._stream = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraints,
        audio: false
      });
      this._video.srcObject = this._stream;
      await this._video.play();

      this._running = true;
      this._scheduleNext(onSuccess);
    }

    _scheduleNext(onSuccess) {
      this._timer = setTimeout(() => this._scan(onSuccess), 150);
    }

    async _scan(onSuccess) {
      if (!this._running) return;
      if (!this._paused) {
        try {
          const codes = await this._detector.detect(this._video);
          if (codes.length > 0) {
            await onSuccess(codes[0].rawValue);
            return; // let caller resume/stop
          }
        } catch (_) { /* ignore detection errors */ }
      }
      this._scheduleNext(onSuccess);
    }

    async pause(_deep) {
      this._paused = true;
    }

    async resume() {
      this._paused = false;
    }

    async stop() {
      this._running = false;
      clearTimeout(this._timer);
      if (this._stream) {
        this._stream.getTracks().forEach(t => t.stop());
        this._stream = null;
      }
      if (this._video) {
        this._video.srcObject = null;
        this._video = null;
      }
      if (this._container) this._container.innerHTML = "";
    }
  }

  global.QRScanner = QRScanner;

})(window);
