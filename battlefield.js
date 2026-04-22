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
  playerStates: { 1: null, 2: null }, // last-seen player_state snapshots
};

// Attack sound effect. Used on every attack for now; future work may swap to
// per-attack variants by changing the URL lookup in playHitEffect.
const ATTACK_SFX_URL = 'freesound_crunchpixstudio-attack-fire-384913.mp3';
const ATTACK_SFX_DURATION_MS = 1020;
const attackSfx = new Audio(ATTACK_SFX_URL);
attackSfx.preload = 'auto';

// Defers HP bar + HP text + hp-class updates on the target's nameplate until
// the attack sound finishes, so the sound doubles as the impact → tally beat.
const hpLockUntil = { 1: 0, 2: 0 };

function init() {
  ensurePokeballSprite(); // fire-and-forget preload
  installAudioUnlock();

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
    .on('broadcast', { event: 'player_state' }, handlePlayerStateBroadcast)
    .on('broadcast', { event: 'attack_effect' }, handleAttackEffectBroadcast)
    .on('broadcast', { event: 'heal_effect' }, handleHealEffectBroadcast)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await state.channel.track({ role: 'battlefield' });
        console.log(`[battlefield] subscribed to room:${state.roomId}`);
      }
    });

  initVoiceRelay();
}

// ---------- Player state → trainer/sprite rendering ----------

function handlePlayerStateBroadcast({ payload }) {
  const { player, state: newState } = payload || {};
  if (player !== 1 && player !== 2) return;
  if (!newState) return;

  const prev = state.playerStates[player];
  state.playerStates[player] = newState;
  console.log(`[battlefield] player_state for Trainer ${player}`, newState);

  // Trainer name changed (or first set)
  if (!prev || prev.trainerName !== newState.trainerName) {
    renderTrainerName(player, newState.trainerName);
  }

  // Trainer avatar changed (or first set)
  if (!prev || prev.avatarId !== newState.avatarId) {
    renderTrainerAvatar(player, newState.avatarId);
  }

  // Active Pokemon changed (or first set)
  const prevName = prev?.active?.name || null;
  const newName = newState.active?.name || null;
  const prevHP = prev?.active?.hp;
  const newHP = newState.active?.hp;
  if (newName && prevName !== newName) {
    queueSlotUpdate(player, newName);
  } else if (!newName && prevName) {
    // Active cleared (released / retreated to bench) — fade it out.
    queueSlotClear(player);
  } else if (newName && prevName === newName && prevHP > 0 && newHP === 0) {
    // Same Pokemon, but HP just hit zero — KO.
    queueSlotKO(player);
  }

  // Re-render the nameplate on every state change so HP bar stays in sync
  // (covers attack/heal/take-damage flows even when the Pokemon name didn't
  // change). Elements are updated in place so the bar width animates.
  renderNameplate(player, newState.active);

  // Bench diff — slot might change by name OR by HP.
  const prevBench = prev?.bench || [null, null, null, null, null];
  const newBench = newState.bench || [null, null, null, null, null];
  for (let i = 0; i < 5; i++) {
    const pb = prevBench[i];
    const nb = newBench[i];
    const changed =
      (pb?.name || null) !== (nb?.name || null) ||
      (pb?.hp ?? null) !== (nb?.hp ?? null) ||
      (pb?.maxHp ?? null) !== (nb?.maxHp ?? null);
    if (changed) renderBenchSlot(player, i, nb);
  }
}

function handleAttackEffectBroadcast({ payload }) {
  const { targetPlayer, damage } = payload || {};
  if (targetPlayer !== 1 && targetPlayer !== 2) return;
  playHitEffect(targetPlayer, damage);
}

function handleHealEffectBroadcast({ payload }) {
  const { targetPlayer, amount } = payload || {};
  if (targetPlayer !== 1 && targetPlayer !== 2) return;
  playHealEffect(targetPlayer, amount);
}

function renderTrainerName(player, name) {
  const el = document.getElementById(`slot${player}-trainer`);
  if (!el) return;
  if (name) {
    el.textContent = name;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

function renderTrainerAvatar(player, avatarId) {
  const wrapper = document.getElementById(`slot${player}-trainer-avatar`);
  if (!wrapper) return;
  const img = wrapper.querySelector('img');
  if (avatarId) {
    img.src = trainerAvatarUrl(avatarId);
    wrapper.classList.add('visible');
  } else {
    img.removeAttribute('src');
    wrapper.classList.remove('visible');
  }
}

async function renderBenchSlot(player, slot, poke) {
  const el = document.querySelector(`.bench-slot[data-player="${player}"][data-slot="${slot}"]`);
  if (!el) return;
  if (!poke) {
    el.classList.remove('filled');
    el.innerHTML = '';
    return;
  }
  const url = await getSpriteFor(poke.name);
  el.classList.add('filled');
  const hpTxt = (poke.hp != null && poke.maxHp != null) ? `${poke.hp}/${poke.maxHp}` : '';
  el.innerHTML = `
    <img src="${url || ''}" alt="" />
    <div class="bench-slot-name">${prettifyName(poke.name)}</div>
    ${hpTxt ? `<div class="bench-slot-hp">${hpTxt}</div>` : ''}
  `;
}

// Nameplate for the active slot — persists across HP changes so the bar
// width animates via CSS transition (transitioning a width change on the
// same element, rather than replacing the element each time).
function renderNameplate(player, active) {
  const el = document.getElementById(`slot${player}-status`);
  if (!el) return;

  if (!active) {
    el.innerHTML = `Waiting for Trainer ${player}…`;
    el.classList.remove('filled', 'hp-low', 'hp-mid');
    return;
  }

  // Ensure scaffold exists
  if (!el.querySelector('.np-name')) {
    el.innerHTML = `
      <div class="np-name"></div>
      <div class="np-bar" style="display:none;"><div class="np-bar-fill"></div></div>
      <div class="np-hp" style="display:none;"></div>
    `;
  }

  el.classList.add('filled');
  el.querySelector('.np-name').textContent = prettifyName(active.name);

  // While an attack sound is playing for this player, hold the HP readout
  // (bar width, HP text, hp-low/mid/ko classes) at its pre-attack values so
  // the damage tally lands when the sound finishes. Name + filled class still
  // update normally. playHitEffect re-invokes us once the lock expires.
  if (performance.now() < hpLockUntil[player]) return;

  const bar = el.querySelector('.np-bar');
  const barFill = el.querySelector('.np-bar-fill');
  const hpEl = el.querySelector('.np-hp');

  const hasHp = active.hp != null && active.maxHp != null;
  if (hasHp) {
    const pct = Math.max(0, Math.min(1, active.hp / active.maxHp));
    bar.style.display = '';
    hpEl.style.display = '';
    barFill.style.width = `${pct * 100}%`;
    hpEl.textContent = `HP ${active.hp} / ${active.maxHp}`;
    el.classList.toggle('hp-mid', pct <= 0.5 && pct > 0.2);
    el.classList.toggle('hp-low', pct <= 0.2);
    el.classList.toggle('ko', active.hp === 0);
  } else {
    bar.style.display = 'none';
    hpEl.style.display = 'none';
    el.classList.remove('hp-mid', 'hp-low', 'ko');
  }
}

// ---------- Hit + heal effects ----------

// Safari (and other browsers) block HTMLAudioElement.play() until the user has
// interacted with the page. The battlefield view is otherwise passive, so we
// prime the attack SFX on the first pointerdown/touchstart/keydown anywhere.
function installAudioUnlock() {
  const unlock = () => {
    const p = attackSfx.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        attackSfx.pause();
        attackSfx.currentTime = 0;
      }).catch(() => {});
    }
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('touchstart', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

function playHitEffect(player, damage) {
  // Visual impact fires immediately so it syncs with the sound's crunch.
  playSpriteHit(player);
  playFlash(player, 'damage');

  // Start the sound and hold the damage readout (floating -X and HP bar
  // decrease) until it finishes.
  attackSfx.currentTime = 0;
  const playPromise = attackSfx.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((e) => console.warn('[battlefield] attackSfx blocked', e));
  }

  hpLockUntil[player] = performance.now() + ATTACK_SFX_DURATION_MS;

  setTimeout(() => {
    hpLockUntil[player] = 0;
    spawnFloatingNumber(player, `-${damage}`, 'damage');
    // Re-render the nameplate against the latest known state so the HP bar
    // width animates down now (state was updated in place during the lock).
    const active = state.playerStates[player]?.active || null;
    renderNameplate(player, active);
  }, ATTACK_SFX_DURATION_MS);
}

function playHealEffect(player, amount) {
  playFlash(player, 'heal');
  spawnFloatingNumber(player, `+${amount}`, 'heal');
}

function playSpriteHit(player) {
  const sprite = document.querySelector(`#slot${player} .slot-sprite`);
  if (!sprite) return;
  sprite.classList.remove('idle');
  sprite.classList.remove('hit');
  void sprite.offsetWidth; // reset any in-progress animation
  sprite.classList.add('hit');
  setTimeout(() => {
    sprite.classList.remove('hit');
    if (sprite.getAttribute('src')) sprite.classList.add('idle');
  }, 270);
}

function playFlash(player, kind) {
  const flash = document.querySelector(`#slot${player} .slot-flash`);
  if (!flash) return;
  flash.classList.toggle('heal-pulse', kind === 'heal');
  cancelAnimations(flash);
  flash.animate(
    [{ opacity: 0 }, { opacity: 0.95, offset: 0.4 }, { opacity: 0 }],
    { duration: 230, easing: 'ease-out' }
  ).finished
    .then(() => flash.classList.remove('heal-pulse'))
    .catch(() => {});
}

function spawnFloatingNumber(player, text, kind) {
  const container = document.getElementById('hit-effects');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `hit-number ${kind}`;
  el.dataset.player = String(player);
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

// When an active Pokemon is retreated to bench or released, fade the sprite
// out and clear the slot. Uses the same per-slot animation queue so actions
// sequence correctly with any pending entrance/KO.
function queueSlotClear(player) { queueSlotAction(player, '__clear__'); }

async function clearSlot(player) {
  const slotEl = document.getElementById(`slot${player}`);
  const spriteEl = slotEl.querySelector('.slot-sprite');
  if (spriteEl.getAttribute('src')) {
    await fadeOutSprite(spriteEl);
  }
  // Nameplate reset handled by renderNameplate(player, null) via state diff.
}

// KO sequence: red flash, then sprite rotates backward + falls + fades.
// Sprite src is removed afterwards so the slot is visually empty. The
// nameplate stays (in .ko state) until the user promotes or releases.
async function playKOSequence(player) {
  const slotEl = document.getElementById(`slot${player}`);
  const sprite = slotEl.querySelector('.slot-sprite');
  const flash = slotEl.querySelector('.slot-flash');
  if (!sprite?.getAttribute('src')) return;

  // Clean any lingering idle/hit state
  cancelAnimations(sprite);
  cancelAnimations(flash);
  sprite.classList.remove('idle', 'hit');

  // Step 1: red flash (~150ms)
  flash.classList.add('ko-flash');
  try {
    await flash.animate(
      [{ opacity: 0 }, { opacity: 0.95, offset: 0.4 }, { opacity: 0.3 }, { opacity: 0 }],
      { duration: 160, easing: 'ease-out' }
    ).finished;
  } catch {}
  flash.classList.remove('ko-flash');

  // Step 2: fall + fade (~560ms, from CSS animation)
  void sprite.offsetWidth; // reset
  sprite.classList.add('ko');
  await new Promise(r => setTimeout(r, 580));

  // Final: clear sprite. Nameplate stays (in .ko state) until state changes.
  sprite.classList.remove('ko');
  sprite.removeAttribute('src');
  sprite.style.opacity = '';
  sprite.style.transform = '';
}

// Per-slot action queue. Any new action replaces the queued one (intermediate
// captures coalesce), and runs to completion before the next starts. Actions
// are encoded as: a pokemon name string (sprite update), '__clear__' (fade
// out + reset), or '__ko__' (KO animation).
function queueSlotAction(player, action) {
  const q = state.slotAnim[player];
  q.queued = action;
  if (q.running) return;

  (async () => {
    while (q.queued) {
      const next = q.queued;
      q.queued = null;
      q.running = true;
      try {
        if (next === '__clear__') await clearSlot(player);
        else if (next === '__ko__') await playKOSequence(player);
        else await updateSlot(player, next);
      } catch (e) {
        console.error(`[battlefield] slot ${player} action "${next}" failed`, e);
      } finally {
        q.running = false;
      }
    }
  })();
}

function queueSlotUpdate(player, pokemon) { queueSlotAction(player, pokemon); }
function queueSlotKO(player) { queueSlotAction(player, '__ko__'); }

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
  // Nameplate (name + HP bar) is managed by renderNameplate via state diff.
}

async function fadeOutSprite(spriteEl) {
  spriteEl.classList.remove('idle');
  cancelAnimations(spriteEl); // clear any lingering forward-filled animations
  await spriteEl.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 250, easing: 'ease-in', fill: 'forwards' }
  ).finished;
  spriteEl.removeAttribute('src');
  cancelAnimations(spriteEl);
  spriteEl.style.opacity = '';
}

function cancelAnimations(el) {
  // Forward-filled Web Animations keep their end state in the composition stack
  // even after completion, which overrides inline styles and subsequent
  // animations that don't set the same property. Cancel them for a clean slate.
  el.getAnimations().forEach(a => a.cancel());
}

async function playEntrance(slotEl, spriteUrl, pokeballUrl) {
  const pokeball = slotEl.querySelector('.slot-pokeball');
  const sprite = slotEl.querySelector('.slot-sprite');
  const flash = slotEl.querySelector('.slot-flash');

  // Clean slate — important on swaps where the previous entrance's filled
  // animations would otherwise override the new pokeball's starting state.
  cancelAnimations(pokeball);
  cancelAnimations(sprite);
  cancelAnimations(flash);

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
  // Cancel the forward-filled entrance animations so the idle CSS keyframes
  // have a clean transform slot to animate in.
  cancelAnimations(pokeball);
  cancelAnimations(sprite);
  cancelAnimations(flash);
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
  const linkEl = document.getElementById('open-capture');
  if (linkEl) linkEl.href = captureUrl.toString();
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
    s1.textContent = state.slots[1] ? 'Trainer 1 joined' : 'Waiting for Trainer 1…';
    s1.classList.toggle('filled', !!state.slots[1]);
  }
  if (!s2.classList.contains('filled') || !state.slots[2]) {
    s2.textContent = state.slots[2] ? 'Trainer 2 joined' : 'Waiting for Trainer 2…';
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
  handlePlayerStateBroadcast({
    payload: {
      player: 1,
      state: {
        trainerName: 'Ash',
        active: { name: 'pikachu', hp: 60, maxHp: 60 },
        bench: [null, null, null, null, null],
      },
    },
  });
  handlePlayerStateBroadcast({
    payload: {
      player: 2,
      state: {
        trainerName: 'Gary',
        active: { name: 'charizard', hp: 120, maxHp: 120 },
        bench: [null, null, null, null, null],
      },
    },
  });
}

// ---------- Voice relay (Left/Right Shift → broadcast to target phone) ----------
//
// Hold Left Shift to send a voice command to Trainer 1, Right Shift for Trainer 2.
// iPad handles speech-to-text; the transcript is broadcast to the target phone,
// which parses and executes it with its existing voice command pipeline.

function initVoiceRelay() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn('[voice-relay] SpeechRecognition unsupported; Shift keybinds disabled');
    return;
  }

  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 3;

  const indicator = buildVoiceIndicator();
  document.body.appendChild(indicator.root);

  let activePlayer = null;   // which player (1 or 2) is currently being listened for
  let listening = false;

  const setIndicator = (player, text, kind = 'idle') => {
    if (!player) { indicator.root.classList.remove('visible'); return; }
    indicator.root.classList.add('visible');
    indicator.root.classList.remove('ok', 'warn', 'error');
    if (kind && kind !== 'idle') indicator.root.classList.add(kind);
    indicator.label.textContent = `Trainer ${player} · ${player === 1 ? 'LShift' : 'RShift'}`;
    indicator.transcript.textContent = text || '';
  };

  const start = (player) => {
    if (listening) return;
    activePlayer = player;
    try {
      recognition.start();
      listening = true;
      setIndicator(player, 'Listening…', 'idle');
    } catch (err) {
      console.warn('[voice-relay] start failed:', err);
      activePlayer = null;
    }
  };

  const stop = () => {
    if (!listening) return;
    try { recognition.stop(); } catch {}
  };

  recognition.addEventListener('end', () => {
    listening = false;
    // Keep the final transcript visible briefly after release; then hide.
    setTimeout(() => { if (!listening) setIndicator(null); }, 1200);
    activePlayer = null;
  });
  recognition.addEventListener('error', (e) => {
    listening = false;
    const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Mic access denied'
      : e.error === 'no-speech' ? "Didn't catch that"
      : `Error: ${e.error}`;
    if (activePlayer) setIndicator(activePlayer, msg, 'error');
    setTimeout(() => setIndicator(null), 1800);
    activePlayer = null;
  });
  recognition.addEventListener('result', (event) => {
    const result = event.results[0];
    const transcript = (result && result[0] && result[0].transcript || '').trim();
    const player = activePlayer;
    if (!transcript || !player) return;
    setIndicator(player, `"${transcript}"`, 'ok');
    broadcastVoiceCommand(player, transcript);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift' || e.repeat) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    const player = e.location === 2 ? 2 : e.location === 1 ? 1 : null;
    if (!player) return;
    // If a different shift is already active, ignore the second press.
    if (listening && activePlayer && activePlayer !== player) return;
    e.preventDefault();
    start(player);
  });

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    const player = e.location === 2 ? 2 : e.location === 1 ? 1 : null;
    if (!player || player !== activePlayer) return;
    e.preventDefault();
    stop();
  });

  // If focus leaves the window while a shift is held, browsers stop firing keyup.
  window.addEventListener('blur', () => { if (listening) stop(); });

  console.log('[voice-relay] ready — hold Left/Right Shift to speak for Trainer 1/2');
}

async function broadcastVoiceCommand(player, transcript) {
  if (!state.channel) return;
  await state.channel.send({
    type: 'broadcast',
    event: 'voice_command',
    payload: { player, transcript },
  });
  console.log(`[voice-relay] → Trainer ${player}: "${transcript}"`);
}

function buildVoiceIndicator() {
  const root = document.createElement('div');
  root.id = 'voice-indicator';
  root.innerHTML = `
    <span class="mic">🎤</span>
    <span class="label"></span>
    <span class="transcript"></span>
  `;
  const style = document.createElement('style');
  style.textContent = `
    #voice-indicator {
      position: fixed; top: 12px; left: 50%; transform: translate(-50%, -16px);
      display: flex; align-items: center; gap: 10px;
      padding: 10px 18px;
      background: rgba(18, 18, 28, 0.88);
      border: 1px solid rgba(255, 100, 100, 0.55);
      border-radius: 999px;
      font: 600 14px -apple-system, BlinkMacSystemFont, sans-serif;
      color: white;
      box-shadow: 0 0 14px rgba(255, 60, 60, 0.35);
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.12s;
      z-index: 200;
      max-width: 80vw;
    }
    #voice-indicator.visible { opacity: 1; transform: translate(-50%, 0); }
    #voice-indicator .mic { font-size: 16px; animation: voice-rel-pulse 0.9s ease-in-out infinite; }
    #voice-indicator .label { font-size: 12px; opacity: 0.85; letter-spacing: 1px; text-transform: uppercase; }
    #voice-indicator .transcript { color: #ffcb05; }
    #voice-indicator.ok { border-color: rgba(140, 255, 160, 0.65); box-shadow: 0 0 14px rgba(80, 220, 120, 0.35); }
    #voice-indicator.ok .transcript { color: #a6ffb5; }
    #voice-indicator.error { border-color: rgba(255, 120, 120, 0.75); }
    #voice-indicator.error .transcript { color: #ff9e9e; }
    @keyframes voice-rel-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }
  `;
  document.head.appendChild(style);
  return {
    root,
    label: root.querySelector('.label'),
    transcript: root.querySelector('.transcript'),
  };
}

init();
