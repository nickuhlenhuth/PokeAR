// Capture view (phones). Phase 2: parse ?room=... from URL, join the Supabase
// channel, receive a player slot assignment from the battlefield.

const state = {
  roomId: null,
  clientId: null,
  channel: null,
  client: null,
  player: null,   // 1, 2, or null once assigned
};

function init() {
  const params = new URLSearchParams(window.location.search);
  state.roomId = params.get('room');

  document.getElementById('room-code-value').textContent = state.roomId || '—';

  if (!state.roomId) {
    setStatus('error', 'No room code', 'Scan the QR code on the battlefield iPad to join.');
    return;
  }

  if (!supabaseConfigured()) {
    document.getElementById('setup-overlay').classList.add('active');
    return;
  }

  state.clientId = generateClientId();
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

function handleAssignBroadcast({ payload }) {
  if (payload.to !== state.clientId) return;

  state.player = payload.player;
  if (payload.player === null) {
    setStatus('full', 'Battle is full', 'Both player slots are already taken in this room.');
  } else {
    setStatus('assigned', `You are Player ${payload.player}`, 'Capture UI lands in phase 4.');
    console.log(`[capture] assigned to Player ${payload.player}`);
  }
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

init();
