// Capture view (phones). Phase 4: camera + one-shot OCR, typing fallback with
// autocomplete, and broadcast of the matched Pokemon name to the battlefield.

const state = {
  roomId: null,
  clientId: null,
  channel: null,
  client: null,
  player: null,                 // 1 | 2 | null once assigned
  stage: 'status',              // 'status' | 'camera' | 'confirm' | 'typing'
  video: null,
  nameBandCanvas: null,
  tesseractWorker: null,
  tesseractReady: false,
  cameraStream: null,
  lastCapture: null,            // { name, spriteUrl } from OCR
};

function init() {
  const params = new URLSearchParams(window.location.search);
  state.roomId = params.get('room');
  document.getElementById('room-code-value').textContent = state.roomId || '—';
  document.getElementById('room-small').textContent = state.roomId || '—';

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

  // Start loading the Pokemon list now so it's ready before any capture attempt.
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
  document.getElementById('start-camera-btn').addEventListener('click', onStartCamera);
  document.getElementById('capture-btn').addEventListener('click', onCapture);
  document.getElementById('type-btn').addEventListener('click', () => showStage('typing'));
  document.getElementById('confirm-yes').addEventListener('click', onConfirmYes);
  document.getElementById('confirm-no').addEventListener('click', onConfirmNo);
  document.getElementById('confirm-type').addEventListener('click', () => showStage('typing'));
  document.getElementById('typing-back').addEventListener('click', onTypingBack);
  document.getElementById('typing-send').addEventListener('click', onTypingSend);

  const input = document.getElementById('type-input');
  input.addEventListener('input', onTypeInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('typing-send').disabled) {
      onTypingSend();
    }
  });
}

// ---------- Assignment ----------

function handleAssignBroadcast({ payload }) {
  if (payload.to !== state.clientId) return;
  state.player = payload.player;

  if (payload.player === null) {
    setStatus('full', 'Battle is full', 'Both player slots are taken in this room.');
    return;
  }

  setStatus('assigned', `You are Player ${payload.player}`, 'Tap to enable your camera.');
  document.getElementById('start-camera-btn').style.display = 'inline-block';
  document.getElementById('player-badge').textContent = `Player ${payload.player}`;
  console.log(`[capture] assigned to Player ${payload.player}`);
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
      tessedit_pageseg_mode: '7',
    });
    state.tesseractReady = true;
    console.log('[capture] Tesseract ready');
  } catch (e) {
    console.error('[capture] Tesseract init failed', e);
  }
}

// ---------- Camera ----------

async function onStartCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.cameraStream = stream;
    state.video.srcObject = stream;
    await state.video.play();
    showStage('camera');
    ensureTesseractWorker();
  } catch (e) {
    console.error('[capture] camera error', e);
    setStatus('error', 'Camera unavailable', `${e.message}. You can still use "Type name instead" via the camera screen after retry — or try a different browser.`);
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

    console.log('[capture] OCR reads:', result.reads, 'debug:', result.debug);
    state.lastDebugImage = result.debug?.nameBandDataUrl || null;

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

// Crop the card-guide region out of the current video frame, isolate the top
// 14% (name band), run two threshold variants through Tesseract, return the
// best match.
async function runOCRFromVideo() {
  const video = state.video;
  const guideRect = document.getElementById('card-guide').getBoundingClientRect();
  const stageRect = video.getBoundingClientRect();

  // video has object-fit: cover — compute the actual displayed video rect.
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
  if (vw < 50 || vh < 50) return null;

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

  // Debug preview: the raw color name-band crop before thresholding — lets the
  // user see exactly what region was handed to OCR so framing issues are obvious.
  const debug = {
    nameBandDataUrl: state.nameBandCanvas.toDataURL('image/png'),
    nameBandDims: `${state.nameBandCanvas.width}×${state.nameBandCanvas.height}`,
    videoDims: `${video.videoWidth}×${video.videoHeight}`,
    sourceCrop: `x=${Math.round(nameX)} y=${Math.round(nameY)} w=${Math.round(nameW)} h=${Math.round(nameH)}`,
  };

  return { match: best, reads, debug };
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
  renderDebugImage();
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
  renderDebugImage();
  showStage('confirm');
}

function renderDebugImage() {
  const wrap = document.getElementById('confirm-debug');
  const img = document.getElementById('confirm-debug-img');
  if (state.lastDebugImage) {
    img.src = state.lastDebugImage;
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
  }
}

async function onConfirmYes() {
  if (!state.lastCapture?.name) { onConfirmNo(); return; }
  const name = state.lastCapture.name;
  await sendCapture(name);
  state.lastCapture = null;
  returnToCamera(`Sent: ${prettifyName(name)}`);
}

function onConfirmNo() {
  state.lastCapture = null;
  returnToCamera();
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

async function onTypingSend() {
  const name = document.getElementById('type-input').value.toLowerCase().trim();
  if (!name || !pokemonNameSet?.has(name)) return;
  await sendCapture(name);
  document.getElementById('type-input').value = '';
  document.getElementById('type-preview').textContent = 'Start typing…';
  document.getElementById('typing-send').disabled = true;
  returnToCamera(`Sent: ${prettifyName(name)}`);
}

function onTypingBack() {
  returnToCamera();
}

// ---------- Broadcast ----------

async function sendCapture(pokemonName) {
  await state.channel.send({
    type: 'broadcast',
    event: 'capture',
    payload: { player: state.player, pokemon: pokemonName, roomId: state.roomId },
  });
  console.log(`[capture] sent: Player ${state.player} → ${pokemonName}`);
}

// ---------- UI helpers ----------

function showStage(name) {
  state.stage = name;
  for (const id of ['status-stage', 'camera-stage', 'confirm-stage', 'typing-stage']) {
    document.getElementById(id).classList.toggle('active', id === `${name}-stage`);
  }
  if (name === 'typing') {
    setTimeout(() => document.getElementById('type-input').focus(), 100);
  }
}

function returnToCamera(sentMsg) {
  if (state.cameraStream) {
    showStage('camera');
    if (sentMsg) showSentBanner(sentMsg);
  } else {
    showStage('status');
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

function showSentBanner(msg) {
  const b = document.getElementById('last-sent-banner');
  b.textContent = msg;
  b.classList.remove('show');
  void b.offsetWidth; // force reflow so the animation re-triggers
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 2500);
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

function prettifyName(name) {
  return name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

init();
