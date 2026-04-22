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
  damageMode: null,             // 'attack' | 'heal' | 'take' while modal is open
  damageTarget: null,           // { type: 'active' } | { type: 'bench', slot } while modal is open
  playerState: {                // own-player state (authoritative)
    trainerName: null,
    avatarId: null,             // Showdown trainer sprite id (see TRAINER_AVATARS)
    active: null,               // { name, hp, maxHp } or null
    bench: [null, null, null, null, null],
  },
  selectedAvatarId: null,       // transient trainer-stage selection
};

function init() {
  const params = new URLSearchParams(window.location.search);
  state.roomId = params.get('room');
  document.getElementById('room-code-value').textContent = state.roomId || '—';
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
    .on('broadcast', { event: 'attack_effect' }, handleAttackEffectBroadcast)
    .on('broadcast', { event: 'voice_command' }, handleVoiceCommandBroadcast)
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
  populateAvatarGrid();
  const trainerInput = document.getElementById('trainer-name-input');
  trainerInput.addEventListener('input', updateTrainerSubmitEnabled);
  trainerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('trainer-submit').disabled) onTrainerSubmit();
  });
  document.getElementById('trainer-submit').addEventListener('click', onTrainerSubmit);

  // Dashboard — each slot is directly tappable (empty → opens camera for that
  // slot, filled → action sheet for retreat/swap/release/replace). Inline
  // battle-action buttons on the filled active tile are handled separately.
  document.getElementById('dashboard-edit-name').addEventListener('click', onEditName);
  document.getElementById('active-tile').addEventListener('click', (e) => {
    const battleBtn = e.target.closest('[data-battle]');
    if (battleBtn) {
      e.stopPropagation();
      openDamageModal(battleBtn.dataset.battle);
      return;
    }
    onActiveTileTap();
  });
  document.querySelectorAll('#bench-row .bench-tile').forEach((tile) => {
    tile.addEventListener('click', () => onBenchTileTap(Number(tile.dataset.slot)));
  });

  // Damage modal
  document.getElementById('damage-cancel').addEventListener('click', closeDamageModal);
  document.getElementById('damage-confirm').addEventListener('click', onDamageConfirm);
  document.querySelectorAll('#damage-presets button').forEach((btn) => {
    btn.addEventListener('click', () => onDamagePreset(Number(btn.dataset.val)));
  });
  document.getElementById('damage-custom').addEventListener('input', onDamageCustomInput);
  document.getElementById('damage-modal').addEventListener('click', (e) => {
    if (e.target.id === 'damage-modal') closeDamageModal();
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

  // Push-to-talk voice commands
  initVoice();
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
  document.getElementById('dashboard-player-tag').textContent = `Trainer ${payload.player}`;
  document.getElementById('player-badge').textContent = `Trainer ${payload.player}`;
  console.log(`[capture] assigned to Trainer ${payload.player}`);

  // Fast-path: if this room has a remembered player state, skip the trainer
  // stage and go straight to the dashboard (restores full lineup on reload).
  // Requires both name AND avatar — legacy saves missing avatarId fall through
  // to the picker with the name pre-filled.
  const saved = loadPlayerStateFromStorage(state.roomId);
  if (saved && saved.trainerName && saved.avatarId) {
    state.playerState = normalizePlayerState(saved);
    renderDashboardAll();
    broadcastPlayerState();
    showStage('dashboard');
  } else {
    if (saved?.trainerName) {
      state.playerState = normalizePlayerState(saved);
      document.getElementById('trainer-name-input').value = saved.trainerName;
    }
    updateTrainerSubmitEnabled();
    showStage('trainer');
    setTimeout(() => document.getElementById('trainer-name-input').focus(), 100);
  }
}

function onTrainerSubmit() {
  const name = document.getElementById('trainer-name-input').value.trim();
  if (!name || !state.selectedAvatarId) return;
  state.playerState.trainerName = name;
  state.playerState.avatarId = state.selectedAvatarId;
  persistAndBroadcast();
  renderDashboardAll();
  showStage('dashboard');
}

function onEditName() {
  const input = document.getElementById('trainer-name-input');
  input.value = state.playerState.trainerName || '';
  state.selectedAvatarId = state.playerState.avatarId || null;
  renderAvatarSelection();
  updateTrainerSubmitEnabled();
  showStage('trainer');
  setTimeout(() => input.focus(), 100);
}

// ---------- Avatar grid ----------

function populateAvatarGrid() {
  const grid = document.getElementById('avatar-grid');
  grid.innerHTML = '';
  for (const av of TRAINER_AVATARS) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'avatar-tile';
    tile.dataset.avatarId = av.id;
    tile.setAttribute('aria-label', av.label);
    const img = document.createElement('img');
    img.src = trainerAvatarUrl(av.id);
    img.alt = av.label;
    tile.appendChild(img);
    tile.addEventListener('click', () => onAvatarTileTap(av.id));
    grid.appendChild(tile);
  }
}

function onAvatarTileTap(id) {
  state.selectedAvatarId = id;
  renderAvatarSelection();
  updateTrainerSubmitEnabled();
}

function renderAvatarSelection() {
  const tiles = document.querySelectorAll('#avatar-grid .avatar-tile');
  for (const tile of tiles) {
    tile.classList.toggle('selected', tile.dataset.avatarId === state.selectedAvatarId);
  }
}

function updateTrainerSubmitEnabled() {
  const name = document.getElementById('trainer-name-input').value.trim();
  document.getElementById('trainer-submit').disabled = !(name && state.selectedAvatarId);
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

// Fully release the camera hardware (LED off) when leaving the capture
// session. Tracks must be stopped individually — just nulling the stream is
// not enough.
function stopCamera() {
  if (!state.cameraStream) return;
  for (const track of state.cameraStream.getTracks()) track.stop();
  state.cameraStream = null;
  if (state.video) state.video.srcObject = null;
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
      // Digits included so the "40 HP" text on the name band reads cleanly
      // alongside the Pokemon name.
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \'',
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
    state.lastCapture = { name: result.match.name, spriteUrl, hp: result.hp };
    showConfirm(result.match.name, spriteUrl, result.hp);
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
  let bestHP = null;
  const reads = [];
  for (const [label, cv] of [['A', cvA], ['B', cvB]]) {
    const { data } = await state.tesseractWorker.recognize(cv);
    const text = (data.text || '').trim().replace(/\n+/g, ' ');
    reads.push({ label, text });
    const m = findBestMatchInText(text);
    if (m && (!best || m.score > best.score)) best = m;
    // Try to extract HP from whichever read is cleaner; prefer the first match.
    const hp = findHPInText(text);
    if (hp != null && bestHP == null) bestHP = hp;
  }
  return { match: best, reads, hp: bestHP };
}

// ---------- Confirm stage ----------

function showConfirm(name, spriteUrl, hp) {
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
  const hpInput = document.getElementById('confirm-hp');
  hpInput.value = hp != null ? String(hp) : '';
  hpInput.classList.toggle('detected', hp != null);
  document.getElementById('confirm-hp-row').style.display = 'flex';
  showStage('confirm');
}

function showConfirmError(msg) {
  document.getElementById('confirm-name').textContent = '—';
  document.getElementById('confirm-preview').style.display = 'none';
  document.getElementById('confirm-preview').removeAttribute('src');
  document.getElementById('confirm-yes').style.display = 'none';
  document.getElementById('confirm-hp-row').style.display = 'none';
  const err = document.getElementById('confirm-error');
  err.textContent = msg;
  err.style.display = 'block';
  showStage('confirm');
}

function onConfirmYes() {
  if (!state.lastCapture?.name) { onConfirmNo(); return; }
  const name = state.lastCapture.name;
  const hp = readHPInput('confirm-hp');
  state.lastCapture = null;
  placePendingCapture(name, hp);
  showStage('dashboard');
}

function readHPInput(id) {
  const raw = document.getElementById(id).value.trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
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
  const hp = readHPInput('type-hp');
  document.getElementById('type-input').value = '';
  document.getElementById('type-hp').value = '';
  document.getElementById('type-preview').textContent = 'Start typing…';
  document.getElementById('typing-send').disabled = true;
  placePendingCapture(name, hp);
  showStage('dashboard');
}

function onTypingBack() {
  state.pendingDestination = null;
  showStage('dashboard');
}

// ---------- Placing captures into the pending slot ----------

function placePendingCapture(name, hp) {
  const dest = state.pendingDestination;
  state.pendingDestination = null;
  if (!dest) {
    console.warn('[capture] placement called with no pendingDestination');
    return;
  }
  const poke = mkPoke(name, hp);
  if (dest.type === 'active') {
    setActive(poke);
  } else if (dest.type === 'bench') {
    state.playerState.bench[dest.slot] = poke;
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
  const isKO = active.hp === 0 && active.maxHp != null;
  const benchFull = firstEmptyBenchSlot() === -1;

  if (isKO) {
    showActionSheet({
      subtitle: 'Knocked out',
      name: active.name,
      spriteUrl,
      buttons: [
        {
          label: 'Capture new active',
          primary: true,
          onClick: () => {
            hideActionSheet();
            // Drop the KO'd Pokemon; capture replaces the active slot.
            state.playerState.active = null;
            persistAndBroadcast();
            renderDashboardActive();
            onSlotTap({ type: 'active' });
          },
        },
        { label: 'Release', danger: true, onClick: releaseActive },
      ],
    });
    return;
  }

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
  const canHeal = poke.hp != null && poke.maxHp != null && poke.hp < poke.maxHp;
  const canTakeDmg = poke.hp != null && poke.hp > 0;
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
        label: 'Attack',
        onClick: () => {
          hideActionSheet();
          openDamageModal('attack', { type: 'bench', slot });
        },
      },
      {
        label: 'Heal',
        disabled: !canHeal,
        onClick: () => {
          hideActionSheet();
          openDamageModal('heal', { type: 'bench', slot });
        },
      },
      {
        label: 'Take damage',
        disabled: !canTakeDmg,
        onClick: () => {
          hideActionSheet();
          openDamageModal('take', { type: 'bench', slot });
        },
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

function mkPoke(name, hp) {
  if (hp == null) return { name, hp: null, maxHp: null };
  return { name, hp, maxHp: hp };
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
  // A KO'd active doesn't swap back to the bench — it's gone.
  const activeIsKO = currentActive && currentActive.hp === 0 && currentActive.maxHp != null;
  state.playerState.bench[slot] = activeIsKO ? null : (currentActive || null);
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
  const avatar = document.getElementById('dashboard-trainer-avatar');
  if (state.playerState.avatarId) {
    avatar.src = trainerAvatarUrl(state.playerState.avatarId);
    avatar.classList.add('visible');
  } else {
    avatar.removeAttribute('src');
    avatar.classList.remove('visible');
  }
}

async function renderDashboardActive() {
  const tile = document.getElementById('active-tile');
  if (!state.playerState.active) {
    tile.classList.add('active-empty');
    tile.classList.remove('active-filled', 'active-ko');
    tile.innerHTML = `
      <div>
        <div class="active-placeholder">No Active Pokemon</div>
        <div class="active-plus">+</div>
      </div>
    `;
    return;
  }
  const { name, hp, maxHp } = state.playerState.active;
  const url = await getSpriteFor(name);
  tile.classList.remove('active-empty');
  tile.classList.add('active-filled');

  const isKO = (hp === 0 && maxHp != null);
  tile.classList.toggle('active-ko', isKO);

  let hpLine;
  if (isKO) hpLine = 'Knocked out';
  else if (hp != null && maxHp != null) hpLine = `HP ${hp} / ${maxHp}`;
  else hpLine = 'Tap to set HP';

  const showBattle = (hp != null && maxHp != null && hp > 0);
  tile.innerHTML = `
    <div class="active-main">
      <img class="active-sprite${isKO ? ' ko' : ''}" src="${url || ''}" alt="" />
      <div>
        <div class="active-name">${prettifyName(name)}</div>
        <div class="active-hp">${hpLine}</div>
      </div>
    </div>
    ${showBattle ? `
    <div class="battle-actions">
      <button data-battle="attack" class="attack">Attack</button>
      <button data-battle="heal" class="heal">Heal</button>
      <button data-battle="take" class="take">Take</button>
    </div>` : ''}
    ${isKO ? `<div class="ko-hint">Promote a bench Pokemon or capture a new active</div>` : ''}
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

// ---------- Damage-entry modal (Attack / Heal / Take Damage) ----------

function openDamageModal(mode, target = { type: 'active' }) {
  const poke = targetPoke(target);
  if (!poke) return;
  // Attack doesn't require HP on the source; heal/take require HP to mutate.
  if ((mode === 'heal' || mode === 'take') && poke.hp == null) return;
  state.damageMode = mode;
  state.damageTarget = target;
  const modal = document.getElementById('damage-modal');
  modal.classList.remove('attack', 'heal', 'take');
  modal.classList.add(mode);
  const titleMap = { attack: 'Attack', heal: 'Heal', take: 'Take Damage' };
  document.getElementById('damage-modal-title').textContent = titleMap[mode];
  const pokeName = prettifyName(poke.name);
  const headlineMap = {
    attack: `${pokeName} attacks the opposing Pokemon`,
    heal: `Heal ${pokeName}`,
    take: `${pokeName} takes damage`,
  };
  document.getElementById('damage-modal-headline').textContent = headlineMap[mode];
  document.getElementById('damage-custom').value = '';
  document.getElementById('damage-confirm').disabled = true;
  modal.classList.add('visible');
}

function closeDamageModal() {
  document.getElementById('damage-modal').classList.remove('visible');
  state.damageMode = null;
  state.damageTarget = null;
}

function onDamagePreset(val) {
  const input = document.getElementById('damage-custom');
  input.value = String(val);
  document.getElementById('damage-confirm').disabled = !(val > 0);
}

function onDamageCustomInput() {
  const val = parseInt(document.getElementById('damage-custom').value, 10);
  document.getElementById('damage-confirm').disabled = !(val > 0);
}

async function onDamageConfirm() {
  const amount = parseInt(document.getElementById('damage-custom').value, 10);
  if (!(amount > 0)) return;
  const mode = state.damageMode;
  const target = state.damageTarget || { type: 'active' };
  closeDamageModal();
  if (mode === 'attack') await doAttack(amount);
  else if (mode === 'heal') await doHealTarget(target, amount);
  else if (mode === 'take') await doTakeDamageTarget(target, amount);
}

function targetPoke(target) {
  if (!target) return null;
  if (target.type === 'active') return state.playerState.active;
  if (target.type === 'bench') return state.playerState.bench[target.slot] || null;
  return null;
}

function hasAnyPokemon() {
  return !!state.playerState.active || state.playerState.bench.some(p => p);
}

async function doAttack(damage) {
  if (!hasAnyPokemon()) return;
  const targetPlayer = state.player === 1 ? 2 : 1;
  await state.channel.send({
    type: 'broadcast',
    event: 'attack_effect',
    payload: {
      attackerPlayer: state.player,
      targetPlayer,
      damage,
    },
  });
  console.log(`[capture] Attack → Trainer ${targetPlayer} for ${damage}`);
}

async function doHealTarget(target, amount) {
  const poke = targetPoke(target);
  if (!poke || poke.maxHp == null) return;
  poke.hp = Math.min(poke.maxHp, (poke.hp ?? 0) + amount);
  persistAndBroadcast();
  if (target.type === 'active') renderDashboardActive();
  else renderDashboardBench();
  // iPad heal animation is keyed to the active slot only.
  if (target.type === 'active') {
    await state.channel.send({
      type: 'broadcast',
      event: 'heal_effect',
      payload: { targetPlayer: state.player, amount },
    });
  }
  console.log(`[capture] Heal ${target.type}${target.slot != null ? ' #' + target.slot : ''} +${amount}; hp now ${poke.hp}/${poke.maxHp}`);
}

async function doTakeDamageTarget(target, damage) {
  const poke = targetPoke(target);
  if (!poke || poke.hp == null) return;
  poke.hp = Math.max(0, poke.hp - damage);
  persistAndBroadcast();
  if (target.type === 'active') renderDashboardActive();
  else renderDashboardBench();
  if (target.type === 'active') {
    await state.channel.send({
      type: 'broadcast',
      event: 'attack_effect',
      payload: {
        attackerPlayer: state.player,
        targetPlayer: state.player,
        damage,
      },
    });
  }
  console.log(`[capture] ${target.type}${target.slot != null ? ' #' + target.slot : ''} took ${damage}; hp now ${poke.hp}`);
}

// Incoming attack — if targeted at us, apply damage and broadcast new state.
async function handleAttackEffectBroadcast({ payload }) {
  const { targetPlayer, damage } = payload || {};
  if (targetPlayer !== state.player) return;
  const active = state.playerState.active;
  if (!active || active.hp == null) return;
  active.hp = Math.max(0, active.hp - damage);
  persistAndBroadcast();
  renderDashboardActive();
  console.log(`[capture] Hit for ${damage}; hp now ${active.hp}`);
}

// Incoming voice command from the iPad (operator held LShift/RShift).
// Parse and execute locally if it's addressed to this player.
function handleVoiceCommandBroadcast({ payload }) {
  const { player, transcript } = payload || {};
  if (player !== state.player) return;
  if (!transcript) return;
  console.log(`[capture] voice_command "${transcript}"`);
  const parsed = parseVoiceCommand(transcript);
  executeVoiceCommand(parsed);
}

// ---------- UI helpers ----------

function showStage(name) {
  state.stage = name;
  for (const id of ['status-stage', 'trainer-stage', 'dashboard-stage', 'camera-stage', 'confirm-stage', 'typing-stage']) {
    document.getElementById(id).classList.toggle('active', id === `${name}-stage`);
  }
  // Release the camera when leaving the capture session. Keep it alive when
  // bouncing camera ↔ confirm (try-again loop); everywhere else, shut it down
  // so the device LED turns off.
  if (name !== 'camera' && name !== 'confirm') {
    stopCamera();
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
    avatarId: raw?.avatarId || null,
    active: raw?.active || null,
    bench: Array.isArray(raw?.bench) && raw.bench.length === 5
      ? raw.bench
      : [null, null, null, null, null],
  };
}

function prettifyName(name) {
  return name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ---------- Push-to-talk voice commands ----------
//
// Hold the mic button, speak a command, release to execute. Grammar:
//   "Go <name>!"            → promote that bench Pokemon to active
//   "<name>, come back!"    → retreat active to bench
//   "<name>, attack N HP!"  → attack opponent for N
//   "<name>, heal N HP!"    → heal named Pokemon (active or bench) by N
//   "<name>, take N damage" → deal N damage to named Pokemon (active or bench)

const VOICE_NUMBER_WORDS = {
  ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

let voiceToastTimer = null;

function initVoice() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.disabled = true;
    btn.querySelector('.voice-label').textContent = 'Voice not supported';
    return;
  }

  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 3;

  let listening = false;
  const setListening = (on) => {
    listening = on;
    btn.classList.toggle('listening', on);
    btn.querySelector('.voice-label').textContent = on ? 'Listening…' : 'Hold to speak';
  };

  const start = (e) => {
    e.preventDefault();
    if (listening) return;
    try {
      recognition.start();
      setListening(true);
    } catch (err) {
      // Most common: start() called while a previous session is still ending.
      console.warn('[voice] start failed:', err);
    }
  };
  const stop = () => {
    if (!listening) return;
    try { recognition.stop(); } catch {}
  };

  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
  // Block the browser context menu on long-press, which fights push-to-talk.
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  recognition.addEventListener('end', () => setListening(false));
  recognition.addEventListener('error', (e) => {
    setListening(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showVoiceToast('Microphone access denied. Enable it in Settings.', 'error');
    } else if (e.error === 'no-speech') {
      showVoiceToast("Didn't catch that — try again.", 'warn');
    } else if (e.error !== 'aborted') {
      console.warn('[voice] recognition error:', e.error);
    }
  });
  recognition.addEventListener('result', (event) => {
    const alternatives = [];
    const result = event.results[0];
    for (let i = 0; i < result.length; i++) alternatives.push(result[i].transcript);
    // Pick the first alternative that parses into a complete command.
    let chosen = null;
    for (const t of alternatives) {
      const parsed = parseVoiceCommand(t);
      if (!parsed.error) { chosen = parsed; break; }
    }
    if (!chosen) chosen = parseVoiceCommand(alternatives[0] || '');
    executeVoiceCommand(chosen);
  });
}

function parseVoiceCommand(rawTranscript) {
  const transcript = (rawTranscript || '').trim();
  if (!transcript) return { error: "didn't catch that", transcript };
  const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Intent detection — order matters: check retreat before "take"/"heal"
  // because "come back" shouldn't be confused with a damage-shaped phrase.
  let intent = null;
  if (/\bcome\s+back\b/.test(clean) || /\breturn\b/.test(clean)) intent = 'retreat';
  else if (/\badd\b/.test(clean)) intent = 'add';
  else if (/(^|\s)go\b/.test(clean)) intent = 'go';
  else if (/\battack\b/.test(clean)) intent = 'attack';
  else if (/\bheal\b/.test(clean)) intent = 'heal';
  else if (/\btake\b/.test(clean) || /\bdamage\b/.test(clean)) intent = 'take';

  if (!intent) return { error: "couldn't detect a command", transcript };

  const match = (typeof findBestMatchInText === 'function') ? findBestMatchInText(clean) : null;
  const pokemonName = match?.name || null;
  if (!pokemonName) {
    if (typeof pokemonNameSet === 'undefined' || !pokemonNameSet) {
      return { error: 'Pokemon list still loading', transcript };
    }
    return { error: "couldn't find a Pokemon name", transcript };
  }

  const needsNumber = intent === 'attack' || intent === 'heal' || intent === 'take' || intent === 'add';
  let number = null;
  if (needsNumber) {
    number = extractVoiceNumber(clean);
    if (number == null) return { error: "couldn't find a number", transcript };
  }

  return { intent, pokemonName, number, transcript };
}

function extractVoiceNumber(clean) {
  const digitMatch = clean.match(/\b(\d{1,3})\b/);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (n > 0) return n;
  }
  for (const word in VOICE_NUMBER_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(clean)) return VOICE_NUMBER_WORDS[word];
  }
  return null;
}

function findOwnedPokemon(name) {
  const needle = name.toLowerCase();
  const ps = state.playerState;
  if (ps.active && ps.active.name.toLowerCase() === needle) {
    return { type: 'active', poke: ps.active };
  }
  const slot = ps.bench.findIndex(p => p && p.name.toLowerCase() === needle);
  if (slot !== -1) return { type: 'bench', slot, poke: ps.bench[slot] };
  return null;
}

async function executeVoiceCommand(cmd) {
  if (!cmd || cmd.error) {
    const t = cmd?.transcript ? `"${cmd.transcript}" — ` : '';
    showVoiceToast(`${t}${cmd?.error || 'no command'}`, 'error');
    return;
  }

  const pretty = prettifyName(cmd.pokemonName);

  // `add` doesn't require ownership — it creates a new bench entry.
  if (cmd.intent === 'add') {
    const slot = firstEmptyBenchSlot();
    if (slot === -1) {
      showVoiceToast('Bench is full', 'error');
      return;
    }
    state.playerState.bench[slot] = mkPoke(cmd.pokemonName, cmd.number);
    persistAndBroadcast();
    renderDashboardBench();
    showVoiceToast(`Added ${pretty} (${cmd.number} HP) to bench`, 'ok');
    return;
  }

  const owned = findOwnedPokemon(cmd.pokemonName);
  if (!owned) {
    showVoiceToast(`You don't have a ${pretty}`, 'error');
    return;
  }

  switch (cmd.intent) {
    case 'go': {
      if (owned.type === 'active') {
        showVoiceToast(`${pretty} is already active`, 'warn');
        return;
      }
      promoteBench(owned.slot);
      showVoiceToast(`Go ${pretty}!`, 'ok');
      return;
    }
    case 'retreat': {
      if (owned.type === 'bench') {
        showVoiceToast(`${pretty} is already on the bench`, 'warn');
        return;
      }
      if (firstEmptyBenchSlot() === -1) {
        showVoiceToast(`Bench is full — ${pretty} can't retreat`, 'error');
        return;
      }
      retreatActive();
      showVoiceToast(`${pretty} returns!`, 'ok');
      return;
    }
    case 'attack': {
      await doAttack(cmd.number);
      showVoiceToast(`${pretty} attacks for ${cmd.number}`, 'ok');
      return;
    }
    case 'heal': {
      const target = owned.type === 'active' ? { type: 'active' } : { type: 'bench', slot: owned.slot };
      if (owned.poke.maxHp == null) {
        showVoiceToast(`${pretty} has no HP set`, 'error');
        return;
      }
      await doHealTarget(target, cmd.number);
      showVoiceToast(`Healed ${pretty} +${cmd.number}`, 'ok');
      return;
    }
    case 'take': {
      const target = owned.type === 'active' ? { type: 'active' } : { type: 'bench', slot: owned.slot };
      if (owned.poke.hp == null) {
        showVoiceToast(`${pretty} has no HP set`, 'error');
        return;
      }
      await doTakeDamageTarget(target, cmd.number);
      showVoiceToast(`${pretty} took ${cmd.number}`, 'ok');
      return;
    }
  }
}

function showVoiceToast(text, kind = 'ok') {
  const el = document.getElementById('voice-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'error');
  el.classList.add(kind, 'visible');
  if (voiceToastTimer) clearTimeout(voiceToastTimer);
  voiceToastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 2500);
}

init();
