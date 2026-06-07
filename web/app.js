const DEFAULT_BRIDGE_ID = 'proxy';
const SETTINGS_PANES = ['connection', 'pairing', 'account', 'security', 'notifications', 'workspace', 'recovery', 'history', 'updates', 'diagnostics'];
const initialBridgeProfiles = loadBridgeProfiles();
const initialBridgeId = localStorage.getItem('dexyd.web.activeBridgeId') || initialBridgeProfiles[0]?.id || DEFAULT_BRIDGE_ID;

const state = {
  tokens: readTokensForBridge(initialBridgeId),
  bridgeProfiles: initialBridgeProfiles,
  activeBridgeId: initialBridgeId,
  sessions: [],
  hiddenSessions: [],
  selectedSession: null,
  messages: [],
  queue: [],
  commands: [],
  inbox: readJson('dexyd.web.inbox') || [],
  lastSequence: Number(localStorage.getItem('dexyd.web.lastSequence') || '0'),
  socket: null,
  polling: null,
  projectPath: localStorage.getItem('dexyd.web.projectPath') || defaultProjectPath(),
  health: null,
  account: null,
  activePage: 'sessionsPage',
  answerItem: null,
  settingsPane: localStorage.getItem('dexyd.web.settingsPane') || 'connection',
  devices: [],
  usageDetails: null,
  notificationSettings: readJson('dexyd.web.notificationSettings') || defaultNotificationSettings(),
  errorHistory: loadErrorHistory(),
  updateInfo: null,
  pairingResult: null,
};

const els = {
  bridgeStatus: id('bridgeStatus'),
  projectPath: id('projectPath'),
  upProject: id('upProject'),
  loadProject: id('loadProject'),
  suggestions: id('suggestions'),
  newSession: id('newSession'),
  refreshSessions: id('refreshSessions'),
  openSettings: id('openSettings'),
  settingsDialog: id('settingsDialog'),
  closeSettings: id('closeSettings'),
  sessions: id('sessions'),
  inboxBadge: id('inboxBadge'),
  inboxList: id('inboxList'),
  clearInbox: id('clearInbox'),
  systemSummary: id('systemSummary'),
  settingsMenu: id('settingsMenu'),
  settingsBody: id('settingsBody'),
  emptyState: id('emptyState'),
  chatView: id('chatView'),
  chatTitle: id('chatTitle'),
  chatMeta: id('chatMeta'),
  usagePill: id('usagePill'),
  deleteSession: id('deleteSession'),
  cancelTurn: id('cancelTurn'),
  refreshChat: id('refreshChat'),
  queueBox: id('queueBox'),
  commandBar: id('commandBar'),
  messages: id('messages'),
  composer: id('composer'),
  commandButton: id('commandButton'),
  messageInput: id('messageInput'),
  sendButton: id('sendButton'),
  diffDialog: id('diffDialog'),
  diffText: id('diffText'),
  closeDiff: id('closeDiff'),
  answerDialog: id('answerDialog'),
  answerTitle: id('answerTitle'),
  answerPrompt: id('answerPrompt'),
  answerOptions: id('answerOptions'),
  answerText: id('answerText'),
  submitAnswer: id('submitAnswer'),
  toast: id('toast'),
};

init().catch(error => showError(error));

async function init() {
  els.projectPath.value = state.projectPath;
  bindUi();
  restoreDraft();
  renderInbox();
  renderSettings();
  await ensureAuth().catch(error => recordError('warn', 'Web auth unavailable', errorMessage(error)));
  await Promise.allSettled([refreshHealth(), refreshSessions(), refreshAccount(), refreshCommands(), refreshDevices(), refreshUsage()]);
  connectStream();
  setInterval(refreshHealth, 15000);
  setInterval(refreshAccount, 60000);
  setInterval(() => refreshSessions({ background: true }).catch(() => {}), 30000);
}

function bindUi() {
  document.querySelectorAll('.tab[data-page]').forEach(button => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });
  els.openSettings.addEventListener('click', openSettingsDialog);
  els.closeSettings.addEventListener('click', () => els.settingsDialog.close());
  els.loadProject.addEventListener('click', () => setProject(els.projectPath.value));
  els.upProject.addEventListener('click', () => goUpProject().catch(showError));
  els.projectPath.addEventListener('keydown', event => {
    if (event.key === 'Enter') setProject(els.projectPath.value);
    if (event.key === 'Escape') els.suggestions.hidden = true;
  });
  els.projectPath.addEventListener('input', debounce(suggestProjects, 160));
  els.projectPath.addEventListener('focus', debounce(suggestProjects, 60));
  els.newSession.addEventListener('click', createSession);
  els.refreshSessions.addEventListener('click', () => refreshSessions());
  els.refreshChat.addEventListener('click', () => refreshChat({ keepPosition: true }));
  els.cancelTurn.addEventListener('click', cancelTurn);
  els.deleteSession.addEventListener('click', hideSession);
  els.commandButton.addEventListener('click', toggleCommandBar);
  els.clearInbox.addEventListener('click', clearInbox);
  els.closeDiff.addEventListener('click', () => els.diffDialog.close());
  els.settingsDialog.addEventListener('click', event => closeDialogOnBackdrop(event, els.settingsDialog));
  els.diffDialog.addEventListener('click', event => closeDialogOnBackdrop(event, els.diffDialog));
  els.answerDialog.addEventListener('click', event => closeDialogOnBackdrop(event, els.answerDialog));
  els.submitAnswer.addEventListener('click', event => {
    event.preventDefault();
    submitInteractionAnswer().catch(showError);
  });
  els.composer.addEventListener('submit', sendMessage);
  els.messageInput.addEventListener('input', () => {
    autosizeInput();
    saveDraft();
  });
  els.messageInput.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendMessage(event);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      els.commandBar.hidden = true;
      els.suggestions.hidden = true;
    }
  });
  document.addEventListener('click', event => {
    if (!els.suggestions.contains(event.target) && event.target !== els.projectPath) els.suggestions.hidden = true;
    if (!els.commandBar.contains(event.target) && event.target !== els.commandButton) els.commandBar.hidden = true;
  });
}

function setPage(page) {
  state.activePage = page;
  document.querySelectorAll('.tab[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  document.querySelectorAll('.panel-page').forEach(section => section.classList.toggle('active', section.id === page));
}

function openSettingsDialog() {
  Promise.allSettled([refreshHealth(), refreshAccount(), state.selectedSession ? refreshUsage() : Promise.resolve()]).finally(renderSettings);
  renderSettings();
  els.settingsDialog.showModal();
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
  if (!state.activeBridgeId) return;
  localStorage.setItem(tokenKey(state.activeBridgeId), JSON.stringify(state.tokens));
  localStorage.setItem('dexyd.web.tokens', JSON.stringify(state.tokens));
}

async function api(path, options = {}, auth = true) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.tokens?.accessToken) headers.Authorization = `Bearer ${state.tokens.accessToken}`;
  const response = await fetch(apiUrl(path, options.baseUrl), {
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
    throw apiError(response, detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function refreshHealth() {
  try {
    state.health = await api('/health/ready', {}, false);
    els.bridgeStatus.textContent = `${state.health.status} · ${state.health.version}`;
    els.bridgeStatus.style.color = state.health.status === 'ready' ? 'var(--ok)' : 'var(--warn)';
  } catch {
    state.health = null;
    els.bridgeStatus.textContent = 'offline';
    els.bridgeStatus.style.color = 'var(--bad)';
  }
  renderSettings();
  renderSystemSummary();
}

async function refreshAccount() {
  try { state.account = await api('/codex-auth/status'); }
  catch { state.account = null; }
  renderSettings();
  renderSystemSummary();
}

async function refreshCommands() {
  try {
    const result = await api('/commands');
    state.commands = result.commands || [];
    renderCommandBar();
  } catch { state.commands = []; }
}

async function setProject(path) {
  state.projectPath = normalizeProjectPath(path);
  els.projectPath.value = state.projectPath;
  localStorage.setItem('dexyd.web.projectPath', state.projectPath);
  els.suggestions.hidden = true;
  await refreshSessions();
}

async function goUpProject() {
  const current = els.projectPath.value.trim() || state.projectPath || defaultProjectPath();
  try {
    const result = await api(`/projects?path=${encodeURIComponent(current)}`);
    await setProject(result.parentPath || result.currentPath || parentPath(current));
  } catch {
    await setProject(parentPath(current));
  }
}

async function suggestProjects() {
  const value = els.projectPath.value.trim();
  try {
    const result = await api(`/projects/suggest?path=${encodeURIComponent(value)}`);
    els.suggestions.replaceChildren();
    for (const suggestion of (result.suggestions || []).slice(0, 10)) {
      const row = document.createElement('button');
      row.type = 'button';
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

async function refreshSessions(options = {}) {
  const query = new URLSearchParams({ limit: '2000' });
  if (state.projectPath) query.set('workspacePath', state.projectPath);
  const result = await api(`/sessions?${query}`);
  state.sessions = (result.sessions || []).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  renderSessions();
  if (state.selectedSession) {
    const fresh = state.sessions.find(s => s.id === state.selectedSession.id);
    if (fresh) state.selectedSession = fresh;
    renderChatHeader();
  }
  if (!options.background) renderSystemSummary();
}

function renderSessions() {
  els.sessions.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-list';
    empty.textContent = 'No sessions in this project yet.';
    els.sessions.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.className = `session ${state.selectedSession?.id === session.id ? 'active' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="session-main"><strong>${escapeHtml(session.title || shortId(session.id))}</strong><span class="status ${escapeHtml(session.status)}">${statusLabel(session.status)}</span></span>
      <span class="session-sub">${escapeHtml(relativeProject(session.workspacePath))} · ${formatTime(session.updatedAt)}</span>
    `;
    button.addEventListener('click', () => openSession(session));
    els.sessions.append(button);
  }
}

async function createSession() {
  if (!state.projectPath) {
    showToast('Choose a project path first');
    els.projectPath.focus();
    return;
  }
  const result = await api('/sessions', {
    method: 'POST',
    body: { workspacePath: state.projectPath, profile: 'default', source: 'codex', title: basename(state.projectPath) || 'session' },
  });
  state.sessions.unshift(result.session);
  renderSessions();
  await openSession(result.session);
}

async function openSession(session) {
  if (state.selectedSession?.id) saveDraft();
  state.selectedSession = session;
  state.messages = readJson(cacheKey(session.id, 'messages')) || [];
  state.queue = [];
  els.emptyState.hidden = true;
  els.chatView.hidden = false;
  renderSessions();
  renderChatHeader();
  restoreDraft();
  renderMessages();
  await Promise.allSettled([refreshChat({ keepPosition: false }), refreshQueue(), refreshUsage(), refreshCommands()]);
  scrollBottom(false);
}

function renderChatHeader() {
  const session = state.selectedSession;
  if (!session) return;
  els.chatTitle.textContent = session.title || shortId(session.id);
  els.chatMeta.textContent = `${statusLabel(session.status)} · ${session.workspacePath}`;
  els.cancelTurn.disabled = session.status !== 'running';
}

async function refreshChat({ keepPosition = true } = {}) {
  if (!state.selectedSession) return;
  const wasNearBottom = nearBottom();
  const result = await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/chat?limit=500`);
  state.messages = dedupe(normalizeMessages(result.messages || []));
  localStorage.setItem(cacheKey(state.selectedSession.id, 'messages'), JSON.stringify(state.messages.slice(-500)));
  renderMessages();
  if (!keepPosition || wasNearBottom) scrollBottom(false);
}

function normalizeMessages(messages) {
  return messages
    .map(message => ({ ...message, content: normalizeContent(message.content || '', message.role), createdAt: message.createdAt || message.timestamp || new Date().toISOString() }))
    .filter(message => message.content.trim())
    .filter(message => !isRawPayload(message.content));
}

function renderMessages() {
  const existingScroll = els.messages.scrollTop;
  const wasNearBottom = nearBottom();
  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const bubble = document.createElement('article');
    bubble.className = `message ${message.role} ${message.status || ''}`;
    bubble.tabIndex = 0;
    bubble.textContent = message.content;
    if (message.role === 'assistant' && message.status !== 'running') {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      actions.append(actionButton('Copy', () => copyText(message.content)));
      actions.append(actionButton('View diff', () => showDiff(message.turnId)));
      bubble.append(actions);
    } else if (message.role === 'user') {
      const actions = document.createElement('div');
      actions.className = 'message-actions compact';
      actions.append(actionButton('Copy', () => copyText(message.content)));
      bubble.append(actions);
    }
    fragment.append(bubble);
  }
  els.messages.replaceChildren(fragment);
  if (wasNearBottom) scrollBottom(false);
  else els.messages.scrollTop = existingScroll;
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.selectedSession) return;
  const text = els.messageInput.value.trim();
  if (!text) return;
  const optimistic = {
    id: `optimistic-${crypto.randomUUID?.() || Date.now()}`,
    turnId: `pending-${Date.now()}`,
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
    sequence: Number.MAX_SAFE_INTEGER,
    status: 'sent',
  };
  els.sendButton.disabled = true;
  els.messageInput.value = '';
  saveDraft('');
  autosizeInput();
  state.messages = dedupe([...state.messages, optimistic]);
  renderMessages();
  scrollBottom(true);
  try {
    await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/chat`, { method: 'POST', body: { message: text } });
    refreshQueue().catch(() => {});
    setTimeout(() => refreshChat({ keepPosition: true }).catch(() => {}), 500);
  } catch (error) {
    showError(error);
    els.messageInput.value = text;
    saveDraft();
    autosizeInput();
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
  els.queueBox.replaceChildren();
  els.queueBox.hidden = state.queue.length === 0;
  if (!state.queue.length) return;
  const title = document.createElement('strong');
  title.textContent = `${state.queue.length} queued message${state.queue.length === 1 ? '' : 's'}`;
  els.queueBox.append(title);
  for (const queued of state.queue) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const text = document.createElement('span');
    text.textContent = queued.content;
    row.append(text);
    row.append(actionButton('Steer', async () => {
      const message = prompt('Steer queued message', queued.content);
      if (message?.trim()) {
        await api(`/sessions/${queued.sessionId}/queue/${queued.queueId}/steer`, { method: 'POST', body: { message } });
        await refreshQueue();
      }
    }));
    row.append(actionButton('Remove', async () => {
      await api(`/sessions/${queued.sessionId}/queue/${queued.queueId}`, { method: 'DELETE' });
      await refreshQueue();
    }));
    els.queueBox.append(row);
  }
}

async function refreshUsage() {
  if (!state.selectedSession) {
    state.usageDetails = null;
    els.usagePill.textContent = 'usage unknown';
    renderSettings();
    return;
  }
  try {
    const result = await api(`/usage/status?sessionId=${encodeURIComponent(state.selectedSession.id)}`);
    state.usageDetails = result.usage || null;
    const context = result.usage?.context;
    const five = result.usage?.accountLimits?.fiveHour?.remainingPercent;
    const monthly = result.usage?.accountLimits?.monthly?.remainingPercent;
    const parts = [];
    if (typeof context?.percent === 'number') parts.push(`ctx ${Math.round(context.percent)}%`);
    if (typeof five === 'number') parts.push(`5h ${Math.round(five)}% left`);
    if (typeof monthly === 'number') parts.push(`mo ${Math.round(monthly)}% left`);
    els.usagePill.textContent = parts.join(' · ') || 'usage unknown';
  } catch (error) {
    state.usageDetails = null;
    els.usagePill.textContent = isBridgeUnavailableError(error) ? 'bridge offline' : 'usage unavailable';
    if (!isBridgeUnavailableError(error)) recordError('warn', 'Usage unavailable', errorMessage(error));
  }
  renderSettings();
}

async function refreshDevices() {
  try {
    const result = await api('/devices');
    state.devices = result.devices || [];
  } catch (error) {
    state.devices = [];
    if (!isBridgeUnavailableError(error)) recordError('warn', 'Devices unavailable', errorMessage(error));
  }
  renderSettings();
}


async function cancelTurn() {
  if (!state.selectedSession) return;
  await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}/cancel`, { method: 'POST', body: {} });
  await Promise.allSettled([refreshSessions(), refreshChat(), refreshQueue()]);
}

async function hideSession() {
  if (!state.selectedSession) return;
  if (!confirm('Hide this session from Dexyd? You can restore hidden sessions from Settings.')) return;
  await api(`/sessions/${encodeURIComponent(state.selectedSession.id)}`, { method: 'DELETE' });
  state.selectedSession = null;
  state.messages = [];
  els.chatView.hidden = true;
  els.emptyState.hidden = false;
  await refreshSessions();
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
  const wsUrl = websocketUrl('/ws', state.tokens.accessToken);
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
  localStorage.setItem('dexyd.web.lastSequence', String(state.lastSequence));

  if (event.eventType?.startsWith('interaction.')) captureInteraction(event);

  if (event.sessionId && state.selectedSession?.id && event.sessionId !== state.selectedSession.id) {
    if (event.eventType.startsWith('session.') || event.eventType.startsWith('chat.')) refreshSessions({ background: true }).catch(() => {});
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
      if (nearBottom()) scrollBottom(false);
    }
  }
  if (event.eventType === 'chat.turn.started') {
    const turnId = event.payload?.turnId || String(event.sequence);
    state.messages = dedupe([...state.messages, {
      id: `running-${turnId}`,
      turnId,
      role: 'tool',
      content: summarizeAction(event.payload) || 'Codex is working…',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'running',
    }]);
    renderMessages();
  }
  if (event.eventType === 'chat.turn.completed' || event.eventType === 'chat.turn.failed' || event.eventType === 'chat.turn.cancelled') {
    state.messages = state.messages.filter(m => !(m.turnId === event.payload?.turnId && m.status === 'running'));
    if (event.eventType === 'chat.turn.completed') addInboxNotice('Prompt finished', event.sessionId, 'prompt.finished', event.sequence);
    Promise.allSettled([refreshSessions({ background: true }), refreshChat(), refreshQueue(), refreshUsage()]);
  }
  if (event.eventType.startsWith('chat.message.queued')) refreshQueue().catch(() => {});
  if (event.eventType.startsWith('session.')) refreshSessions({ background: true }).catch(() => {});
}

function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(async () => {
    try {
      const result = await api(`/events/replay?lastSeenSequence=${state.lastSequence}`);
      for (const event of result.events || []) handleStreamMessage(JSON.stringify(event));
      state.lastSequence = Math.max(state.lastSequence, result.nextSequence || state.lastSequence);
      localStorage.setItem('dexyd.web.lastSequence', String(state.lastSequence));
    } catch {}
  }, 2500);
}
function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }

function captureInteraction(event) {
  const type = String(event.eventType || '').toLowerCase();
  const isApproval = type.includes('approval') && !type.includes('responded') && !type.includes('answered');
  const isQuestion = type.includes('question') && !type.includes('responded') && !type.includes('answered');
  if (!isApproval && !isQuestion) return;
  const payload = event.payload || {};
  const item = {
    id: payload.interactionId || event.payload?.id || `${event.eventType}-${event.sequence}`,
    kind: isApproval ? 'approval' : 'question',
    title: isApproval ? 'Approval request' : 'Question',
    prompt: payload.prompt || payload.message || payload.question || payload.content || 'Agent needs input.',
    options: payload.options || payload.choices || [],
    sessionId: event.sessionId || payload.sessionId || null,
    createdAt: event.timestamp,
    sequence: event.sequence,
    status: 'open',
  };
  upsertInbox(item);
}

function addInboxNotice(title, sessionId, kind, sequence) {
  upsertInbox({ id: `${kind}-${sequence}`, kind, title, prompt: sessionId ? `Session ${shortId(sessionId)}` : '', sessionId, createdAt: new Date().toISOString(), sequence, status: 'notice' });
}

function upsertInbox(item) {
  const existing = state.inbox.filter(entry => entry.id !== item.id);
  state.inbox = [item, ...existing].slice(0, 80);
  localStorage.setItem('dexyd.web.inbox', JSON.stringify(state.inbox));
  renderInbox();
}

function renderInbox() {
  const open = state.inbox.filter(item => item.status !== 'resolved');
  els.inboxBadge.hidden = open.length === 0;
  els.inboxBadge.textContent = String(open.length);
  els.inboxList.replaceChildren();
  if (!open.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-list';
    empty.textContent = 'No pending approvals, questions, or updates.';
    els.inboxList.append(empty);
  }
  for (const item of open) {
    const row = document.createElement('article');
    row.className = `inbox-item ${item.kind}`;
    row.innerHTML = `<strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.prompt || '')}</p><span>${formatTime(item.createdAt)}</span>`;
    const actions = document.createElement('div');
    actions.className = 'inbox-actions';
    if (item.sessionId) actions.append(actionButton('Open', () => openSessionFromId(item.sessionId)));
    if (item.kind === 'approval' || item.kind === 'question') actions.append(actionButton('Respond', () => openAnswerDialog(item)));
    actions.append(actionButton('Done', () => resolveInbox(item.id)));
    row.append(actions);
    els.inboxList.append(row);
  }
  renderSystemSummary();
}

function clearInbox() {
  state.inbox = state.inbox.filter(item => item.status === 'open' && (item.kind === 'approval' || item.kind === 'question'));
  localStorage.setItem('dexyd.web.inbox', JSON.stringify(state.inbox));
  renderInbox();
}

function resolveInbox(id) {
  state.inbox = state.inbox.map(item => item.id === id ? { ...item, status: 'resolved' } : item);
  localStorage.setItem('dexyd.web.inbox', JSON.stringify(state.inbox));
  renderInbox();
}

function openAnswerDialog(item) {
  state.answerItem = item;
  els.answerTitle.textContent = item.title;
  els.answerPrompt.textContent = item.prompt || '';
  els.answerText.value = '';
  els.answerText.placeholder = item.kind === 'approval' ? 'Optional note' : 'Type your answer';
  els.answerOptions.replaceChildren();
  if (item.kind === 'approval') {
    els.answerOptions.append(actionButton('Approve', () => { els.answerText.value = 'approved'; }));
    els.answerOptions.append(actionButton('Deny', () => { els.answerText.value = 'denied'; }));
  }
  for (const option of item.options || []) {
    const label = typeof option === 'string' ? option : option.label || option.value || JSON.stringify(option);
    els.answerOptions.append(actionButton(label, () => { els.answerText.value = label; }));
  }
  els.answerDialog.showModal();
}

async function submitInteractionAnswer() {
  const item = state.answerItem;
  if (!item) return;
  const response = els.answerText.value.trim();
  if (!response) return;
  const body = item.kind === 'approval'
    ? { kind: 'approval', sessionId: item.sessionId || undefined, decision: response.toLowerCase().startsWith('deny') ? 'denied' : 'approved', note: response }
    : { kind: 'question', sessionId: item.sessionId || undefined, answer: response };
  await api(`/interactions/${encodeURIComponent(item.id)}/respond`, { method: 'POST', body });
  resolveInbox(item.id);
  els.answerDialog.close();
  showToast('Response sent');
}

async function openSessionFromId(sessionId) {
  const result = await api(`/sessions/${encodeURIComponent(sessionId)}`);
  await openSession(result.session || result);
}

function renderSystemSummary() {
  const open = state.inbox.filter(item => item.status !== 'resolved').length;
  const running = state.sessions.filter(session => session.status === 'running').length;
  const bits = [
    `Bridge: ${state.health?.status || 'unknown'}`,
    `Sessions: ${state.sessions.length}`,
    `Running: ${running}`,
    `Inbox: ${open}`,
  ];
  els.systemSummary.textContent = bits.join(' · ');
}

function renderSettings() {
  if (!els.settingsMenu || !els.settingsBody) return;
  const panes = settingsPanes();
  if (!panes.some(pane => pane.key === state.settingsPane)) state.settingsPane = 'connection';
  els.settingsMenu.replaceChildren(...panes.map(renderSettingsMenuButton));
  const pane = panes.find(item => item.key === state.settingsPane) || panes[0];
  els.settingsBody.replaceChildren(renderSettingsPane(pane.key));
}

function renderSettingsMenuButton(pane) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `settings-menu-item ${pane.key === state.settingsPane ? 'active' : ''} ${pane.attention ? 'attention' : ''}`;
  button.innerHTML = `<span class="settings-icon">${escapeHtml(pane.icon)}</span><span><strong>${escapeHtml(pane.title)}</strong><small>${escapeHtml(pane.detail)}</small></span>`;
  button.addEventListener('click', () => {
    state.settingsPane = pane.key;
    localStorage.setItem('dexyd.web.settingsPane', pane.key);
    renderSettings();
    refreshSettingsPaneData(pane.key).catch(error => {
      if (!isBridgeUnavailableError(error)) showError(error);
    });
  });
  return button;
}

function settingsPanes() {
  const active = activeBridgeProfile();
  const realtime = state.socket?.readyState === WebSocket.OPEN ? 'connected' : state.polling ? 'polling' : 'connecting';
  const usageWarn = state.usageDetails?.limits?.status === 'warn' || state.usageDetails?.limits?.status === 'error';
  return [
    { key: 'connection', icon: '⌁', title: 'Computers', detail: active.label || active.url || 'proxy', attention: !state.health },
    { key: 'pairing', icon: '◇', title: 'Pairing', detail: state.tokens ? 'paired' : 'pair required', attention: !state.tokens },
    { key: 'account', icon: '%', title: 'Account & usage', detail: accountLabel(), attention: usageWarn || state.account?.codexAuth?.installed === false },
    { key: 'security', icon: '◈', title: 'Security', detail: `${state.devices.length} device${state.devices.length === 1 ? '' : 's'}`, attention: false },
    { key: 'notifications', icon: '◌', title: 'Notifications', detail: notificationsSupported() ? Notification.permission : 'browser only', attention: notificationsSupported() && state.notificationSettings.system && Notification.permission !== 'granted' },
    { key: 'workspace', icon: '▦', title: 'Workspace', detail: `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}`, attention: false },
    { key: 'recovery', icon: '↺', title: 'Deleted sessions', detail: `${state.hiddenSessions.length} hidden`, attention: state.hiddenSessions.length > 0 },
    { key: 'history', icon: '!', title: 'Error history', detail: `${state.errorHistory.length} event${state.errorHistory.length === 1 ? '' : 's'}`, attention: state.errorHistory.length > 0 },
    { key: 'updates', icon: '⇧', title: 'Updates', detail: state.updateInfo?.updateAvailable ? `new ${state.updateInfo.latestVersion}` : 'GitHub releases', attention: Boolean(state.updateInfo?.updateAvailable) },
    { key: 'diagnostics', icon: '⌬', title: 'Diagnostics', detail: realtime, attention: !state.health },
  ];
}

function renderSettingsPane(key) {
  switch (key) {
    case 'connection': return connectionPane();
    case 'pairing': return pairingPane();
    case 'account': return accountPane();
    case 'security': return securityPane();
    case 'notifications': return notificationsPane();
    case 'workspace': return workspacePane();
    case 'recovery': return recoveryPane();
    case 'history': return historyPane();
    case 'updates': return updatesPane();
    case 'diagnostics': return diagnosticsPane();
    default: return connectionPane();
  }
}

function paneShell(title, subtitle, children = []) {
  const section = document.createElement('section');
  section.className = 'settings-pane';
  section.append(el('div', 'settings-pane-head', `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p>`));
  for (const child of children) section.append(child);
  return section;
}

function connectionPane() {
  const active = activeBridgeProfile();
  const label = inputRow('Computer label', active.label || 'Local bridge', 'bridgeLabelInput');
  const url = inputRow('Bridge URL', active.url || '', 'bridgeUrlInput', 'Leave empty to use this web proxy');
  const actions = actionRow([
    button('Save computer', async () => saveBridgeProfile(label.input.value, url.input.value), 'primary'),
    button('Check bridge', refreshHealth),
    button('Reset web auth', resetWebAuth, 'danger'),
  ]);
  const list = el('div', 'bridge-list');
  for (const profile of state.bridgeProfiles) {
    const row = el('div', 'bridge-profile');
    row.innerHTML = `<span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.url || 'this web proxy')}</small></span>`;
    row.append(actionRow([
      button(profile.id === state.activeBridgeId ? 'Active' : 'Switch', () => switchBridge(profile.id), profile.id === state.activeBridgeId ? '' : 'primary'),
      ...(profile.id === DEFAULT_BRIDGE_ID ? [] : [button('Remove', () => removeBridge(profile.id), 'danger')]),
    ]));
    list.append(row);
  }
  return paneShell('Computers & connection', 'Pair and switch between separate Dexyd bridge computers.', [statusGrid({ Bridge: bridgeLabel(), Realtime: realtimeLabel(), Active: active.label, URL: active.url || location.origin }), label.row, url.row, actions, list, hint('Use an empty URL for the Docker/Portainer web proxy. Use a full http(s) URL for a direct bridge. Direct cross-origin bridges may need Caddy to serve this web UI on the same origin.')]);
}

function pairingPane() {
  const uri = textareaRow('Pairing URI', 'pairingUriInput', 'Paste dexyd://pair?... from the TUI QR screen');
  const device = inputRow('Device label', 'dexyd web', 'pairDeviceLabel');
  const manualUrl = inputRow('Fallback bridge URL', activeBridgeProfile().url || '', 'pairBridgeUrl', 'Optional, used if the URI cannot be decoded');
  const result = state.pairingResult ? pairingResultView(state.pairingResult) : hint('Paste a pairing URI to add/switch to that bridge, or generate a pairing URI on the active bridge for another device.');
  return paneShell('Pairing', 'Connect this browser to a bridge or generate a pairing URI from the active bridge.', [uri.row, device.row, manualUrl.row, actionRow([button('Pair pasted URI', () => pairPastedUri(uri.input.value, device.input.value, manualUrl.input.value), 'primary'), button('Generate pairing URI', startPairing)]), result]);
}

function accountPane() {
  const auth = state.account?.codexAuth || state.account || {};
  const usage = state.usageDetails;
  return paneShell('Account & usage', 'Codex identity and per-session/account usage state.', [statusGrid({ Status: auth.installed === false ? 'codex-auth unavailable' : 'available', Account: auth.activeAccount?.label || auth.activeAccount?.email || auth.account || 'unknown', Details: auth.message || auth.status || 'not reported', Context: usage?.context?.percent != null ? `${Math.round(usage.context.percent)}%` : 'select a session', '5h limit': percentText(usage?.accountLimits?.fiveHour?.remainingPercent), Monthly: percentText(usage?.accountLimits?.monthly?.remainingPercent) }), actionRow([button('Refresh account', refreshAccount, 'primary'), button('Refresh usage', refreshUsage)]), accountList(auth)]);
}

function securityPane() {
  return paneShell('Security', 'Local web credentials and trusted bridge devices.', [statusGrid({ 'Device ID': state.tokens?.deviceId ? shortId(state.tokens.deviceId) : 'none', 'Access token': state.tokens?.accessExpiresAt ? `expires ${formatTime(state.tokens.accessExpiresAt)}` : 'none', 'Refresh token': state.tokens?.refreshExpiresAt ? `expires ${formatTime(state.tokens.refreshExpiresAt)}` : 'none' }), actionRow([button('Refresh token', () => ensureAuth().then(refreshHealth), 'primary'), button('Sign out this browser', signOut, 'danger'), button('Reload devices', refreshDevices)]), devicesList()]);
}

function notificationsPane() {
  return paneShell('Notifications', 'Browser notifications and in-app event behavior.', [statusGrid({ Browser: notificationsSupported() ? Notification.permission : 'not supported', 'In-app': state.notificationSettings.inApp ? 'on' : 'off', System: state.notificationSettings.system ? 'on' : 'off' }), toggleRow('In-app banners', 'inApp'), toggleRow('Browser notifications', 'system'), toggleRow('Prompt finished', 'promptFinished'), toggleRow('Approvals', 'approvals'), toggleRow('Questions', 'questions'), toggleRow('Usage limits', 'usage'), actionRow([button('Allow browser notifications', requestNotificationPermission, 'primary'), button('Test notification', () => notify('Dexyd test', 'Notifications are working.'))])]);
}

function workspacePane() {
  return paneShell('Workspace', 'Project and session overview from the selected bridge.', [statusGrid({ Project: state.projectPath || '~', Sessions: String(state.sessions.length), Running: String(state.sessions.filter(s => s.status === 'running').length), Commands: String(state.commands.length || fallbackCommands().length) }), actionRow([button('Refresh sessions', refreshSessions, 'primary'), button('Refresh commands', refreshCommands), button('Open project', () => setPage('sessionsPage'))])]);
}

function recoveryPane() {
  const list = el('div', 'hidden-sessions');
  if (!state.hiddenSessions.length) list.append(hint('No hidden sessions.'));
  for (const item of state.hiddenSessions) {
    const session = item.session || item;
    const row = el('div', 'hidden-item');
    row.innerHTML = `<span><strong>${escapeHtml(session.title || shortId(item.id))}</strong><small>${escapeHtml(session.workspacePath || (item.hiddenAt ? `hidden ${formatTime(item.hiddenAt)}` : ''))}</small></span>`;
    row.append(button('Restore', async () => { await api(`/sessions/${encodeURIComponent(item.id)}/restore`, { method: 'POST', body: {} }); await Promise.all([loadHiddenSessions(), refreshSessions()]); }, 'primary'));
    list.append(row);
  }
  return paneShell('Deleted sessions', 'Restore sessions hidden from Dexyd. Project files are never changed.', [actionRow([button('Refresh hidden sessions', loadHiddenSessions, 'primary')]), list]);
}

function historyPane() {
  const list = el('div', 'history-list');
  if (!state.errorHistory.length) list.append(hint('No warnings or errors recorded.'));
  for (const item of state.errorHistory) {
    list.append(el('article', `history-item ${item.level}`, `<strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><span>${escapeHtml(formatTime(item.timestamp))}</span>`));
  }
  return paneShell('Error history', 'Recent warnings without repeated popups.', [actionRow([button('Clear history', clearErrorHistory, 'danger')]), list]);
}

function updatesPane() {
  return paneShell('Updates', 'Check GitHub releases. The web container is updated from Portainer or docker compose.', [statusGrid({ Current: state.health?.version || 'unknown', Latest: state.updateInfo?.latestVersion || 'not checked', Status: state.updateInfo?.updateAvailable ? 'update available' : state.updateInfo ? 'up to date' : 'not checked' }), actionRow([button('Check releases', checkUpdates, 'primary'), button('Open releases', () => window.open('https://github.com/DrB0rk/dexyd/releases/latest', '_blank'))]), hint('For Docker/Portainer: pull the branch/image and redeploy the stack. Android APK updates are only available inside the Android app.')]);
}

function diagnosticsPane() {
  return paneShell('Diagnostics', 'Connection state useful when bridge, pairing, or realtime fails.', [statusGrid({ Origin: location.origin, 'API base': activeBridgeProfile().url || 'same origin proxy', WebSocket: websocketUrl('/ws', 'token').replace(/access_token=.*/, 'access_token=…'), 'Last event': String(state.lastSequence || 0), Polling: state.polling ? 'on' : 'off' }), actionRow([button('Reconnect realtime', connectStream, 'primary'), button('Full local reset', fullLocalReset, 'danger')])]);
}

async function resetWebAuth() {
  localStorage.removeItem(tokenKey(state.activeBridgeId));
  localStorage.removeItem('dexyd.web.tokens');
  state.tokens = null;
  await ensureAuth();
  connectStream();
  renderSettings();
  showToast('Web auth reset');
}

async function signOut() {
  try { if (state.tokens?.refreshToken) await api('/auth/revoke', { method: 'POST', body: { refreshToken: state.tokens.refreshToken } }); } catch {}
  localStorage.removeItem(tokenKey(state.activeBridgeId));
  state.tokens = null;
  renderSettings();
  showToast('Signed out');
}

async function loadHiddenSessions() {
  try {
    const result = await api('/sessions/hidden');
    state.hiddenSessions = result.sessions || [];
  } catch (error) {
    state.hiddenSessions = [];
    if (!isBridgeUnavailableError(error)) recordError('warn', 'Hidden sessions unavailable', errorMessage(error));
  }
  renderSettings();
}


function toggleCommandBar() {
  renderCommandBar();
  els.commandBar.hidden = !els.commandBar.hidden;
}

function renderCommandBar() {
  els.commandBar.replaceChildren();
  const commands = state.commands.length ? state.commands : fallbackCommands();
  for (const command of commands.slice(0, 24)) {
    const name = command.name || command.command || command.id || String(command);
    const desc = command.description || command.summary || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'command-chip';
    button.innerHTML = `<strong>${escapeHtml(name)}</strong>${desc ? `<span>${escapeHtml(desc)}</span>` : ''}`;
    button.addEventListener('click', () => insertAtCursor(`${name} `));
    els.commandBar.append(button);
  }
}

function fallbackCommands() {
  return [
    { name: '/help', description: 'Ask for available commands' },
    { name: '/status', description: 'Check current work' },
    { name: '$plan', description: 'Plan with OMX' },
    { name: '$code-review', description: 'Review current work' },
  ];
}

function insertAtCursor(text) {
  const input = els.messageInput;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
  saveDraft();
  autosizeInput();
  els.commandBar.hidden = true;
}

function normalizeContent(content, role) {
  let text = String(content || '').trim();
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '').trim();
  text = text.replace(/<hook_prompt\b[\s\S]*?<\/hook_prompt>/gi, '').trim();
  if (role === 'user') {
    const marker = /(?:^|\n)Latest user message:\s*\n/gi;
    let match, end = -1;
    while ((match = marker.exec(text))) end = match.index + match[0].length;
    if (end >= 0) text = text.slice(end).trim();
    if (/You are running inside dexyd as the assistant/i.test(text)) return '';
  }
  return text;
}

function summarizeAction(payload = {}) {
  const command = payload.command || payload.action || payload.title || payload.status;
  return command ? `Working: ${command}` : '';
}

function isRawPayload(text) { return /^<hook_prompt\b[\s\S]*<\/hook_prompt>$/i.test(text.trim()); }
function dedupe(messages) {
  const byKey = new Map();
  for (const msg of messages) {
    const normalized = normalizeContent(msg.content || '', msg.role);
    if (!normalized) continue;
    const key = `${msg.role}|${msg.turnId || ''}|${normalized}`;
    const current = byKey.get(key);
    if (!current || (current.sequence || 0) < (msg.sequence || 0)) byKey.set(key, { ...msg, content: normalized });
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function saveDraft(value = els.messageInput.value) {
  if (!state.selectedSession?.id) return;
  localStorage.setItem(cacheKey(state.selectedSession.id, 'draft'), value);
}
function restoreDraft() {
  if (!state.selectedSession?.id) return;
  els.messageInput.value = localStorage.getItem(cacheKey(state.selectedSession.id, 'draft')) || '';
  autosizeInput();
}
function cacheKey(sessionId, kind) { return `dexyd.web.${kind}.${sessionId}`; }
function autosizeInput() { els.messageInput.style.height = 'auto'; els.messageInput.style.height = `${Math.min(180, els.messageInput.scrollHeight)}px`; }
function nearBottom() { return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140; }
function scrollBottom(animated) { els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: animated ? 'smooth' : 'auto' }); }
function basename(path) { return String(path).split(/[\\/]/).filter(Boolean).at(-1) || path; }
function parentPath(path) { const value = normalizeProjectPath(path); if (!value) return ''; const parts = value.split(/[\\/]/).filter(Boolean); return value.startsWith('/') ? `/${parts.slice(0, -1).join('/')}` || '/' : parts.slice(0, -1).join('/'); }
function relativeProject(path) { return state.projectPath ? String(path).replace(state.projectPath, '.') : String(path || ''); }
function shortId(value) { return String(value || '').slice(0, 8); }
function statusLabel(status) { return status === 'running' ? 'busy' : status === 'completed' ? 'done' : status || 'idle'; }
function defaultProjectPath() { return '~'; }
function normalizeProjectPath(path) { return String(path || '').trim().replace(/\/+$/g, ''); }
function formatTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function id(name) { return document.getElementById(name); }
function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function debounce(fn, ms) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }
function closeDialogOnBackdrop(event, dialog) { const rect = dialog.getBoundingClientRect(); const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom; if (!inside) dialog.close(); }
function actionButton(label, onClick) { const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost mini'; button.textContent = label; button.addEventListener('click', event => { event.stopPropagation(); Promise.resolve(onClick()).catch(showError); }); return button; }

function loadBridgeProfiles() {
  const stored = readJson('dexyd.web.bridges');
  const profiles = Array.isArray(stored) ? stored.filter(item => item && item.id && typeof item.label === 'string') : [];
  if (!profiles.some(item => item.id === DEFAULT_BRIDGE_ID)) profiles.unshift({ id: DEFAULT_BRIDGE_ID, label: 'Web proxy', url: '' });
  return profiles;
}
function saveBridgeProfiles() { localStorage.setItem('dexyd.web.bridges', JSON.stringify(state.bridgeProfiles)); }
function tokenKey(id) { return `dexyd.web.tokens.${id || DEFAULT_BRIDGE_ID}`; }
function readTokensForBridge(id) { return readJson(tokenKey(id)) || (id === DEFAULT_BRIDGE_ID ? readJson('dexyd.web.tokens') : null); }
function activeBridgeProfile() { return state.bridgeProfiles.find(item => item.id === state.activeBridgeId) || state.bridgeProfiles[0] || { id: DEFAULT_BRIDGE_ID, label: 'Web proxy', url: '' }; }
function activeBridgeBaseUrl() { return normalizeBridgeUrl(activeBridgeProfile().url || ''); }
function normalizeBridgeUrl(value) { return String(value || '').trim().replace(/\/+$/g, ''); }
function apiUrl(path, baseUrl = activeBridgeBaseUrl()) { return baseUrl ? new URL(path, `${baseUrl}/`).toString() : path; }
function websocketUrl(path, accessToken) {
  const base = activeBridgeBaseUrl();
  const url = base ? new URL(path, `${base}/`) : new URL(path, location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}

async function refreshSettingsPaneData(key) {
  if (key === 'security') await refreshDevices();
  else if (key === 'recovery') await loadHiddenSessions();
  else if (key === 'account') await Promise.allSettled([refreshAccount(), refreshUsage()]);
  else if (key === 'connection' || key === 'diagnostics') await refreshHealth();
}

function apiError(response, detail) {
  const status = response.status;
  const clean = cleanErrorText(detail || response.statusText || 'Request failed');
  const message = [502, 503, 504].includes(status)
    ? `Bridge unavailable (${status} ${response.statusText || 'proxy error'}). Start the host Dexyd bridge or check the web stack bridge URL.`
    : `${status} ${clean}`;
  const error = new Error(message);
  error.status = status;
  error.bridgeUnavailable = [502, 503, 504].includes(status);
  return error;
}

function cleanErrorText(value) {
  const text = String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || 'Request failed';
}

function isBridgeUnavailableError(error) {
  return Boolean(error?.bridgeUnavailable || [502, 503, 504].includes(error?.status) || /Bad Gateway|Bridge unavailable|Service Unavailable|Gateway Timeout/i.test(errorMessage(error)));
}

function loadErrorHistory() {
  const items = readJson('dexyd.web.errorHistory');
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => !(String(item?.title || '').match(/Devices unavailable|Hidden sessions unavailable/i) && /<html|Bad Gateway/i.test(String(item?.body || ''))))
    .map(item => ({ ...item, body: cleanErrorText(item?.body || '') }))
    .slice(0, 40);
}
function bridgeLabel() { return state.health ? `${state.health.status} · ${state.health.version}` : 'offline'; }
function realtimeLabel() { return state.socket?.readyState === WebSocket.OPEN ? 'connected' : state.polling ? 'polling fallback' : 'connecting'; }
function accountLabel() { const auth = state.account?.codexAuth || state.account || {}; return auth.activeAccount?.label || auth.activeAccount?.email || auth.account || auth.message || 'unknown'; }
function defaultNotificationSettings() { return { inApp: true, system: false, promptFinished: true, approvals: true, questions: true, usage: true, alerts: false }; }
function notificationsSupported() { return typeof Notification !== 'undefined'; }
function percentText(value) { return typeof value === 'number' ? `${Math.round(value)}% left` : 'not reported'; }
function errorMessage(error) { return error instanceof Error ? cleanErrorText(error.message) : cleanErrorText(String(error)); }
function recordError(level, title, body) {
  const message = cleanErrorText(body).slice(0, 800);
  if (!message) return;
  const key = `${level}|${title}|${message}`;
  const now = Date.now();
  const recent = state.errorHistory.find(item => item.key === key);
  if (recent && now - new Date(recent.timestamp).getTime() < 10 * 60 * 1000) return;
  state.errorHistory = [{ id: `${now}-${Math.random()}`, key, level, title, body: message, timestamp: new Date(now).toISOString() }, ...state.errorHistory].slice(0, 40);
  localStorage.setItem('dexyd.web.errorHistory', JSON.stringify(state.errorHistory));
}
function clearErrorHistory() { state.errorHistory = []; localStorage.setItem('dexyd.web.errorHistory', '[]'); renderSettings(); }
function el(tag, className, html) { const node = document.createElement(tag); if (className) node.className = className; if (html !== undefined) node.innerHTML = html; return node; }
function hint(text) { const node = document.createElement('p'); node.className = 'setting-hint'; node.textContent = text; return node; }
function button(label, onClick, variant = '') { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = variant ? `settings-action ${variant}` : 'settings-action'; node.addEventListener('click', event => { event.preventDefault(); Promise.resolve(onClick()).catch(showError); }); return node; }
function actionRow(buttons) { const row = el('div', 'settings-actions'); row.append(...buttons); return row; }
function inputRow(label, value, idName, placeholder = '') { const row = el('label', 'field-row'); const span = el('span', '', escapeHtml(label)); const input = document.createElement('input'); input.id = idName; input.value = value || ''; input.placeholder = placeholder; row.append(span, input); return { row, input }; }
function textareaRow(label, idName, placeholder = '') { const row = el('label', 'field-row'); const span = el('span', '', escapeHtml(label)); const input = document.createElement('textarea'); input.id = idName; input.rows = 4; input.placeholder = placeholder; row.append(span, input); return { row, input }; }
function statusGrid(rows) { const dl = document.createElement('dl'); dl.className = 'settings-dl'; for (const [key, value] of Object.entries(rows)) { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value ?? 'unknown'; dl.append(dt, dd); } return dl; }
function toggleRow(label, key) { const row = el('label', 'toggle-row'); const text = el('span', '', `<strong>${escapeHtml(label)}</strong>`); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(state.notificationSettings[key]); input.addEventListener('change', () => { state.notificationSettings[key] = input.checked; localStorage.setItem('dexyd.web.notificationSettings', JSON.stringify(state.notificationSettings)); renderSettings(); }); row.append(text, input); return row; }
async function requestNotificationPermission() { if (!notificationsSupported()) return showToast('Browser notifications unsupported'); const permission = await Notification.requestPermission(); showToast(`Notifications ${permission}`); renderSettings(); }
function notify(title, body) { if (state.notificationSettings.inApp) showToast(`${title}: ${body}`); if (notificationsSupported() && state.notificationSettings.system && Notification.permission === 'granted') new Notification(title, { body }); }
async function saveBridgeProfile(label, url) {
  const normalized = normalizeBridgeUrl(url);
  if (normalized && !/^https?:\/\//i.test(normalized)) throw new Error('Bridge URL must start with http:// or https://');
  const existing = activeBridgeProfile();
  const id = existing.id || `bridge-${Date.now()}`;
  const next = { id, label: label.trim() || normalized || 'Dexyd bridge', url: normalized };
  state.bridgeProfiles = state.bridgeProfiles.map(item => item.id === id ? next : item);
  if (!state.bridgeProfiles.some(item => item.id === id)) state.bridgeProfiles.push(next);
  saveBridgeProfiles();
  await switchBridge(id);
}
async function switchBridge(id) {
  state.activeBridgeId = id;
  localStorage.setItem('dexyd.web.activeBridgeId', id);
  state.tokens = readTokensForBridge(id);
  stopPolling();
  state.socket?.close();
  if (!state.tokens) await ensureAuth().catch(error => recordError('warn', 'Web auth unavailable', errorMessage(error)));
  await Promise.allSettled([refreshHealth(), refreshSessions(), refreshAccount(), refreshDevices(), refreshUsage()]);
  connectStream();
  renderSettings();
}
async function removeBridge(id) {
  if (id === DEFAULT_BRIDGE_ID) return;
  state.bridgeProfiles = state.bridgeProfiles.filter(item => item.id !== id);
  localStorage.removeItem(tokenKey(id));
  saveBridgeProfiles();
  if (state.activeBridgeId === id) await switchBridge(DEFAULT_BRIDGE_ID);
  renderSettings();
}
function parsePairingUri(uri) {
  const url = new URL(uri.trim());
  if (url.protocol !== 'dexyd:') throw new Error('Not a dexyd pairing URI');
  const encoded = url.searchParams.get('payload');
  if (!encoded) throw new Error('Missing pairing payload');
  const json = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}
async function pairPastedUri(uri, deviceLabel, fallbackBridgeUrl) {
  const payload = parsePairingUri(uri);
  const bridgeBaseUrl = normalizeBridgeUrl(payload.bridgeBaseUrl || fallbackBridgeUrl || activeBridgeBaseUrl());
  const body = { pairingUri: uri.trim(), deviceLabel: deviceLabel.trim() || 'dexyd web' };
  let tokens;
  try {
    tokens = await api('/pairing/complete', { method: 'POST', body, baseUrl: bridgeBaseUrl }, false);
  } catch (error) {
    if (!activeBridgeBaseUrl()) tokens = await api('/pairing/complete', { method: 'POST', body }, false);
    else throw error;
  }
  const id = `bridge-${crypto.randomUUID?.() || Date.now()}`;
  state.bridgeProfiles.push({ id, label: bridgeBaseUrl || payload.bridgeBaseUrl || 'Dexyd bridge', url: bridgeBaseUrl });
  state.activeBridgeId = id;
  state.tokens = tokens;
  saveBridgeProfiles();
  saveTokens();
  localStorage.setItem('dexyd.web.activeBridgeId', id);
  await Promise.allSettled([refreshHealth(), refreshSessions(), refreshAccount(), refreshDevices()]);
  connectStream();
  renderSettings();
  showToast('Bridge paired');
}
async function startPairing() {
  const result = await api('/pairing/start', { method: 'POST', body: { bridgeBaseUrl: activeBridgeBaseUrl() || location.origin, expiresInSeconds: 300 } });
  state.pairingResult = result;
  renderSettings();
}
function pairingResultView(result) { const box = el('div', 'pairing-result'); box.append(el('strong', '', 'Pairing URI generated')); const code = document.createElement('textarea'); code.rows = 4; code.readOnly = true; code.value = result.pairingUri || ''; box.append(code); if (result.qrCodeDataUrl) { const img = document.createElement('img'); img.src = result.qrCodeDataUrl; img.alt = 'Pairing QR'; box.append(img); } box.append(button('Copy URI', () => copyText(result.pairingUri || ''))); return box; }
function accountList(auth) { const box = el('div', 'account-list'); const accounts = auth.accounts || auth.availableAccounts || []; if (!accounts.length) { box.append(hint('No alternate Codex accounts reported.')); return box; } for (const account of accounts) { const row = el('div', 'account-row'); const label = account.label || account.email || account.id || String(account); row.innerHTML = `<span>${escapeHtml(label)}</span>`; row.append(button('Switch', () => api('/codex-auth/switch', { method: 'POST', body: { query: label } }).then(refreshAccount), 'primary')); box.append(row); } return box; }
function devicesList() { const box = el('div', 'devices-list'); if (!state.devices.length) { box.append(hint('No trusted devices returned by the bridge.')); return box; } for (const device of state.devices) { const row = el('div', 'device-row'); row.innerHTML = `<span><strong>${escapeHtml(device.label || shortId(device.id))}</strong><small>${escapeHtml(device.trustState || device.trust_state || 'trusted')} · ${escapeHtml(shortId(device.id))}</small></span>`; if (device.id !== state.tokens?.deviceId) row.append(button('Revoke', async () => { await api(`/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await refreshDevices(); }, 'danger')); else row.append(el('small', 'muted', 'this browser')); box.append(row); } return box; }
async function checkUpdates() {
  const response = await fetch('https://api.github.com/repos/DrB0rk/dexyd/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const release = await response.json();
  const latestVersion = release.tag_name || '';
  const currentVersion = state.health?.version || '0.0.0';
  state.updateInfo = { latestVersion, currentVersion, releaseUrl: release.html_url || 'https://github.com/DrB0rk/dexyd/releases/latest', updateAvailable: compareVersions(latestVersion, currentVersion) > 0 };
  renderSettings();
}
function compareVersions(left, right) { const a = String(left).replace(/^v/i, '').split('-')[0].split('.').map(Number); const b = String(right).replace(/^v/i, '').split('-')[0].split('.').map(Number); for (let i = 0; i < Math.max(a.length, b.length); i++) { const diff = (a[i] || 0) - (b[i] || 0); if (diff) return diff > 0 ? 1 : -1; } return 0; }
function fullLocalReset() { if (!confirm('Reset this browser profile, tokens, inbox, and cached chat?')) return; Object.keys(localStorage).filter(key => key.startsWith('dexyd.web.')).forEach(key => localStorage.removeItem(key)); location.reload(); }
function copyText(text) { navigator.clipboard?.writeText(text).then(() => showToast('Copied')).catch(() => showToast('Copy failed')); }
function renderDl(element, rows) { element.replaceChildren(); for (const [key, value] of Object.entries(rows)) { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value ?? 'unknown'; element.append(dt, dd); } }
function showError(error) { const message = errorMessage(error); recordError(isBridgeUnavailableError(error) ? 'warn' : 'error', isBridgeUnavailableError(error) ? 'Bridge unavailable' : 'Web UI error', message); showToast(message); renderSettings(); }
function showToast(message) { els.toast.textContent = message; els.toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3600); }
