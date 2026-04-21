// Battlefield view (iPad). Phase 2: generate a room, render QR, manage realtime
// presence + slot assignments via Supabase.

const state = {
  roomId: null,
  channel: null,
  client: null,
  slots: { 1: null, 2: null },   // slot number -> clientId or null
  processed: new Set(),          // clientIds we've already responded to
};

function init() {
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

async function handleCaptureBroadcast({ payload }) {
  const { player, pokemon } = payload || {};
  if (player !== 1 && player !== 2) return;
  if (!pokemon) return;

  console.log(`[battlefield] capture received: Player ${player} → ${pokemon}`);
  const url = await getSpriteFor(pokemon);
  const img = document.getElementById(`slot${player}-sprite`);
  if (url) {
    img.src = url;
  }

  const statusEl = document.getElementById(`slot${player}-status`);
  statusEl.textContent = prettifyName(pokemon);
  statusEl.classList.add('filled');
}

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
      // New client — assign to the next open slot (or null if full).
      if (state.slots[1] === null) slot = 1;
      else if (state.slots[2] === null) slot = 2;
      else slot = null;

      if (slot !== null) state.slots[slot] = clientId;
      state.processed.add(clientId);
      console.log(`[battlefield] new client ${clientId} → Player ${slot}`);
    }

    // Re-broadcast on every sync so reconnecting phones catch back up to their slot.
    sendAssignment(clientId, slot);
  }

  updateSlotStatuses();
  updateQRVisibility();
}

function slotForClient(clientId) {
  if (state.slots[1] === clientId) return 1;
  if (state.slots[2] === clientId) return 2;
  if (state.processed.has(clientId)) return null; // previously rejected
  return undefined; // never seen
}

async function sendAssignment(clientId, slot) {
  console.log(`[battlefield] assigning ${clientId} → Player ${slot}`);
  await state.channel.send({
    type: 'broadcast',
    event: 'assign',
    payload: { to: clientId, player: slot, roomId: state.roomId },
  });
}

function updateSlotStatuses() {
  const s1 = document.getElementById('slot1-status');
  const s2 = document.getElementById('slot2-status');

  if (state.slots[1]) {
    s1.textContent = 'Player 1 joined';
    s1.classList.add('filled');
  } else {
    s1.textContent = 'Waiting for Player 1…';
    s1.classList.remove('filled');
  }

  if (state.slots[2]) {
    s2.textContent = 'Player 2 joined';
    s2.classList.add('filled');
  } else {
    s2.textContent = 'Waiting for Player 2…';
    s2.classList.remove('filled');
  }
}

function updateQRVisibility() {
  const qr = document.getElementById('qr-panel');
  if (state.slots[1] && state.slots[2]) qr.classList.add('hidden');
  else qr.classList.remove('hidden');
}

// ---------- Phase 3 demo mode ----------
// Open index.html?demo=1 to hardcode Pikachu (P1) and Charizard (P2) into the
// slots so sprite positioning against the stadium background can be tuned.
// Independent of Supabase — does not require credentials.

function isDemoMode() {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

async function loadDemoSprites() {
  const [p1, p2] = await Promise.all([
    getSpriteFor('pikachu'),
    getSpriteFor('charizard'),
  ]);
  if (p1) document.getElementById('slot1-sprite').src = p1;
  if (p2) document.getElementById('slot2-sprite').src = p2;
}

init();
