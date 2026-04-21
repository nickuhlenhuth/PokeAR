// Capture view (phones). Phase 6+: post-assignment the phone becomes a
// battle dashboard — trainer name, ACTIVE tile, BENCH row, "Capture new
// Pokemon" button. The phone is the source of truth for its own player and
// broadcasts `player_state` snapshots for the battlefield to render.

const state = {
  roomId: null,
  clientId: null,
  channel: null,
  client: null,
  player: null,                 // 1 | 2 | null
  stage: 'status',              // 'status' | 'trainer' | 'dashboard' | 'camera' | 'confirm' | 'typing'
  video: null,
  nameBandCanvas: null,
  tesseractWorker: null,
  tesseractReady: false,
  cameraStream: null,
  lastCapture: null,
  pendingDestination: null,     // { type: 'active' } | { type: 'bench', slot } | null
  playerState: {                // own-player state (authoritative)
    trainerName: null,
    active: null,               // { name, hp, maxHp } or null
    bench: [null, null, null, null, null],
  },
};

function init() {
  const params = new URLSearchParams(window.location.search);
  state.roomId = params.get('room');
  document.getElementById('room-code-value').textContent = state.roomId || '—';
  document.getElementById('room-small').textContent = state.roomId || '—';
  document.getElementById('trainer-room-code').textContent = state.roomId || '—';

  if (!state.roomId) {
    setStatus('error', 'No room code', 'Scan the QR code on the battlefield iPad to join.');
    return;
  }
  if (!supabaseConfigured()) {
    document.getElementById('setup-overlay').classList.add('active');
    return;
  }

  wireButtons();
  state.video = document.getElementById('video');
  state.nameBandCanvas = document.createElement('canvas');

  ensurePokemonListLoaded();

  state.clientId = getOrCreateClientId(state.roomId);
  state.client = createSupabaseClient();
  state.channel = state.client.channel(`room:${state.roomId}`, {
    config: { presence: { key: state.clientId } },
  });

  state.channel
    .on('broadcast', { event: 'assign' }, handleAssignBroadcast)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await state.channel.track({ role: 'player', clientId: state.clientId });
        setStatus('waiting', 'Connected', 'Waiting for the battlefield to assign a slot…');
        console.log(`[capture] joined room:${state.roomId} as ${state.clientId}`);
      }
    });
}

function wireButtons() {
  // Trainer stage
  const trainerInput = document.getElementById('trainer-name-input');
  trainerInput.addEventListener('input', (e) => {
    document.getElementById('trainer-submit').disabled = !e.target.value.trim();
  });
  trainerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) onTrainerSubmit();
  });
  document.getElementById('trainer-submit').addEventListener('click', onTrainerSubmit);

  // Dashboard — each slot is directly tappable (empty → opens camera for that
  // slot, filled → action sheet for retreat/swap/release/replace).
  document.getElementById('dashboard-edit-name').addEventListener('click', onEditName);
  document.getElementById('active-tile').addEventListener('click', onActiveTileTap);
  document.querySelectorAll('#bench-row .bench-tile').forEach((tile) => {
    tile.addEventListener('click', () => onBenchTileTap(Number(tile.dataset.slot)));
  });

  // Action sheet
  document.getElementById('action-sheet-cancel').addEventListener('click', hideActionSheet);
  document.getElementById('action-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'action-sheet') hideActionSheet();
  });

  // Camera
  document.getElementById('camera-back').addEventListener('click', onCameraBack);
  document.getElementById('capture-btn').addEventListener('click', onCapture);
  document.getElementById('type-btn').addEventListener('click', () => showStage('typing'));

  // Confirm
  document.getElementById('confirm-yes').addEventListener('click', onConfirmYes);
  document.getElementById('confirm-no').addEventListener('click', onConfirmNo);
  document.getElementById('confirm-type').addEventListener('click', () => showStage('typing'));

  // Typing
  document.getElementById('typing-back').addEventListener('click', onTypingBack);
  document.getElementById('typing-send').addEventListener('click', onTypingSend);
  const input = document.getElementById('type-input');
  input.addEventListener('input', onTypeInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('typing-send').disabled) onTypingSend();
  });
}

// ---------- Assignment + trainer ----------

function handleAssignBroadcast({ payload }) {
  if (payload.to !== state.clientId) return;
  state.player = payload.player;

  if (payload.player === null) {
    setStatus('full', 'Battle is full', 'Both player slots are taken in this room.');
    return;
  }

  document.getElementById('trainer-player-number').textContent = payload.player;
  document.getElementById('dashboard-player-tag').textContent = `Player ${payload.player}`;
  document.getElementById('player-badge').textContent = `Player ${payload.player}`;
  console.log(`[capture] assigned to Player ${payload.player}`);

  // Fast-path: if this room has a remembered player state, skip the trainer
  // stage and go straight to the dashboard (restores full lineup on reload).
  const saved = loadPlayerStateFromStorage(state.roomId);
  if (saved && saved.trainerName) {
    state.playerState = normalizePlayerState(saved);
    renderDashboardAll();
    broadcastPlayerState();
    showStage('dashboard');
  } else {
    showStage('trainer');
    setTimeout(() => document.getElementById('trainer-name-input').focus(), 100);
  }
}

function onTrainerSubmit() {
  const name = document.getElementById('trainer-name-input').value.trim();
  if (!name) return;
  state.playerState.trainerName = name;
  persistAndBroadcast();
  renderDashboardAll();
  showStage('dashboard');
}

function onEditName() {
  const input = document.getElementById('trainer-name-input');
  input.value = state.playerState.trainerName || '';
  document.getElementById('trainer-submit').disabled = !input.value.trim();
  showStage('trainer');
  setTimeout(() => input.focus(), 100);
}

// ---------- Capture entry point: tap any slot ----------
// Empty slots open the camera; the destination is remembered until the user
// sends a Pokemon (capture confirm or typing send), at which point the
// Pokemon lands in that slot.

async function onSlotTap(destination) {
  state.pendingDestination = destination;
  updateCameraDestinationLabel();

  if (!state.cameraStream) {
    try {
      await startCamera();
    } catch (e) {
      console.warn('[capture] camera unavailable, falling back to typing', e);
      showStage('typing');
      return;
    }
  }
  showStage('camera');
  ensureTesseractWorker();
}

function onCameraBack() {
  state.pendingDestination = null;
  showStage('dashboard');
}

function updateCameraDestinationLabel() {
  const label = document.getElementById('camera-destination-label');
  const dest = state.pendingDestination;
  if (!dest) { label.textContent = '—'; return; }
  label.textContent = dest.type === 'active'
    ? 'Adding: Active'
    : `Adding: Bench ${dest.slot + 1}`;
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  state.cameraStream = stream;
  state.video.srcObject = stream;
  await state.video.play();
}

// ---------- Pokemon list + Tesseract loading ----------

async function ensurePokemonListLoaded() {
  if (pokemonNameSet) return;
  try {
    await loadPokemonList();
    populateDatalist();
  } catch (e) {
    console.warn('[capture] failed to load Pokemon list', e);
  }
}

function populateDatalist() {
  const list = document.getElementById('pokemon-names');
  list.innerHTML = '';
  for (const name of pokemonNames) {
    const opt = document.createElement('option');
    opt.value = name;
    list.appendChild(opt);
  }
}

async function ensureTesseractWorker() {
  if (state.tesseractWorker) return;
  try {
    state.tesseractWorker = await Tesseract.createWorker('eng');
    await state.tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz \'',
      // PSM 6 = "single uniform block of text" — handles the multi-line
      // ("Basic Pokémon" subtitle + name) name band better than PSM 7.
      tessedit_pageseg_mode: '6',
    });
    state.tesseractReady = true;
    console.log('[capture] Tesseract ready');
  } catch (e) {
    console.error('[capture] Tesseract init failed', e);
  }
}

// ---------- Capture (OCR) ----------

async function onCapture() {
  if (!pokemonNameSet) {
    showCameraMsg('Loading Pokemon list…');
    setTimeout(hideCameraMsg, 1500);
    return;
  }
  if (!state.tesseractReady) {
    showCameraMsg('Warming up OCR…');
    setTimeout(hideCameraMsg, 1500);
    return;
  }
  if (!state.video.videoWidth) {
    showCameraMsg('Camera not ready yet');
    setTimeout(hideCameraMsg, 1500);
    return;
  }

  const btn = document.getElementById('capture-btn');
  btn.disabled = true;
  showCameraMsg('Reading card…');

  try {
    const result = await runOCRFromVideo();
    hideCameraMsg();
    console.log('[capture] OCR reads:', result.reads);

    if (!result.match) {
      const readSamples = result.reads.map(r => r.text).filter(Boolean);
      const sample = readSamples.length ? readSamples.join(' / ') : '(nothing)';
      showConfirmError(`Read: "${sample}" — no Pokemon match. Reframe the card (keep the NAME in the blue box, hold steady, avoid glare) or tap "Type name instead".`);
      return;
    }

    const spriteUrl = await getSpriteFor(result.match.name);
    state.lastCapture = { name: result.match.name, spriteUrl };
    showConfirm(result.match.name, spriteUrl);
  } catch (e) {
    console.error('[capture] OCR error', e);
    showConfirmError('Something went wrong reading the card. Check the console.');
  } finally {
    btn.disabled = false;
  }
}

async function runOCRFromVideo() {
  const video = state.video;
  const guideRect = document.getElementById('card-guide').getBoundingClientRect();
  const stageRect = video.getBoundingClientRect();

  const vAspect = video.videoWidth / video.videoHeight;
  const dAspect = stageRect.width / stageRect.height;
  let dispW, dispH, offX, offY;
  if (vAspect > dAspect) {
    dispH = stageRect.height; dispW = dispH * vAspect;
    offX = (stageRect.width - dispW) / 2; offY = 0;
  } else {
    dispW = stageRect.width; dispH = dispW / vAspect;
    offX = 0; offY = (stageRect.height - dispH) / 2;
  }
  const sx = video.videoWidth / dispW, sy = video.videoHeight / dispH;

  const guideLocalX = guideRect.left - stageRect.left;
  const guideLocalY = guideRect.top - stageRect.top;
  const vx = Math.max(0, (guideLocalX - offX) * sx);
  const vy = Math.max(0, (guideLocalY - offY) * sy);
  const vw = Math.min(video.videoWidth - vx, guideRect.width * sx);
  const vh = Math.min(video.videoHeight - vy, guideRect.height * sy);
  if (vw < 50 || vh < 50) return { match: null, reads: [] };

  const nameX = vx + vw * 0.03;
  const nameY = vy + vh * 0.03;
  const nameW = vw * 0.94;
  const nameH = vh * 0.14;

  const upscale = 3;
  state.nameBandCanvas.width = Math.floor(nameW * upscale);
  state.nameBandCanvas.height = Math.floor(nameH * upscale);
  const nCtx = state.nameBandCanvas.getContext('2d');
  nCtx.imageSmoothingEnabled = true;
  nCtx.imageSmoothingQuality = 'high';
  nCtx.drawImage(video, nameX, nameY, nameW, nameH, 0, 0, state.nameBandCanvas.width, state.nameBandCanvas.height);

  const { gray, w, h } = toGray(state.nameBandCanvas);
  let win = Math.floor(Math.min(w, h) / 4);
  if (win % 2 === 0) win++;
  if (win < 15) win = 15;

  const maskA = adaptiveThreshold(gray, w, h, win, 10, false);
  const maskB = adaptiveThreshold(gray, w, h, win, 10, true);
  const cvA = document.createElement('canvas');
  const cvB = document.createElement('canvas');
  writeMaskToCanvas(maskA, w, h, cvA);
  writeMaskToCanvas(maskB, w, h, cvB);

  let best = null;
  const reads = [];
  for (const [label, cv] of [['A', cvA], ['B', cvB]]) {
    const { data } = await state.tesseractWorker.recognize(cv);
    const text = (data.text || '').trim().replace(/\n+/g, ' ');
    reads.push({ label, text });
    const m = findBestMatchInText(text);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return { match: best, reads };
}

// ---------- Confirm stage ----------

function showConfirm(name, spriteUrl) {
  document.getElementById('confirm-name').textContent = prettifyName(name);
  document.getElementById('confirm-error').style.display = 'none';
  document.getElementById('confirm-yes').style.display = '';
  const img = document.getElementById('confirm-preview');
  if (spriteUrl) {
    img.src = spriteUrl;
    img.style.display = 'block';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
  }
  showStage('confirm');
}

function showConfirmError(msg) {
  document.getElementById('confirm-name').textContent = '—';
  document.getElementById('confirm-preview').style.display = 'none';
  document.getElementById('confirm-preview').removeAttribute('src');
  document.getElementById('confirm-yes').style.display = 'none';
  const err = document.getElementById('confirm-error');
  err.textContent = msg;
  err.style.display = 'block';
  showStage('confirm');
}

function onConfirmYes() {
  if (!state.lastCapture?.name) { onConfirmNo(); return; }
  const name = state.lastCapture.name;
  state.lastCapture = null;
  placePendingCapture(name);
  showStage('dashboard');
}

function onConfirmNo() {
  state.lastCapture = null;
  // Return to wherever we came from — if the camera stream is live, back to
  // camera; otherwise typing.
  showStage(state.cameraStream ? 'camera' : 'typing');
}

// ---------- Typing stage ----------

let typeInputDebounce = null;

function onTypeInput(e) {
  const raw = e.target.value.toLowerCase().trim();
  document.getElementById('typing-send').disabled = !(pokemonNameSet && pokemonNameSet.has(raw));

  clearTimeout(typeInputDebounce);
  typeInputDebounce = setTimeout(async () => {
    const preview = document.getElementById('type-preview');
    preview.innerHTML = '';
    if (!raw) { preview.textContent = 'Start typing…'; return; }
    if (!pokemonNameSet) { preview.textContent = 'Still loading Pokemon list…'; return; }
    if (!pokemonNameSet.has(raw)) { preview.textContent = 'Not a known Pokemon name.'; return; }
    const url = await getSpriteFor(raw);
    const label = document.createElement('span');
    label.textContent = `Preview: ${prettifyName(raw)} `;
    preview.appendChild(label);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      preview.appendChild(img);
    }
  }, 180);
}

function onTypingSend() {
  const name = document.getElementById('type-input').value.toLowerCase().trim();
  if (!name || !pokemonNameSet?.has(name)) return;
  document.getElementById('type-input').value = '';
  document.getElementById('type-preview').textContent = 'Start typing…';
  document.getElementById('typing-send').disabled = true;
  placePendingCapture(name);
  showStage('dashboard');
}

function onTypingBack() {
  state.pendingDestination = null;
  showStage('dashboard');
}

// ---------- Placing captures into the pending slot ----------

function placePendingCapture(name) {
  const dest = state.pendingDestination;
  state.pendingDestination = null;
  if (!dest) {
    console.warn('[capture] placement called with no pendingDestination');
    return;
  }
  if (dest.type === 'active') {
    setActive(mkPoke(name));
  } else if (dest.type === 'bench') {
    state.playerState.bench[dest.slot] = mkPoke(name);
    persistAndBroadcast();
    renderDashboardBench();
  }
}

// ---------- Active / bench tile taps ----------
// Empty slots → open camera for that destination. Filled slots → action sheet.

function onActiveTileTap() {
  const active = state.playerState.active;
  if (!active) {
    onSlotTap({ type: 'active' });
    return;
  }
  const spriteUrl = spriteUrlCacheFor(active.name);
  const benchFull = firstEmptyBenchSlot() === -1;
  showActionSheet({
    subtitle: 'Active',
    name: active.name,
    spriteUrl,
    buttons: [
      {
        label: benchFull ? 'Retreat to bench (full)' : 'Retreat to bench',
        disabled: benchFull,
        onClick: retreatActive,
      },
      {
        label: 'Replace with new capture',
        onClick: () => {
          hideActionSheet();
          onSlotTap({ type: 'active' });
        },
      },
      { label: 'Release', danger: true, onClick: releaseActive },
    ],
  });
}

function onBenchTileTap(slot) {
  const poke = state.playerState.bench[slot];
  if (!poke) {
    onSlotTap({ type: 'bench', slot });
    return;
  }
  const spriteUrl = spriteUrlCacheFor(poke.name);
  showActionSheet({
    subtitle: `Bench slot ${slot + 1}`,
    name: poke.name,
    spriteUrl,
    buttons: [
      {
        label: state.playerState.active ? 'Swap to active' : 'Make active',
        primary: true,
        onClick: () => promoteBench(slot),
      },
      {
        label: 'Replace with new capture',
        onClick: () => {
          hideActionSheet();
          onSlotTap({ type: 'bench', slot });
        },
      },
      { label: 'Release', danger: true, onClick: () => releaseBench(slot) },
    ],
  });
}

// ---------- State operations ----------

function mkPoke(name) {
  // HP fields stay null until Phase 8 adds HP tracking.
  return { name, hp: null, maxHp: null };
}

function setActive(poke) {
  state.playerState.active = poke;
  persistAndBroadcast();
  renderDashboardActive();
}

function firstEmptyBenchSlot() {
  return state.playerState.bench.findIndex(p => !p);
}

function retreatActive() {
  const active = state.playerState.active;
  if (!active) return;
  const slot = firstEmptyBenchSlot();
  if (slot === -1) return;
  state.playerState.bench[slot] = active;
  state.playerState.active = null;
  persistAndBroadcast();
  renderDashboardAll();
  hideActionSheet();
}

function releaseActive() {
  state.playerState.active = null;
  persistAndBroadcast();
  renderDashboardActive();
  hideActionSheet();
}

function promoteBench(slot) {
  const benchPoke = state.playerState.bench[slot];
  if (!benchPoke) return;
  const currentActive = state.playerState.active;
  state.playerState.active = benchPoke;
  state.playerState.bench[slot] = currentActive || null;
  persistAndBroadcast();
  renderDashboardAll();
  hideActionSheet();
}

function releaseBench(slot) {
  state.playerState.bench[slot] = null;
  persistAndBroadcast();
  renderDashboardBench();
  hideActionSheet();
}

// ---------- Broadcast + persistence ----------

function persistAndBroadcast() {
  savePlayerStateToStorage(state.roomId, state.playerState);
  broadcastPlayerState();
}

async function broadcastPlayerState() {
  if (!state.channel || !state.player) return;
  await state.channel.send({
    type: 'broadcast',
    event: 'player_state',
    payload: { player: state.player, state: state.playerState, roomId: state.roomId },
  });
  console.log(`[capture] player_state for Player ${state.player}`, state.playerState);
}

// ---------- Dashboard rendering ----------

function renderDashboardAll() {
  renderDashboardTrainer();
  renderDashboardActive();
  renderDashboardBench();
}

function renderDashboardTrainer() {
  document.getElementById('dashboard-trainer-name').textContent =
    state.playerState.trainerName || '—';
}

async function renderDashboardActive() {
  const tile = document.getElementById('active-tile');
  if (!state.playerState.active) {
    tile.classList.add('active-empty');
    tile.classList.remove('active-filled');
    tile.innerHTML = '<div class="active-placeholder">No active Pokemon yet. Tap a bench Pokemon to promote, or "Capture Pokemon" below.</div>';
    return;
  }
  const name = state.playerState.active.name;
  const url = await getSpriteFor(name);
  tile.classList.remove('active-empty');
  tile.classList.add('active-filled');
  tile.innerHTML = `
    <img class="active-sprite" src="${url || ''}" alt="" />
    <div>
      <div class="active-name">${prettifyName(name)}</div>
      <div class="active-note">Tap for actions</div>
    </div>
  `;
}

async function renderDashboardBench() {
  const tiles = document.querySelectorAll('#bench-row .bench-tile');
  for (const tile of tiles) {
    const slot = Number(tile.dataset.slot);
    const poke = state.playerState.bench[slot];
    if (!poke) {
      tile.classList.remove('filled');
      tile.innerHTML = '+';
      continue;
    }
    const url = await getSpriteFor(poke.name);
    tile.classList.add('filled');
    tile.innerHTML = `
      <img src="${url || ''}" alt="" />
      <div class="bench-name">${prettifyName(poke.name)}</div>
    `;
  }
}

// ---------- Action sheet ----------

function showActionSheet({ subtitle, name, spriteUrl, buttons }) {
  document.getElementById('action-sheet-subtitle').textContent = subtitle;
  document.getElementById('action-sheet-name').textContent = prettifyName(name);
  const sprite = document.getElementById('action-sheet-sprite');
  if (spriteUrl) { sprite.src = spriteUrl; sprite.style.display = 'block'; }
  else { sprite.removeAttribute('src'); sprite.style.display = 'none'; }

  const container = document.getElementById('action-sheet-buttons');
  container.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'sheet-btn';
    if (b.primary) btn.classList.add('primary');
    if (b.danger) btn.classList.add('danger');
    if (b.disabled) btn.disabled = true;
    btn.textContent = b.label;
    btn.addEventListener('click', () => { if (!b.disabled) b.onClick(); });
    container.appendChild(btn);
  }
  document.getElementById('action-sheet').classList.add('visible');
}

function hideActionSheet() {
  document.getElementById('action-sheet').classList.remove('visible');
}

// Cheap cache lookup — spriteCache is populated by getSpriteFor(). Used so the
// action sheet can show a sprite thumbnail without awaiting a fetch.
function spriteUrlCacheFor(name) {
  return (typeof spriteCache !== 'undefined' && spriteCache[name]) || null;
}

// ---------- UI helpers ----------

function showStage(name) {
  state.stage = name;
  for (const id of ['status-stage', 'trainer-stage', 'dashboard-stage', 'camera-stage', 'confirm-stage', 'typing-stage']) {
    document.getElementById(id).classList.toggle('active', id === `${name}-stage`);
  }
  if (name === 'typing') {
    setTimeout(() => document.getElementById('type-input').focus(), 100);
  }
}

function showCameraMsg(msg) {
  const el = document.getElementById('camera-msg');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideCameraMsg() {
  document.getElementById('camera-msg').style.display = 'none';
}

function setStatus(kind, headline, detail) {
  const card = document.getElementById('status-card');
  card.classList.remove('assigned', 'error', 'full');
  if (kind === 'assigned') card.classList.add('assigned');
  else if (kind === 'error') card.classList.add('error');
  else if (kind === 'full') card.classList.add('full');

  document.getElementById('status-headline').textContent = headline;
  document.getElementById('status-detail').textContent = detail;
}

// ---------- localStorage ----------

function getOrCreateClientId(roomId) {
  const key = `pokebattle.clientId.${roomId}`;
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = generateClientId();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return generateClientId();
  }
}

function savePlayerStateToStorage(roomId, playerState) {
  try {
    localStorage.setItem(`pokebattle.state.${roomId}`, JSON.stringify(playerState));
  } catch {}
}
function loadPlayerStateFromStorage(roomId) {
  try {
    const raw = localStorage.getItem(`pokebattle.state.${roomId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Guards against partial saved shapes from earlier versions.
function normalizePlayerState(raw) {
  return {
    trainerName: raw?.trainerName || null,
    active: raw?.active || null,
    bench: Array.isArray(raw?.bench) && raw.bench.length === 5
      ? raw.bench
      : [null, null, null, null, null],
  };
}

function prettifyName(name) {
  return name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

init();
