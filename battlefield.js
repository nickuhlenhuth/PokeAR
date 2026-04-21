// Battlefield view (iPad). Generates a room code + QR, manages Supabase
// presence + slot assignments, and renders sprites arriving via capture
// broadcasts with a pokeball entrance animation.

const state = {
  roomId: null,
  channel: null,
  client: null,
  slots: { 1: null, 2: null },   // slot number -> clientId or null
  processed: new Set(),          // clientIds we've already responded to
  pokeballUrl: null,
  pokeballPromise: null,
  slotAnim: {                    // per-slot animation queue (coalesces rapid-fire captures)
    1: { running: false, queued: null },
    2: { running: false, queued: null },
  },
};

function init() {
  ensurePokeballSprite(); // fire-and-forget preload

  if (isDemoMode()) loadDemoSprites();

  if (!supabaseConfigured()) {
    document.getElementById('setup-overlay').classList.add('active');
    return;
  }

  state.roomId = generateRoomId();
  state.client = createSupabaseClient();

  renderRoomCode(state.roomId);
  renderQRCode(state.roomId);

  state.channel = state.client.channel(`room:${state.roomId}`, {
    config: { presence: { key: 'battlefield' } },
  });

  state.channel
    .on('presence', { event: 'sync' }, handlePresenceSync)
    .on('broadcast', { event: 'capture' }, handleCaptureBroadcast)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await state.channel.track({ role: 'battlefield' });
        console.log(`[battlefield] subscribed to room:${state.roomId}`);
      }
    });
}

// ---------- Capture → animated slot update ----------

function handleCaptureBroadcast({ payload }) {
  const { player, pokemon } = payload || {};
  if (player !== 1 && player !== 2) return;
  if (!pokemon) return;

  console.log(`[battlefield] capture received: Player ${player} → ${pokemon}`);
  queueSlotUpdate(player, pokemon);
}

function queueSlotUpdate(player, pokemon) {
  const q = state.slotAnim[player];
  q.queued = pokemon;
  if (q.running) return;

  (async () => {
    while (q.queued) {
      const next = q.queued;
      q.queued = null;
      q.running = true;
      try {
        await updateSlot(player, next);
      } catch (e) {
        console.error(`[battlefield] slot ${player} update failed`, e);
      } finally {
        q.running = false;
      }
    }
  })();
}

async function updateSlot(player, pokemonName) {
  const slotEl = document.getElementById(`slot${player}`);
  const spriteEl = slotEl.querySelector('.slot-sprite');

  const [spriteUrl, pokeballUrl] = await Promise.all([
    getSpriteFor(pokemonName),
    ensurePokeballSprite(),
  ]);
  if (!spriteUrl) {
    console.warn(`[battlefield] no sprite found for "${pokemonName}"`);
    return;
  }

  // Fade out existing sprite first (if any)
  if (spriteEl.getAttribute('src')) {
    await fadeOutSprite(spriteEl);
  }

  await playEntrance(slotEl, spriteUrl, pokeballUrl);

  const statusEl = document.getElementById(`slot${player}-status`);
  statusEl.textContent = prettifyName(pokemonName);
  statusEl.classList.add('filled');
}

async function fadeOutSprite(spriteEl) {
  spriteEl.classList.remove('idle');
  await spriteEl.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 250, easing: 'ease-in', fill: 'forwards' }
  ).finished;
  spriteEl.removeAttribute('src');
  spriteEl.style.opacity = '';
}

async function playEntrance(slotEl, spriteUrl, pokeballUrl) {
  const pokeball = slotEl.querySelector('.slot-pokeball');
  const sprite = slotEl.querySelector('.slot-sprite');
  const flash = slotEl.querySelector('.slot-flash');

  // If we couldn't fetch the pokeball sprite, just pop the Pokemon in.
  if (!pokeballUrl) {
    sprite.src = spriteUrl;
    sprite.classList.add('idle');
    return;
  }

  pokeball.src = pokeballUrl;
  pokeball.classList.add('active');
  pokeball.style.opacity = '1';

  // 1. Drop from above (350ms, ease-in — accelerates toward the ground)
  await pokeball.animate(
    [
      { transform: 'translateY(-500%)' },
      { transform: 'translateY(0%)' },
    ],
    { duration: 350, easing: 'cubic-bezier(0.55, 0, 1, 0.45)', fill: 'forwards' }
  ).finished;

  // 2. Bounce (300ms — two damped bounces)
  await pokeball.animate(
    [
      { transform: 'translateY(0%)',   offset: 0 },
      { transform: 'translateY(-28%)', offset: 0.35 },
      { transform: 'translateY(0%)',   offset: 0.6 },
      { transform: 'translateY(-10%)', offset: 0.8 },
      { transform: 'translateY(0%)',   offset: 1 },
    ],
    { duration: 320, easing: 'ease-out', fill: 'forwards' }
  ).finished;

  // 3. Flash (180ms)
  await flash.animate(
    [{ opacity: 0 }, { opacity: 0.95, offset: 0.4 }, { opacity: 0 }],
    { duration: 180, easing: 'ease-out' }
  ).finished;

  // 4. Reveal sprite + fade pokeball (300ms)
  sprite.src = spriteUrl;
  sprite.style.opacity = '0';
  await Promise.all([
    sprite.animate(
      [
        { opacity: 0, transform: 'scale(0.4) translateY(8px)' },
        { opacity: 1, transform: 'scale(1) translateY(0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)', fill: 'forwards' }
    ).finished,
    pokeball.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 300, fill: 'forwards' }
    ).finished,
  ]);

  // Cleanup: hide pokeball, reset sprite inline styles, hand off to idle bob.
  pokeball.classList.remove('active');
  pokeball.style.opacity = '';
  pokeball.removeAttribute('src');
  sprite.style.opacity = '';
  sprite.style.transform = '';
  sprite.classList.add('idle');
}

async function ensurePokeballSprite() {
  if (state.pokeballUrl) return state.pokeballUrl;
  if (!state.pokeballPromise) {
    state.pokeballPromise = fetch('https://pokeapi.co/api/v2/item/poke-ball')
      .then(r => r.json())
      .then(data => {
        state.pokeballUrl = data?.sprites?.default || null;
        return state.pokeballUrl;
      })
      .catch((e) => {
        console.warn('[battlefield] pokeball sprite fetch failed', e);
        return null;
      });
  }
  return state.pokeballPromise;
}

// ---------- Room / QR / presence / assignment ----------

function prettifyName(name) {
  return name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function renderRoomCode(roomId) {
  document.getElementById('room-code').textContent = roomId;
}

function renderQRCode(roomId) {
  const captureUrl = new URL('capture.html', window.location.href);
  captureUrl.searchParams.set('room', roomId);
  const el = document.getElementById('qr-code');
  el.innerHTML = '';
  new QRCode(el, {
    text: captureUrl.toString(),
    width: 200,
    height: 200,
    correctLevel: QRCode.CorrectLevel.M,
  });
  console.log('[battlefield] QR target:', captureUrl.toString());
}

function handlePresenceSync() {
  const presences = state.channel.presenceState();

  for (const [clientId, metas] of Object.entries(presences)) {
    const meta = metas[0];
    if (!meta || meta.role !== 'player') continue;

    let slot = slotForClient(clientId);

    if (slot === undefined) {
      if (state.slots[1] === null) slot = 1;
      else if (state.slots[2] === null) slot = 2;
      else slot = null;

      if (slot !== null) state.slots[slot] = clientId;
      state.processed.add(clientId);
      console.log(`[battlefield] new client ${clientId} → Player ${slot}`);
    }

    sendAssignment(clientId, slot);
  }

  updateSlotStatuses();
  updateQRVisibility();
}

function slotForClient(clientId) {
  if (state.slots[1] === clientId) return 1;
  if (state.slots[2] === clientId) return 2;
  if (state.processed.has(clientId)) return null;
  return undefined;
}

async function sendAssignment(clientId, slot) {
  await state.channel.send({
    type: 'broadcast',
    event: 'assign',
    payload: { to: clientId, player: slot, roomId: state.roomId },
  });
}

function updateSlotStatuses() {
  const s1 = document.getElementById('slot1-status');
  const s2 = document.getElementById('slot2-status');

  // Don't overwrite a label that already shows a Pokemon name (filled state
  // stays set by updateSlot until the next capture).
  if (!s1.classList.contains('filled') || !state.slots[1]) {
    s1.textContent = state.slots[1] ? 'Player 1 joined' : 'Waiting for Player 1…';
    s1.classList.toggle('filled', !!state.slots[1]);
  }
  if (!s2.classList.contains('filled') || !state.slots[2]) {
    s2.textContent = state.slots[2] ? 'Player 2 joined' : 'Waiting for Player 2…';
    s2.classList.toggle('filled', !!state.slots[2]);
  }
}

function updateQRVisibility() {
  const qr = document.getElementById('qr-panel');
  if (state.slots[1] && state.slots[2]) qr.classList.add('hidden');
  else qr.classList.remove('hidden');
}

// ---------- Demo mode ----------
// ?demo=1 triggers the full entrance animation for Pikachu (P1) and Charizard
// (P2) so the animation + positioning can be showcased without phones.

function isDemoMode() {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

function loadDemoSprites() {
  queueSlotUpdate(1, 'pikachu');
  queueSlotUpdate(2, 'charizard');
}

init();
