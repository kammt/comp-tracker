// All app state lives in one localStorage record so a reload never loses the event.
const STORAGE_KEY = 'comptracker-state';
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

const elements = {
  setup: document.querySelector('#setup-view'),
  dashboard: document.querySelector('#dashboard-view'),
  setupForm: document.querySelector('#setup-form'),
  eventId: document.querySelector('#event-id'),
  watchList: document.querySelector('#watch-list'),
  eventLabel: document.querySelector('#event-label'),
  eventTitle: document.querySelector('#event-title'),
  results: document.querySelector('#results'),
  status: document.querySelector('#status-banner'),
  refresh: document.querySelector('#refresh-button'),
  addButton: document.querySelector('#add-person-button'),
  resetButton: document.querySelector('#reset-button'),
  addDialog: document.querySelector('#add-dialog'),
  closeAddDialog: document.querySelector('#close-add-dialog'),
  addForm: document.querySelector('#add-form'),
  personQuery: document.querySelector('#person-query'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  closeConfirmDialog: document.querySelector('#close-confirm-dialog'),
  confirmTitle: document.querySelector('#confirm-title'),
  confirmCopy: document.querySelector('#confirm-copy'),
  confirmAction: document.querySelector('#confirm-reset'),
  confirmForm: document.querySelector('#confirm-form'),
};

let state = readState();
let pendingRemoval = null;
let changedIndicatorTimer = null;

function readState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return stored && stored.eventId && Array.isArray(stored.watchList) ? stored : null;
  } catch (error) {
    return null;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function showView(view) {
  elements.setup.hidden = view !== 'setup';
  elements.dashboard.hidden = view !== 'dashboard';
}

function setStatus(message, kind = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
  elements.status.hidden = !message;
}

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function parseWatchList(value) {
  return [...new Set(value.split(/[\n,]+/).map(normalizeQuery).filter(Boolean))];
}

function keepBibNumbersOnly(event) {
  event.target.value = event.target.value.replace(/[^\d\n]/g, '');
}

function keepDigitsOnly(event) {
  event.target.value = event.target.value.replace(/\D/g, '');
}

function textOf(element) {
  return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
}

function parseParticipant(html, query) {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  const card = [...documentFragment.querySelectorAll('.card')].find((candidate) => /Competitor information/i.test(textOf(candidate)));
  if (!card) throw new Error(`No competitor card found for “${query}”.`);

  const body = card.querySelector('.card-body') || card;
  const name = textOf(body.querySelector('table td')) || query;
  const competitions = [...body.querySelectorAll('.mt-4')].map((heading) => {
    const competition = { title: textOf(heading.querySelector('b')) || textOf(heading), role: '', partner: '', rounds: [] };
    const competitionText = getCompetitionText(heading);
    competition.role = competitionText.match(/Role:\s*([^\n]+)/i)?.[1]?.trim() || '';
    competition.partner = competitionText.match(/Partner:\s*([^\n]+)/i)?.[1]?.trim() || '';
    let sibling = heading.nextElementSibling;
    while (sibling && !sibling.classList.contains('mt-4')) {
      if (sibling.classList.contains('row')) {
        competition.rounds = [...sibling.children].map((roundElement) => parseRound(roundElement)).filter(Boolean);
      }
      sibling = sibling.nextElementSibling;
    }
    return competition;
  });

  const eventHeading = documentFragment.querySelector('main h1');
  const eventTitle = textOf(eventHeading).replace(/\s*(?:-|:)\s*marshalling lists.*$/i, '').trim();
  return { query, name, competitions, eventTitle };
}

function getCompetitionText(heading) {
  const parts = [];
  let node = heading.nextSibling;
  while (node && !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains('mt-4'))) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent);
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') parts.push('\n');
    node = node.nextSibling;
  }
  return parts.join('').replace(/\s*\n\s*/g, '\n').trim();
}

function parseRound(roundElement) {
  const statusElement = roundElement.querySelector('b, span.text-danger');
  const statusText = textOf(statusElement);
  if (!statusText) return null;
  const roundName = statusText.replace(/^[✓×]\s*/, '').trim();
  const isIn = !roundElement.querySelector('.text-danger') && !/did not|not made/i.test(statusText);
  const heat = textOf(roundElement.querySelector('.badge'));
  return { name: roundName, status: isIn ? 'in' : 'out', heat };
}

async function fetchParticipant(eventId, query) {
  const search = new URLSearchParams({ q: query });
  const target = `https://scoring.dance/enUS/events/${encodeURIComponent(eventId)}/wall?${search}`;
  try {
    const response = await fetch(target, { cache: 'no-store', headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(`scoring.dance returned ${response.status}`);
    return parseParticipant(await response.text(), query);
  } catch (directError) {
    // GitHub Pages cannot proxy cross-origin HTML. The fallback keeps the app usable
    // when scoring.dance does not expose CORS headers, while preserving a direct request first.
    const response = await fetch(`${CORS_PROXY}${encodeURIComponent(target)}`, { cache: 'no-store' });
    if (!response.ok) throw directError;
    return parseParticipant(await response.text(), query);
  }
}

function sameParticipant(previous, next) {
  const comparable = (participant) => JSON.stringify({
    query: participant.query,
    name: participant.name,
    eventTitle: participant.eventTitle,
    competitions: participant.competitions,
  });
  return comparable(previous) === comparable(next);
}

async function refreshResults() {
  if (!state || state.watchList.length === 0) return;
  elements.refresh.disabled = true;
  elements.refresh.classList.add('is-loading');
  setStatus(`Refreshing ${state.watchList.length} ${state.watchList.length === 1 ? 'person' : 'people'}…`);
  const previousResults = state.results || [];
  let changedCount = 0;
  const settled = await Promise.allSettled(state.watchList.map((query) => fetchParticipant(state.eventId, query)));
  const results = settled.map((item, index) => {
    if (item.status === 'fulfilled') {
      const oldResult = previousResults.find((result) => result.query === state.watchList[index]);
      const changed = Boolean(oldResult && !sameParticipant(oldResult, item.value));
      if (changed) changedCount += 1;
      return { ...item.value, changed };
    }
    const oldResult = previousResults.find((result) => result.query === state.watchList[index]);
    return oldResult ? { ...oldResult, error: item.reason.message } : { query: state.watchList[index], name: state.watchList[index], competitions: [], error: item.reason.message };
  });
  state.results = results;
  state.changedCount = changedCount;
  const fetchedTitle = results.find((result) => result.eventTitle)?.eventTitle;
  if (fetchedTitle) state.eventTitle = fetchedTitle;
  if (fetchedTitle) elements.eventLabel.textContent = `${fetchedTitle} · #${state.eventId}`;
  state.fetchedAt = new Date().toISOString();
  saveState();
  renderResults();
  const failed = settled.filter((item) => item.status === 'rejected').length;
  const changeSummary = `${changedCount} ${changedCount === 1 ? "person's" : "people's"} info changed on this update.`;
  setStatus(failed ? `${failed} result${failed === 1 ? '' : 's'} could not be refreshed. Cached data is shown. ${changeSummary}` : `Updated ${formatTime(state.fetchedAt)}. ${changeSummary}`, failed ? 'error' : 'info');
  scheduleChangedIndicatorReset();
  elements.refresh.disabled = false;
  elements.refresh.classList.remove('is-loading');
}

function scheduleChangedIndicatorReset() {
  clearTimeout(changedIndicatorTimer);
  if (!(state?.results || []).some((result) => result.changed)) return;
  changedIndicatorTimer = setTimeout(() => {
    state.results = state.results.map((result) => ({ ...result, changed: false }));
    saveState();
    renderResults();
  }, 10000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function renderResults() {
  const results = state?.results || [];
  if (!results.length) {
    elements.results.innerHTML = '<div class="empty-state">No results yet. Tap refresh to fetch the first snapshot.</div>';
    return;
  }
  elements.results.innerHTML = results.map((participant) => `
    <article class="participant${participant.changed ? ' is-changed' : ''}">
      <header class="participant-header"><div><h2 class="participant-name">${escapeHtml(participant.name)}</h2><span class="bib">Search: ${escapeHtml(participant.query)}</span></div><div class="participant-tools">${participant.changed ? '<strong class="change-label">CHANGED</strong>' : ''}<button class="remove-button" type="button" data-remove-query="${escapeHtml(participant.query)}" aria-label="Remove ${escapeHtml(participant.name)}" title="Remove person">×</button></div></header>
      ${participant.error ? `<p class="participant-error">${escapeHtml(participant.error)}</p>` : participant.competitions.map(renderCompetition).join('') || '<p class="participant-error">No competition details found.</p>'}
    </article>`).join('');
}

function renderCompetition(competition) {
  return `<section class="competition"><h3 class="competition-title">${escapeHtml(competition.title)}</h3>${competition.role ? `<p class="meta-line">Role: ${escapeHtml(competition.role)}</p>` : ''}${competition.partner ? `<p class="meta-line">Partner: ${escapeHtml(competition.partner)}</p>` : ''}<div class="rounds">${competition.rounds.map((round) => `<div class="round"><span class="round-name">${escapeHtml(round.name)}</span><span class="round-status ${round.status}">${round.status === 'in' ? '✓ In' : '× Out'}</span>${round.heat ? `<span class="heat">${escapeHtml(round.heat)}</span>` : ''}</div>`).join('')}</div></section>`;
}

function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }

function openAddDialog() { elements.personQuery.value = ''; elements.addDialog.showModal(); elements.personQuery.focus(); }

elements.setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state = { version: 1, eventId: normalizeQuery(elements.eventId.value), eventTitle: '', watchList: parseWatchList(elements.watchList.value), results: [], fetchedAt: null, changedCount: 0 };
  saveState();
  openDashboard();
  refreshResults();
});

elements.watchList.addEventListener('input', keepBibNumbersOnly);
elements.personQuery.addEventListener('input', keepDigitsOnly);

elements.refresh.addEventListener('click', refreshResults);
elements.addButton.addEventListener('click', openAddDialog);
elements.closeAddDialog.addEventListener('click', () => elements.addDialog.close());
elements.results.addEventListener('click', (event) => {
  const removeButton = event.target.closest('[data-remove-query]');
  if (!removeButton) return;
  const query = removeButton.dataset.removeQuery;
  pendingRemoval = query;
  elements.confirmTitle.textContent = `Remove ${query}?`;
  elements.confirmCopy.textContent = 'This removes the person and their cached results from the watch list.';
  elements.confirmAction.textContent = 'Remove person';
  elements.confirmDialog.showModal();
});
elements.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = normalizeQuery(elements.personQuery.value);
  if (query && !state.watchList.includes(query)) state.watchList.push(query);
  saveState();
  elements.addDialog.close();
  openDashboard();
  refreshResults();
});
elements.resetButton.addEventListener('click', () => {
  pendingRemoval = null;
  elements.confirmTitle.textContent = 'Reset this event?';
  elements.confirmCopy.textContent = 'This removes the saved event, watch list, and cached results from this device.';
  elements.confirmAction.textContent = 'Reset everything';
  elements.confirmDialog.showModal();
});
elements.closeConfirmDialog.addEventListener('click', () => elements.confirmDialog.close());
elements.confirmForm.addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'confirm') return;
  if (pendingRemoval) {
    const query = pendingRemoval;
    state.watchList = state.watchList.filter((item) => item !== query);
    state.results = (state.results || []).filter((result) => result.query !== query);
    saveState();
    renderResults();
    setStatus(`${query} removed from the watch list.`);
    pendingRemoval = null;
    elements.confirmDialog.close();
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  elements.confirmDialog.close();
  elements.setupForm.reset();
  showView('setup');
});

function openDashboard() {
  showView('dashboard');
  elements.eventLabel.textContent = state.eventTitle ? `${state.eventTitle} · #${state.eventId}` : `#${state.eventId}`;
  renderResults();
  scheduleChangedIndicatorReset();
  if (state.fetchedAt) {
    const changedCount = state.changedCount || 0;
    const changeSummary = `${changedCount} ${changedCount === 1 ? "person's" : "people's"} info changed on this update.`;
    setStatus(`Last updated ${formatTime(state.fetchedAt)}. ${changeSummary}`);
  }
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

if (state) openDashboard();
else showView('setup');