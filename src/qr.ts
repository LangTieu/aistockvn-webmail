// Self-contained QR Code encoder (Alphanumeric & Byte modes, Error Correction Level M, Versions 1..10)

interface VersionSpec {
  version: number;
  totalCodewords: number;
  ecCodewordsPerBlock: number;
  blocks: Array<{ count: number; dataCodewords: number }>;
  alignmentCenters: number[];
}

// Level M specifications for Versions 1..10 (ISO/IEC 18004)
const VERSION_SPECS: VersionSpec[] = [
  {
    version: 1,
    totalCodewords: 26,
    ecCodewordsPerBlock: 10,
    blocks: [{ count: 1, dataCodewords: 16 }],
    alignmentCenters: [],
  },
  {
    version: 2,
    totalCodewords: 44,
    ecCodewordsPerBlock: 16,
    blocks: [{ count: 1, dataCodewords: 28 }],
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    totalCodewords: 70,
    ecCodewordsPerBlock: 26,
    blocks: [{ count: 1, dataCodewords: 44 }],
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    totalCodewords: 100,
    ecCodewordsPerBlock: 18,
    blocks: [{ count: 2, dataCodewords: 32 }],
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    totalCodewords: 134,
    ecCodewordsPerBlock: 24,
    blocks: [{ count: 2, dataCodewords: 43 }],
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    totalCodewords: 172,
    ecCodewordsPerBlock: 16,
    blocks: [{ count: 4, dataCodewords: 27 }],
    alignmentCenters: [6, 34],
  },
  {
    version: 7,
    totalCodewords: 196,
    ecCodewordsPerBlock: 18,
    blocks: [{ count: 4, dataCodewords: 31 }],
    alignmentCenters: [6, 22, 38],
  },
  {
    version: 8,
    totalCodewords: 242,
    ecCodewordsPerBlock: 22,
    blocks: [
      { count: 2, dataCodewords: 38 },
      { count: 2, dataCodewords: 39 },
    ],
    alignmentCenters: [6, 24, 42],
  },
  {
    version: 9,
    totalCodewords: 292,
    ecCodewordsPerBlock: 22,
    blocks: [
      { count: 3, dataCodewords: 36 },
      { count: 2, dataCodewords: 37 },
    ],
    alignmentCenters: [6, 26, 46],
  },
  {
    version: 10,
    totalCodewords: 346,
    ecCodewordsPerBlock: 26,
    blocks: [
      { count: 4, dataCodewords: 43 },
      { count: 1, dataCodewords: 44 },
    ],
    alignmentCenters: [6, 28, 50],
  },
];

const ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function isAlphanumeric(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (ALPHANUMERIC_CHARS.indexOf(text[i]) === -1) {
      return false;
    }
  }
  return true;
}

// GF(256) arithmetic with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

function encodeDataCodewords(
  text: string,
  bytes: Uint8Array,
  alnum: boolean,
  spec: VersionSpec
): Uint8Array {
  const totalDataCodewords = spec.blocks.reduce(
    (sum, b) => sum + b.count * b.dataCodewords,
    0
  );
  const totalBits = totalDataCodewords * 8;
  const bits: number[] = [];

  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  if (alnum) {
    // Mode indicator: Alphanumeric mode = 0010 (4 bits)
    pushBits(0b0010, 4);

    // Character count indicator: 9 bits for versions 1..9, 11 bits for 10..26
    const ccBits = spec.version <= 9 ? 9 : 11;
    pushBits(text.length, ccBits);

    // Pairs of alphanumeric characters (11 bits), final single character (6 bits)
    for (let i = 0; i < text.length; i += 2) {
      const c1 = ALPHANUMERIC_CHARS.indexOf(text[i]);
      if (i + 1 < text.length) {
        const c2 = ALPHANUMERIC_CHARS.indexOf(text[i + 1]);
        pushBits(c1 * 45 + c2, 11);
      } else {
        pushBits(c1, 6);
      }
    }
  } else {
    // Mode indicator: Byte mode = 0100 (4 bits)
    pushBits(0b0100, 4);

    // Character count indicator: 8 bits for versions 1..9, 16 bits for 10..26
    const ccBits = spec.version <= 9 ? 8 : 16;
    pushBits(bytes.length, ccBits);

    // Data bytes
    for (let i = 0; i < bytes.length; i++) {
      pushBits(bytes[i], 8);
    }
  }

  // Terminator: up to 4 zero bits
  const terminatorLen = Math.min(4, totalBits - bits.length);
  pushBits(0, terminatorLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Convert bits to bytes
  const codewords = new Uint8Array(totalDataCodewords);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i + j];
    }
    codewords[byteIdx++] = b;
  }

  // Pad bytes alternating 0xEC and 0x11
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (byteIdx < totalDataCodewords) {
    codewords[byteIdx++] = padBytes[padIdx % 2];
    padIdx++;
  }

  return codewords;
}

function buildFinalMessage(dataCodewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const group of spec.blocks) {
    for (let i = 0; i < group.count; i++) {
      const block = dataCodewords.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(rsComputeRemainder(block, spec.ecCodewordsPerBlock));
    }
  }

  const result: number[] = [];

  // Interleave data codewords
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let col = 0; col < maxDataLen; col++) {
    for (let row = 0; row < dataBlocks.length; row++) {
      if (col < dataBlocks[row].length) {
        result.push(dataBlocks[row][col]);
      }
    }
  }

  // Interleave error correction codewords
  for (let col = 0; col < spec.ecCodewordsPerBlock; col++) {
    for (let row = 0; row < ecBlocks.length; row++) {
      result.push(ecBlocks[row][col]);
    }
  }

  return new Uint8Array(result);
}

// Compute 15-bit format information for Level M (00) and mask pattern (0..7)
function computeFormatBits(mask: number): number {
  // Level M indicator is 00
  const data = (0b00 << 3) | (mask & 0x7);
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= gen << (i - 10);
    }
  }
  const raw = (data << 10) | rem;
  return raw ^ 0x5412;
}

// Compute 18-bit version information for versions 7..10
function computeVersionBits(version: number): number {
  let rem = version << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= gen << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function createBaseMatrix(spec: VersionSpec): {
  modules: boolean[][];
  isFunction: boolean[][];
} {
  const side = 21 + 4 * (spec.version - 1);
  const modules: boolean[][] = Array.from({ length: side }, () =>
    Array<boolean>(side).fill(false)
  );
  const isFunction: boolean[][] = Array.from({ length: side }, () =>
    Array<boolean>(side).fill(false)
  );

  const setFunctionModule = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < side && c >= 0 && c < side) {
      modules[r][c] = dark;
      isFunction[r][c] = true;
    }
  };

  // Finder patterns + separators
  const drawFinder = (topR: number, leftC: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= side || c < 0 || c >= side) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (inBorder || inInner));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, side - 7);
  drawFinder(side - 7, 0);

  // Alignment patterns
  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      // Skip corners occupied by finder patterns
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = centers[i];
      const cc = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark =
            Math.abs(dr) === 2 ||
            Math.abs(dc) === 2 ||
            (dr === 0 && dc === 0);
          setFunctionModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Timing patterns (row 6 and col 6)
  for (let i = 8; i <= side - 9; i++) {
    const dark = i % 2 === 0;
    if (!isFunction[6][i]) setFunctionModule(6, i, dark);
    if (!isFunction[i][6]) setFunctionModule(i, 6, dark);
  }

  // Dark module at (4*version + 9, 8) = (side - 8, 8)
  setFunctionModule(side - 8, 8, true);

  // Reserve format info areas
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunctionModule(8, i, false);
    if (!isFunction[i][8]) setFunctionModule(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][side - 1 - i]) setFunctionModule(8, side - 1 - i, false);
  }
  for (let i = 0; i < 7; i++) {
    if (!isFunction[side - 1 - i][8]) setFunctionModule(side - 1 - i, 8, false);
  }

  // Version info areas for versions 7..10
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = side - 11 + (i % 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  return { modules, isFunction };
}

function drawFormatBits(modules: boolean[][], mask: number): void {
  const side = modules.length;
  const bits = computeFormatBits(mask);

  // Top-left format strip: MSB (bit 14) at (8, 0) -> LSB (bit 0) at (0, 8)
  for (let i = 0; i <= 5; i++) {
    modules[8][i] = ((bits >>> (14 - i)) & 1) === 1;
  }
  modules[8][7] = ((bits >>> 8) & 1) === 1;
  modules[8][8] = ((bits >>> 7) & 1) === 1;
  modules[7][8] = ((bits >>> 6) & 1) === 1;
  for (let i = 9; i < 15; i++) {
    modules[14 - i][8] = ((bits >>> (14 - i)) & 1) === 1;
  }

  // Bottom-left strip: MSB (bit 14) at (side - 1, 8) -> bit 8 at (side - 7, 8)
  for (let i = 0; i < 7; i++) {
    modules[side - 1 - i][8] = ((bits >>> (14 - i)) & 1) === 1;
  }
  // Top-right strip: bit 7 at (8, side - 8) -> LSB (bit 0) at (8, side - 1)
  for (let i = 7; i < 15; i++) {
    modules[8][side - 15 + i] = ((bits >>> (14 - i)) & 1) === 1;
  }

  // Dark module remains dark
  modules[side - 8][8] = true;
}

function placeCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  codewords: Uint8Array
): void {
  const side = modules.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = side - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip vertical timing column
    for (let step = 0; step < side; step++) {
      const r = upward ? side - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = right - dc;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            const byteVal = codewords[bitIdx >>> 3];
            const shift = 7 - (bitIdx & 7);
            dark = ((byteVal >>> shift) & 1) === 1;
            bitIdx++;
          }
          modules[r][c] = dark;
        }
      }
    }
    upward = !upward;
  }
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(
  baseModules: boolean[][],
  isFunction: boolean[][],
  mask: number
): boolean[][] {
  const masked = baseModules.map((row, r) =>
    row.map((val, c) => {
      if (isFunction[r][c]) return val;
      return maskCondition(mask, r, c) ? !val : val;
    })
  );
  drawFormatBits(masked, mask);
  return masked;
}

function evaluatePenalty(modules: boolean[][]): number {
  const side = modules.length;
  let penalty = 0;

  // Rule 1: Adjacent modules in row/column in same color (5+ -> 3 + (len - 5))
  for (let r = 0; r < side; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < side; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let c = 0; c < side; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < side; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color (+3 each)
  for (let r = 0; r < side - 1; r++) {
    for (let c = 0; c < side - 1; c++) {
      const color = modules[r][c];
      if (
        modules[r][c + 1] === color &&
        modules[r + 1][c] === color &&
        modules[r + 1][c + 1] === color
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: Finder-like 1:1:3:1:1 patterns with 4 light modules on either side (+40)
  const checkPattern = (line: boolean[]): number => {
    let count = 0;
    for (let i = 0; i <= line.length - 11; i++) {
      // 10111010000
      if (
        line[i] &&
        !line[i + 1] &&
        line[i + 2] &&
        line[i + 3] &&
        line[i + 4] &&
        !line[i + 5] &&
        line[i + 6] &&
        !line[i + 7] &&
        !line[i + 8] &&
        !line[i + 9] &&
        !line[i + 10]
      ) {
        count += 40;
      }
      // 00001011101
      if (
        !line[i] &&
        !line[i + 1] &&
        !line[i + 2] &&
        !line[i + 3] &&
        line[i + 4] &&
        !line[i + 5] &&
        line[i + 6] &&
        line[i + 7] &&
        line[i + 8] &&
        !line[i + 9] &&
        line[i + 10]
      ) {
        count += 40;
      }
    }
    return count;
  };

  for (let r = 0; r < side; r++) {
    penalty += checkPattern(modules[r]);
  }
  for (let c = 0; c < side; c++) {
    const col: boolean[] = new Array<boolean>(side);
    for (let r = 0; r < side; r++) col[r] = modules[r][c];
    penalty += checkPattern(col);
  }

  // Rule 4: Balance of dark modules
  let darkCount = 0;
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      if (modules[r][c]) darkCount++;
    }
  }
  const totalModules = side * side;
  const percent = (darkCount * 100) / totalModules;
  const prevMultiple = Math.floor(percent / 5) * 5;
  const nextMultiple = prevMultiple + 5;
  const steps = Math.min(
    Math.abs(prevMultiple - 50) / 5,
    Math.abs(nextMultiple - 50) / 5
  );
  penalty += steps * 10;

  return penalty;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const alnum = isAlphanumeric(text);

  // Pick smallest version (1..10) at Level M that fits the payload
  let chosenSpec: VersionSpec | null = null;
  for (const spec of VERSION_SPECS) {
    const totalDataCodewords = spec.blocks.reduce(
      (sum, b) => sum + b.count * b.dataCodewords,
      0
    );
    const totalBits = totalDataCodewords * 8;
    const neededBits = alnum
      ? 4 +
        (spec.version <= 9 ? 9 : 11) +
        Math.floor(text.length / 2) * 11 +
        (text.length % 2) * 6
      : 4 + (spec.version <= 9 ? 8 : 16) + bytes.length * 8;
    if (neededBits <= totalBits) {
      chosenSpec = spec;
      break;
    }
  }

  if (!chosenSpec) {
    throw new Error(
      `Input too long (${bytes.length} bytes) for QR Code versions 1–10 at error correction level M.`
    );
  }

  const dataCodewords = encodeDataCodewords(text, bytes, alnum, chosenSpec);
  const finalMessage = buildFinalMessage(dataCodewords, chosenSpec);
  const { modules, isFunction } = createBaseMatrix(chosenSpec);
  placeCodewords(modules, isFunction, finalMessage);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestMatrix: boolean[][] | null = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(modules, isFunction, mask);
    const penalty = evaluatePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  void bestMask;
  return bestMatrix!;
}
