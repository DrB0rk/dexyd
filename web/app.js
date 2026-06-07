const state = {
  tokens: readJson('dexyd.web.tokens'),
  sessions: [],
  selectedSession: null,
  messages: [],
  queue: [],
  lastSequence: 0,
  socket: null,
  polling: null,
  projectPath: localStorage.getItem('dexyd.web.projectPath') || '/workspace',
};

const els = {
  bridgeStatus: id('bridgeStatus'),
  projectPath: id('projectPath'),
  loadProject: id('loadProject'),
  suggestions: id('suggestions'),
  newSession: id('newSession'),
  refreshSessions: id('refreshSessions'),
  sessions: id('sessions'),
  emptyState: id('emptyState'),
  chatView: id('chatView'),
  chatTitle: id('chatTitle'),
  chatMeta: id('chatMeta'),
  usagePill: id('usagePill'),
  cancelTurn: id('cancelTurn'),
  refreshChat: id('refreshChat'),
  queueBox: id('queueBox'),
  messages: id('messages'),
  composer: id('composer'),
  messageInput: id('messageInput'),
  sendButton: id('sendButton'),
  diffDialog: id('diffDialog'),
  diffText: id('diffText'),
  closeDiff: id('closeDiff'),
  toast: id('toast'),
};

init().catch(error => showError(error));

async function init() {
  els.projectPath.value = state.projectPath;
  bindUi();
  await ensureAuth();
  await Promise.all([refreshHealth(), refreshSessions()]);
  connectStream();
  setInterval(refreshHealth, 15000);
}

function bindUi() {
  els.loadProject.addEventListener('click', () => setProject(els.projectPath.value));
  els.projectPath.addEventListener('keydown', event => {
    if (event.key === 'Enter') setProject(els.projectPath.value);
  });
  els.projectPath.addEventListener('input', debounce(suggestProjects, 180));
  els.newSession.addEventListener('click', createSession);
  els.refreshSessions.addEventListener('click', refreshSessions);
  els.refreshChat.addEventListener('click', () => refreshChat());
  els.cancelTurn.addEventListener('click', cancelTurn);
  els.closeDiff.addEventListener('click', () => els.diffDialog.close());
  els.diffDialog.addEventListener('click', event => {
    const rect = els.diffDialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) els.diffDialog.close();
  });
  els.composer.addEventListener('submit', sendMessage);
  els.messageInput.addEventListener('input', () => {
    els.messageInput.style.height = 'auto';
    els.messageInput.style.height = `${Math.min(180, els.messageInput.scrollHeight)}px`;
  });
  document.addEventListener('click', event => {
    if (!els.suggestions.contains(event.target) && event.target !== els.projectPath) {
      els.suggestions.hidden = true;
    }
  });
}

async function ensureAuth() {
  if (state.tokens?.refreshToken) {
    try {
      state.tokens = await api('/auth/refresh', { method: 'POST', body: { refreshToken: state.tokens.refreshToken } }, false);
      saveTokens();
      return;
    } catch {
      state.tokens = null;
      localStorage.removeItem('dexyd.web.tokens');
    }
  }
  state.tokens = await api('/web/auth/bootstrap', { method: 'POST', body: {} }, false);
  saveTokens();
}

function saveTokens() {
  localStorage.setItem('dexyd.web.tokens', JSON.stringify(state.tokens));
}

async function api(path, options = {}, auth = true) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.tokens?.accessToken) headers.Authorization = `Bearer ${state.tokens.accessToken}`;
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401 && auth && state.tokens?.refreshToken) {
    state.tokens = await api('/auth/refresh', { method: 'POST', body: { refreshToken: state.tokens.refreshToken } }, false);
    saveTokens();
    return api(path, options, auth);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${detail || response.statusText}`);
  }
  return response.json();
}

async function refreshHealth() {
  try {
    const health = await api('/health/ready', {}, false);
    els.bridgeStatus.textContent = `${health.status} · ${health.version}`;
    els.bridgeStatus.style.color = health.status === 'ready' ? 'var(--ok)' : 'var(--warn)';
  } catch (error) {
    els.bridgeStatus.textContent = 'offline';
    els.bridgeStatus.style.color = 'var(--bad)';
  }
}

async function setProject(path) {
  state.projectPath = path.trim() || '/workspace';
  els.projectPath.value = state.projectPath;
  localStorage.setItem('dexyd.web.projectPath', state.projectPath);
  els.suggestions.hidden = true;
  await refreshSessions();
}

async function suggestProjects() {
  const value = els.projectPath.value.trim();
  if (!value) {
    els.suggestions.hidden = true;
    return;
  }
  try {
    const result = await api(`/projects/suggest?path=${encodeURIComponent(value)}`);
    els.suggestions.innerHTML = '';
    for (const suggestion of result.suggestions.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'suggestion';
      row.innerHTML = `<strong>${escapeHtml(suggestion.name)}</strong><span>${escapeHtml(suggestion.absolutePath)}</span>`;
      row.addEventListener('click', () => setProject(suggestion.absolutePath));
      els.suggestions.append(row);
    }
    els.suggestions.hidden = els.suggestions.childElementCount === 0;
  } catch {
    els.suggestions.hidden = true;
  }
}

async function refreshSessions() {
  const query = new URLSearchParams({ limit: '2000', workspacePath: state.projectPath });
  const result = await api(`/sessions?${query}`);
  state.sessions = result.sessions || [];
  renderSessions();
  if (state.selectedSession) {
    const fresh = state.sessions.find(s => s.id === state.selectedSession.id);
    if (fresh) state.selectedSession = fresh;
    renderChatHeader();
  }
}

function renderSessions() {
  els.sessions.innerHTML = '';
  if (!state.sessions.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No sessions in this project yet.';
    els.sessions.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.className = `session ${state.selectedSession?.id === session.id ? 'active' : ''}`;
    button.innerHTML = `
      <span class="session-title"><strong>${escapeHtml(session.title || shortId(session.id))}</strong><span class="status ${session.status}">${escapeHtml(session.status)}</span></span>
      <span class="session-path">${escapeHtml(session.workspacePath)}</span>
    `;
    button.addEventListener('click', () => openSession(session));
    els.sessions.append(button);
  }
}

async function createSession() {
  const result = await api('/sessions', {
    method: 'POST',
    body: { workspacePath: state.projectPath, profile: 'default', source: 'codex', title: basename(state.projectPath) || 'session' },
  });
  state.sessions.unshift(result.session);
  renderSessions();
  await openSession(result.session);
}

async function openSession(session) {
  state.selectedSession = session;
  state.messages = [];
  state.queue = [];
  els.emptyState.hidden = true;
  els.chatView.hidden = false;
  renderSessions();
  renderChatHeader();
  await Promise.all([refreshChat(false), refreshQueue(), refreshUsage()]);
  scrollBottom(false);
}

function renderChatHeader() {
  const session = state.selectedSession;
  if (!session) return;
  els.chatTitle.textContent = session.title || shortId(session.id);
  els.chatMeta.textContent = `${session.status} · ${session.workspacePath}`;
  els.cancelTurn.disabled = session.status !== 'running';
}

async function refreshChat(keepPosition = true) {
  if (!state.selectedSession) return;
  const wasNearBottom = nearBottom();
  const result = await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/chat?limit=300`);
  state.messages = normalizeMessages(result.messages || []);
  renderMessages();
  if (!keepPosition || wasNearBottom) scrollBottom(false);
}

function normalizeMessages(messages) {
  return messages
    .map(message => ({ ...message, content: normalizeContent(message.content || '', message.role) }))
    .filter(message => message.content.trim())
    .filter(message => !isRawPayload(message.content));
}

function renderMessages() {
  const existingScroll = els.messages.scrollTop;
  const wasNearBottom = nearBottom();
  els.messages.innerHTML = '';
  for (const message of state.messages) {
    const bubble = document.createElement('article');
    bubble.className = `message ${message.role} ${message.status || ''}`;
    bubble.textContent = message.content;
    if (message.role === 'assistant' && message.status !== 'running') {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const diff = document.createElement('button');
      diff.className = 'ghost';
      diff.type = 'button';
      diff.textContent = 'View diff';
      diff.addEventListener('click', () => showDiff(message.turnId));
      actions.append(diff);
      bubble.append(actions);
    }
    els.messages.append(bubble);
  }
  if (wasNearBottom) scrollBottom(false);
  else els.messages.scrollTop = existingScroll;
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.selectedSession) return;
  const text = els.messageInput.value.trim();
  if (!text) return;
  els.sendButton.disabled = true;
  els.messageInput.value = '';
  els.messageInput.style.height = 'auto';
  const optimistic = {
    id: `optimistic-${Date.now()}`,
    turnId: `optimistic-${Date.now()}`,
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
    sequence: Number.MAX_SAFE_INTEGER,
    status: 'sent',
  };
  state.messages = dedupe([...state.messages, optimistic]);
  renderMessages();
  scrollBottom(true);
  try {
    await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/chat`, { method: 'POST', body: { message: text } });
    setTimeout(() => refreshChat(), 400);
    setTimeout(() => refreshQueue(), 450);
  } catch (error) {
    showError(error);
    els.messageInput.value = text;
  } finally {
    els.sendButton.disabled = false;
    els.messageInput.focus();
  }
}

async function refreshQueue() {
  if (!state.selectedSession) return;
  const result = await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/queue`);
  state.queue = result.queue || [];
  renderQueue();
}

function renderQueue() {
  els.queueBox.innerHTML = '';
  els.queueBox.hidden = state.queue.length === 0;
  for (const queued of state.queue) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `<span>Queued: ${escapeHtml(queued.content)}</span>`;
    const steer = document.createElement('button');
    steer.className = 'ghost';
    steer.textContent = 'Steer';
    steer.addEventListener('click', async () => {
      const message = prompt('Steer queued message', queued.content);
      if (message?.trim()) {
        await api(`/sessions/${queued.sessionId}/queue/${queued.queueId}/steer`, { method: 'POST', body: { message } });
        await refreshQueue();
      }
    });
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await api(`/sessions/${queued.sessionId}/queue/${queued.queueId}`, { method: 'DELETE' });
      await refreshQueue();
    });
    row.append(steer, remove);
    els.queueBox.append(row);
  }
}

async function refreshUsage() {
  if (!state.selectedSession) return;
  try {
    const result = await api(`/usage/status?sessionId=${encodeURIComponent(state.selectedSession.id)}`);
    const context = result.usage?.context;
    const five = result.usage?.accountLimits?.fiveHour?.remainingPercent;
    const monthly = result.usage?.accountLimits?.monthly?.remainingPercent;
    const parts = [];
    if (typeof context?.percent === 'number') parts.push(`ctx ${Math.round(context.percent)}%`);
    if (typeof five === 'number') parts.push(`5h ${Math.round(five)}% left`);
    if (typeof monthly === 'number') parts.push(`mo ${Math.round(monthly)}% left`);
    els.usagePill.textContent = parts.join(' · ') || 'usage unknown';
  } catch {
    els.usagePill.textContent = 'usage unavailable';
  }
}

async function cancelTurn() {
  if (!state.selectedSession) return;
  await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/cancel`, { method: 'POST', body: {} });
  await refreshSessions();
  await refreshChat();
}

async function showDiff(turnId) {
  if (!state.selectedSession) return;
  const query = turnId ? `?turnId=${encodeURIComponent(turnId)}` : '';
  const result = await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/diff${query}`);
  els.diffText.textContent = result.diff || result.stat || 'No diff for this turn.';
  els.diffDialog.showModal();
}

function connectStream() {
  if (!state.tokens?.accessToken) return;
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsScheme}://${location.host}/ws?access_token=${encodeURIComponent(state.tokens.accessToken)}`;
  try {
    state.socket?.close();
    state.socket = new WebSocket(wsUrl);
    state.socket.onopen = () => {
      state.socket.send(JSON.stringify({ type: 'replay.request', lastSeenSequence: state.lastSequence }));
      stopPolling();
    };
    state.socket.onmessage = event => handleStreamMessage(event.data);
    state.socket.onclose = () => startPolling();
    state.socket.onerror = () => startPolling();
  } catch {
    startPolling();
  }
}

function handleStreamMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  const event = data.event || (typeof data.eventType === 'string' ? data : null);
  if (!event) return;
  state.lastSequence = Math.max(state.lastSequence, event.sequence || 0);
  if (event.sessionId && state.selectedSession?.id && event.sessionId !== state.selectedSession.id) {
    if (event.eventType.startsWith('session.')) refreshSessions().catch(showError);
    return;
  }
  if (event.eventType === 'chat.message.user' || event.eventType === 'chat.message.assistant') {
    const payload = event.payload || {};
    const role = event.eventType === 'chat.message.assistant' ? 'assistant' : 'user';
    const msg = {
      id: payload.id || String(event.sequence),
      turnId: payload.turnId || String(event.sequence),
      role,
      content: normalizeContent(payload.content || '', role),
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'sent',
    };
    if (msg.content && !isRawPayload(msg.content)) {
      state.messages = dedupe([...state.messages, msg]);
      renderMessages();
    }
  }
  if (event.eventType === 'chat.turn.started') {
    const turnId = event.payload?.turnId || String(event.sequence);
    state.messages = dedupe([...state.messages, {
      id: `running-${turnId}`,
      turnId,
      role: 'tool',
      content: 'Codex is working…',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'running',
    }]);
    renderMessages();
  }
  if (event.eventType === 'chat.turn.completed' || event.eventType === 'chat.turn.failed' || event.eventType === 'chat.turn.cancelled') {
    state.messages = state.messages.filter(m => !(m.turnId === event.payload?.turnId && m.status === 'running'));
    Promise.all([refreshSessions(), refreshChat(), refreshQueue(), refreshUsage()]).catch(showError);
  }
  if (event.eventType.startsWith('chat.message.queued')) refreshQueue().catch(showError);
  if (event.eventType.startsWith('session.')) refreshSessions().catch(showError);
}

function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(async () => {
    try {
      const result = await api(`/events/replay?lastSeenSequence=${state.lastSequence}`);
      for (const event of result.events || []) handleStreamMessage(JSON.stringify(event));
      state.lastSequence = Math.max(state.lastSequence, result.nextSequence || state.lastSequence);
    } catch {}
  }, 2500);
}
function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }

function normalizeContent(content, role) {
  let text = String(content || '').trim();
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '').trim();
  if (role === 'user') {
    const marker = /(?:^|\n)Latest user message:\s*\n/gi;
    let match, end = -1;
    while ((match = marker.exec(text))) end = match.index + match[0].length;
    if (end >= 0) text = text.slice(end).trim();
    if (/You are running inside dexyd as the assistant/i.test(text)) return '';
  }
  return text;
}
function isRawPayload(text) { return /^<hook_prompt\b[\s\S]*<\/hook_prompt>$/i.test(text.trim()); }
function dedupe(messages) {
  const byKey = new Map();
  for (const msg of messages) {
    const key = `${msg.role}|${msg.turnId}|${msg.content}`;
    if (!byKey.has(key) || (byKey.get(key).sequence || 0) < (msg.sequence || 0)) byKey.set(key, msg);
  }
  return [...byKey.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
function nearBottom() { return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120; }
function scrollBottom(animated) { els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: animated ? 'smooth' : 'auto' }); }
function basename(path) { return String(path).split('/').filter(Boolean).at(-1) || path; }
function shortId(id) { return String(id).slice(0, 8); }
function id(name) { return document.getElementById(name); }
function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function escapeHtml(value) { return String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function debounce(fn, ms) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }
function showError(error) { showToast(error instanceof Error ? error.message : String(error)); }
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}
