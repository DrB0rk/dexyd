const state = {
  tokens: readJson('dexyd.web.tokens'),
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
};

const els = {
  bridgeStatus: id('bridgeStatus'),
  projectPath: id('projectPath'),
  upProject: id('upProject'),
  loadProject: id('loadProject'),
  suggestions: id('suggestions'),
  newSession: id('newSession'),
  refreshSessions: id('refreshSessions'),
  sessions: id('sessions'),
  inboxBadge: id('inboxBadge'),
  inboxList: id('inboxList'),
  clearInbox: id('clearInbox'),
  systemSummary: id('systemSummary'),
  settingsConnection: id('settingsConnection'),
  accountStatus: id('accountStatus'),
  resetWebAuth: id('resetWebAuth'),
  loadHiddenSessions: id('loadHiddenSessions'),
  hiddenSessions: id('hiddenSessions'),
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
  await ensureAuth();
  await Promise.allSettled([refreshHealth(), refreshSessions(), refreshAccount(), refreshCommands()]);
  connectStream();
  setInterval(refreshHealth, 15000);
  setInterval(refreshAccount, 60000);
  setInterval(() => refreshSessions({ background: true }).catch(() => {}), 30000);
}

function bindUi() {
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });
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
  els.resetWebAuth.addEventListener('click', resetWebAuth);
  els.loadHiddenSessions.addEventListener('click', loadHiddenSessions);
  els.closeDiff.addEventListener('click', () => els.diffDialog.close());
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
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  document.querySelectorAll('.side-page').forEach(section => section.classList.toggle('active', section.id === page));
  if (page === 'settingsPage') {
    refreshAccount().catch(() => {});
    renderSettings();
  }
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
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsScheme}://${location.host}/ws?access_token=${encodeURIComponent(state.tokens.accessToken)}`;
  try {
    state.socket?.close();
    state.socket = new WebSocket(wsUrl);
    state.socket.onopen = () => {
      state.socket.send(JSON.stringify({ type: 'replay.request', lastSeenSequence: state.lastSequence }));
      stopPolling();
      showToast('Realtime connected');
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
  renderDl(els.settingsConnection, {
    Bridge: state.health ? `${state.health.status} · ${state.health.version}` : 'offline',
    Realtime: state.socket?.readyState === WebSocket.OPEN ? 'connected' : state.polling ? 'polling fallback' : 'connecting',
    Project: state.projectPath,
    URL: location.origin,
  });
  const account = state.account;
  renderDl(els.accountStatus, {
    Status: account?.available === false ? 'unavailable' : 'available',
    Account: account?.activeAccount?.label || account?.activeAccount?.email || 'unknown',
    Details: account?.message || account?.status || 'not reported',
  });
}

async function resetWebAuth() {
  localStorage.removeItem('dexyd.web.tokens');
  state.tokens = null;
  await ensureAuth();
  connectStream();
  showToast('Web auth reset');
}

async function loadHiddenSessions() {
  const result = await api('/sessions/hidden');
  state.hiddenSessions = result.sessions || [];
  renderHiddenSessions();
}

function renderHiddenSessions() {
  els.hiddenSessions.replaceChildren();
  if (!state.hiddenSessions.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-list';
    empty.textContent = 'No hidden sessions.';
    els.hiddenSessions.append(empty);
    return;
  }
  for (const session of state.hiddenSessions) {
    const row = document.createElement('div');
    row.className = 'hidden-item';
    row.innerHTML = `<span>${escapeHtml(session.title || shortId(session.id))}</span>`;
    row.append(actionButton('Restore', async () => {
      await api(`/sessions/${encodeURIComponent(session.id)}/restore`, { method: 'POST', body: {} });
      await Promise.all([loadHiddenSessions(), refreshSessions()]);
    }));
    els.hiddenSessions.append(row);
  }
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
function copyText(text) { navigator.clipboard?.writeText(text).then(() => showToast('Copied')).catch(() => showToast('Copy failed')); }
function renderDl(element, rows) { element.replaceChildren(); for (const [key, value] of Object.entries(rows)) { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value ?? 'unknown'; element.append(dt, dd); } }
function showError(error) { showToast(error instanceof Error ? error.message : String(error)); }
function showToast(message) { els.toast.textContent = message; els.toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3600); }
