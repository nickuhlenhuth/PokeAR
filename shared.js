// PokeBattle shared utilities: Pokemon name matching, sprite fetch, OCR preprocessing,
// Supabase realtime config. Used by both the battlefield (index.html) and capture
// (capture.html) views.

// ---------- Supabase config ----------
// Create a project at https://supabase.com, then paste Project URL + anon key below.
// Get them from: Project Settings → API. The anon key is safe to ship (public by design).
// No database tables needed — we only use Realtime broadcast + presence.

const SUPABASE_URL = 'https://pfcfmbccuekqtyzdefrg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmY2ZtYmNjdWVrcXR5emRlZnJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3OTQ1OTEsImV4cCI6MjA5MjM3MDU5MX0.Hf_UjKiuHf9nJNlZQa9tgTZG6fJUP97xhHYDe5PnjgY';

function supabaseConfigured() {
  return SUPABASE_URL
    && SUPABASE_ANON_KEY
    && !SUPABASE_URL.startsWith('YOUR_')
    && !SUPABASE_ANON_KEY.startsWith('YOUR_');
}

function createSupabaseClient() {
  if (!window.supabase) throw new Error('Supabase client library not loaded');
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ---------- Room + client IDs ----------

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateRoomId(length = 6) {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return id;
}

function generateClientId() {
  return 'c_' + Math.random().toString(36).slice(2, 10);
}

// ---------- Pokemon name list + fuzzy matching ----------

let pokemonNameSet = null;
let pokemonNames = [];
let pokemonNamesByLen = new Map();

async function loadPokemonList() {
  const res = await fetch('https://pokeapi.co/api/v2/pokemon?limit=2000');
  const data = await res.json();
  pokemonNames = data.results.map(p => p.name.toLowerCase());
  pokemonNameSet = new Set(pokemonNames);
  pokemonNamesByLen = new Map();
  for (const n of pokemonNames) {
    if (!pokemonNamesByLen.has(n.length)) pokemonNamesByLen.set(n.length, []);
    pokemonNamesByLen.get(n.length).push(n);
  }
}

function editDistance(a, b, maxAllowed) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  if (Math.abs(m - n) > maxAllowed) return maxAllowed + 1;
  const dp = Array.from({length: m + 1}, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      if (dp[i][j] < rowMin) rowMin = dp[i][j];
    }
    if (rowMin > maxAllowed) return maxAllowed + 1;
  }
  return dp[m][n];
}

// Exact at len >= 4; fuzzy only at len >= 6 with edit distance <= floor(len/5).
function matchWord(word) {
  if (!pokemonNameSet) return null;
  if (word.length < 4) return null;

  if (pokemonNameSet.has(word)) {
    return { name: word, dist: 0, score: word.length * 2 };
  }

  if (word.length < 6) return null;
  const maxDist = Math.floor(word.length / 5);
  if (maxDist < 1) return null;

  let best = null, bestDist = Infinity;
  for (let L = word.length - maxDist; L <= word.length + maxDist; L++) {
    const bucket = pokemonNamesByLen.get(L);
    if (!bucket) continue;
    for (const name of bucket) {
      const d = editDistance(word, name, maxDist);
      if (d < bestDist) { bestDist = d; best = name; if (d === 0) break; }
    }
    if (bestDist === 0) break;
  }
  if (bestDist > maxDist) return null;
  const score = best.length * 2 - bestDist * 3;
  return { name: best, dist: bestDist, score };
}

function findBestMatchInText(text) {
  if (!text) return null;
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let best = null;
  for (const w of words) {
    const m = matchWord(w);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

// Extracts an HP value from OCR'd name-band text. Pokemon cards print HP as
// e.g. "40 HP", "HP 80", or sometimes "HP80" — try both orders. Returns a
// number (1-500 range to filter obvious junk) or null.
function findHPInText(text) {
  if (!text) return null;
  const patterns = [
    /\b(\d{1,3})\s*HP\b/i,
    /\bHP\s*(\d{1,3})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const hp = parseInt(m[1], 10);
      if (hp >= 10 && hp <= 500) return hp;
    }
  }
  return null;
}

// ---------- Trainer avatars (Pokemon Showdown CDN) ----------
// Curated subset of Showdown trainer sprites. Hotlinked at runtime — matches
// the PokeAPI sprite pattern below, no local assets required. To add or
// reorder picks, edit this list (IDs must match filenames under
// https://play.pokemonshowdown.com/sprites/trainers/).

const TRAINER_AVATARS = [
  { id: 'red',     label: 'Red' },
  { id: 'blue',    label: 'Blue' },
  { id: 'ethan',   label: 'Ethan' },
  { id: 'lyra',    label: 'Lyra' },
  { id: 'brendan', label: 'Brendan' },
  { id: 'may',     label: 'May' },
  { id: 'dawn',    label: 'Dawn' },
  { id: 'lucas',   label: 'Lucas' },
  { id: 'n',       label: 'N' },
  { id: 'hilda',   label: 'Hilda' },
  { id: 'serena',  label: 'Serena' },
  { id: 'calem',   label: 'Calem' },
  { id: 'gloria',  label: 'Gloria' },
  { id: 'victor',  label: 'Victor' },
  { id: 'cynthia', label: 'Cynthia' },
  { id: 'lance',   label: 'Lance' },
];

function trainerAvatarUrl(id) {
  return `https://play.pokemonshowdown.com/sprites/trainers/${id}.png`;
}

// ---------- Sprite fetch (PokeAPI) ----------

const spriteCache = {};

async function getSpriteFor(name) {
  if (spriteCache[name] !== undefined) return spriteCache[name];
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
    if (!res.ok) { spriteCache[name] = null; return null; }
    const data = await res.json();
    const spriteUrl = data.sprites?.other?.showdown?.front_default
                   || data.sprites?.front_default
                   || null;
    spriteCache[name] = spriteUrl;
    return spriteUrl;
  } catch {
    spriteCache[name] = null;
    return null;
  }
}

// ---------- OCR preprocessing (capture view) ----------

function toGray(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(srcCanvas, 0, 0);
  const imgData = tmp.getContext('2d').getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  return { gray, w, h };
}

function adaptiveThreshold(gray, w, h, windowSize, C, invert) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += gray[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const half = Math.floor(windowSize / 2);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + (x2 + 1)]
                - integral[(y1) * (w + 1) + (x2 + 1)]
                - integral[(y2 + 1) * (w + 1) + (x1)]
                + integral[y1 * (w + 1) + x1];
      const mean = sum / area;
      const isFg = gray[y * w + x] < mean - C;
      out[y * w + x] = (invert ? !isFg : isFg) ? 0 : 255;
    }
  }
  return out;
}

function writeMaskToCanvas(mask, w, h, outCanvas) {
  outCanvas.width = w; outCanvas.height = h;
  const octx = outCanvas.getContext('2d');
  const imgData = octx.createImageData(w, h);
  const d = imgData.data;
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = mask[i];
    d[j + 3] = 255;
  }
  octx.putImageData(imgData, 0, 0);
}
