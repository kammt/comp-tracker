// All app state lives in one localStorage record so a reload never loses the event.
const STORAGE_KEY = 'comptracker-state';
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

const elements = {
  setup: document.querySelector('#setup-view'),
  dashboard: document.querySelector('#dashboard-view'),
  setupForm: document.querySelector('#setup-form'),
  findEventButton: document.querySelector('#find-event-button'),
  findEventLabel: document.querySelector('#find-event-label'),
  eventId: document.querySelector('#event-id'),
  setupStatus: document.querySelector('#setup-status'),
  eventPreviewTitle: document.querySelector('#event-preview-title'),
  continueButton: document.querySelector('#continue-button'),
  eventIdHelp: document.querySelector('#event-id-help'),
  eventIdDialog: document.querySelector('#event-id-dialog'),
  eventPreviewDialog: document.querySelector('#event-preview-dialog'),
  eventLabel: document.querySelector('#event-label'),
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
  showResults: document.querySelector('#show-results-button'),
  resultsView: document.querySelector('#results-view'),
  resultsEventLabel: document.querySelector('#results-event-label'),
  resultsList: document.querySelector('#results-list'),
  backButton: document.querySelector('#back-button'),
};

let state = readState();
let pendingEvent = null;
let pendingRemoval = null;
let changedIndicatorTimer = null;
let refreshInFlight = null;
let refreshQueued = false;

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
  elements.resultsView.hidden = view !== 'results';
}

function setStatus(message, kind = 'info', statusElement = elements.status) {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
  statusElement.hidden = !message;
}

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function keepDigitsOnly(event) {
  event.target.value = event.target.value.replace(/\D/g, '');
}

function textOf(element) {
  return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
}

function parseParticipant(html, query, eventId) {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  const card = [...documentFragment.querySelectorAll('.card')].find((candidate) => /Competitor information/i.test(textOf(candidate)));
  if (!card) throw new Error(`Bib number ${query} does not exist in event ${eventId}.`);

  const body = card.querySelector('.card-body') || card;
  const name = textOf(body.querySelector('table td')) || query;
  // The wall's side menu links every round of the event as "<competition> <round>".
  // It is the fallback for round names and IDs, which the competitor card sometimes leaves out.
  const navRounds = [...documentFragment.querySelectorAll('#wallnav a[href*="/wall/"]')]
    .map((link) => ({ id: roundIdFromHref(link.getAttribute('href')), label: textOf(link) }))
    .filter((round) => round.id);
  const competitions = [...body.querySelectorAll('.mt-4')].map((heading) => {
    const competition = { title: textOf(heading.querySelector('b')) || textOf(heading), role: '', partner: '', rounds: [] };
    const competitionText = getCompetitionText(heading);
    competition.role = competitionText.match(/Role:\s*([^\n]+)/i)?.[1]?.trim() || '';
    competition.partner = competitionText.match(/Partner:\s*([^\n]+)/i)?.[1]?.trim() || '';
    const competitionNavRounds = navRounds
      .filter((round) => round.label.startsWith(`${competition.title} `))
      .map((round) => ({ id: round.id, name: round.label.slice(competition.title.length).trim() }));
    let sibling = heading.nextElementSibling;
    while (sibling && !sibling.classList.contains('mt-4')) {
      if (sibling.classList.contains('row')) {
        competition.rounds = [...sibling.children].map((roundElement, index) => parseRound(roundElement, competitionNavRounds[index])).filter(Boolean);
      }
      sibling = sibling.nextElementSibling;
    }
    return competition;
  });
  const resultsAvailable = Boolean(documentFragment.querySelector(`a[href*="/events/${eventId}/results"]`));

  return { query, name, competitions, resultsAvailable };
}

function roundIdFromHref(href) {
  return href?.match(/\/(?:wall|results)\/(\d+)\.html/)?.[1] || null;
}

function parseEventTitle(html) {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  const eventHeading = documentFragment.querySelector('main h1');
  const eventTitle = textOf(eventHeading).replace(/\s*(?:-|:)\s*marshalling lists.*$/i, '').trim();
  if (!eventTitle || /^404\b/i.test(eventTitle) || /^not found$/i.test(eventTitle)) throw new Error('No event found for that ID.');
  return eventTitle;
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

function parseRound(roundElement, navRound) {
  const statusElement = roundElement.querySelector('b, span.text-danger');
  if (!statusElement) return null;
  const statusText = textOf(statusElement);
  const roundName = statusText.replace(/^[✓×]\s*/, '').trim() || navRound?.name || '';
  if (!roundName) return null;
  const id = roundIdFromHref(roundElement.querySelector('a[href*="/wall/"]')?.getAttribute('href')) || navRound?.id || null;
  const isIn = !roundElement.querySelector('.text-danger') && !/did not|not made/i.test(statusText);
  const heat = textOf(roundElement.querySelector('.badge'));
  return { id, name: roundName, status: isIn ? 'in' : 'out', heat };
}

// A results page holds one table per role in prelims and semis, and one table in finals.
// Each judge column header carries the judge's full name in its title attribute.
function parseRoundResults(html, roundId) {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  const container = documentFragment.querySelector('#anzeige') || documentFragment.body;
  const title = textOf(container.querySelector('h2'));
  const tables = [...container.querySelectorAll('table')].map(parseResultTable).filter((table) => table && table.rows.length);
  if (!tables.length) throw new Error(`No results found for round ${roundId}.`);
  return { id: roundId, title, tables };
}

function parseResultTable(table) {
  const headers = [...table.querySelectorAll('thead th')];
  const judgeIndexes = headers.map((header, index) => (header.hasAttribute('title') ? index : -1)).filter((index) => index >= 0);
  if (!judgeIndexes.length) return null;
  const judges = judgeIndexes.map((index) => {
    const fullTitle = headers[index].getAttribute('title').trim();
    const chief = /chief\s*judge/i.test(fullTitle) || Boolean(headers[index].querySelector('.fa-crown'));
    return { initials: textOf(headers[index]), name: fullTitle.replace(/\s*\(chief\s*judge\)\s*$/i, '').trim(), chief };
  });
  const bibIndex = headers.findIndex((header) => header.querySelector('img[alt*="bib" i], source[srcset*="bibnumber"]'));
  const nameIndex = bibIndex >= 0 ? bibIndex + 1 : 0;
  const partnerIndex = nameIndex + 1 < judgeIndexes[0] ? nameIndex + 1 : -1;
  const resultIndex = judgeIndexes[judgeIndexes.length - 1] + 1;
  const rows = [...table.querySelectorAll('tbody tr')].map((row) => {
    const cells = row.children;
    return {
      bib: bibIndex >= 0 ? textOf(cells[bibIndex]) : '',
      name: textOf(cells[nameIndex]),
      partner: partnerIndex >= 0 ? textOf(cells[partnerIndex]) : '',
      state: row.dataset.state || '',
      result: textOf(cells[resultIndex]),
      scores: judgeIndexes.map((index) => ({ value: textOf(cells[index]), tiebreak: Boolean(cells[index]?.querySelector('.fa-gavel')) })),
    };
  }).filter((row) => row.name);
  const isFinal = rows.some((row) => /^\d+\s*(st|nd|rd|th)$/i.test(row.result));
  return { kind: isFinal ? 'final' : 'callback', judges, rows };
}

// Names are compared without accents, case or word order: results pages show followers
// in finals by name only, and some pages list family names first.
function nameKey(name) {
  return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ł/g, 'l').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
}

function findPersonResult(page, participant) {
  const key = nameKey(participant.name);
  const candidates = page.tables.flatMap((table) => table.rows.map((row) => ({ table, row })));
  const match = candidates.find(({ row }) => row.bib && row.bib === participant.query)
    || candidates.find(({ row }) => key && nameKey(row.name) === key)
    || candidates.find(({ row }) => key && row.partner && nameKey(row.partner) === key);
  if (!match) return { notFound: true };
  const { table, row } = match;
  const isPartnerColumn = row.bib !== participant.query && nameKey(row.name) !== key;
  return {
    kind: table.kind,
    value: row.result,
    placement: table.kind === 'final' ? parseInt(row.result, 10) || null : null,
    fieldSize: table.rows.length,
    state: row.state,
    partner: isPartnerColumn ? row.name : row.partner,
    judges: table.judges.map((judge, index) => ({ ...judge, score: row.scores[index]?.value || '', tiebreak: Boolean(row.scores[index]?.tiebreak) })),
  };
}

function scoringUrl(eventId, path) {
  return `https://scoring.dance/enUS/events/${encodeURIComponent(eventId)}/${path}`;
}

async function fetchWallPage(eventId, search = '') {
  return fetchScoringPage(scoringUrl(eventId, `wall${search ? `?${search}` : ''}`));
}

async function fetchScoringPage(target) {
  let response;
  try {
    response = await fetch(target, { cache: 'no-store', headers: { Accept: 'text/html' } });
  } catch (directError) {
    // GitHub Pages cannot proxy cross-origin HTML. The fallback keeps the app usable
    // when scoring.dance does not expose CORS headers, while preserving a direct request first.
    response = await fetch(`${CORS_PROXY}${encodeURIComponent(target)}`, { cache: 'no-store' });
  }
  if (!response.ok) throw new Error(`scoring.dance returned error code ${response.status}.`);
  return response.text();
}

async function fetchParticipant(eventId, query) {
  const html = await fetchWallPage(eventId, new URLSearchParams({ q: query }));
  return parseParticipant(html, query, eventId);
}

async function fetchEvent(eventId) {
  return parseEventTitle(await fetchWallPage(eventId));
}

async function fetchPublishedRoundIds(eventId) {
  const html = await fetchScoringPage(scoringUrl(eventId, 'results/'));
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  return new Set([...documentFragment.querySelectorAll('a[href*="/results/"]')].map((link) => roundIdFromHref(link.getAttribute('href'))).filter(Boolean));
}

async function fetchRoundResults(eventId, roundId) {
  return parseRoundResults(await fetchScoringPage(scoringUrl(eventId, `results/${roundId}.html`)), roundId);
}

// Fetches each published round the watched people danced in once, however many of them were in it.
async function fetchResultPages(eventId, participants) {
  const pages = new Map();
  const published = await fetchPublishedRoundIds(eventId);
  const roundIds = [...new Set(participants.flatMap((participant) => participant.competitions.flatMap((competition) => competition.rounds
    .filter((round) => round.status === 'in' && round.id && published.has(round.id))
    .map((round) => round.id))))];
  const settled = await Promise.allSettled(roundIds.map((roundId) => fetchRoundResults(eventId, roundId)));
  settled.forEach((item, index) => { if (item.status === 'fulfilled') pages.set(roundIds[index], item.value); });
  return { pages, failed: settled.filter((item) => item.status === 'rejected').length };
}

// Rounds whose results page could not be loaded this time keep the result cached last time.
function attachResults(participant, pages, previous) {
  const competitions = participant.competitions.map((competition) => {
    const previousCompetition = previous?.competitions?.find((item) => item.title === competition.title);
    return {
      ...competition,
      rounds: competition.rounds.map((round) => {
        const previousResult = previousCompetition?.rounds?.find((item) => item.name === round.name)?.result || null;
        const page = round.status === 'in' && round.id ? pages?.get(round.id) : null;
        return { ...round, result: page ? findPersonResult(page, participant) : previousResult };
      }),
    };
  });
  return { ...participant, competitions };
}

function sameParticipant(previous, next) {
  // Round IDs are bookkeeping only; leaving them out keeps older cached data from looking changed.
  const comparable = (participant) => JSON.stringify({
    query: participant.query,
    name: participant.name,
    competitions: (participant.competitions || []).map((competition) => ({
      ...competition,
      rounds: competition.rounds.map(({ id, ...round }) => ({ ...round, result: round.result || null })),
    })),
  });
  return comparable(previous) === comparable(next);
}

function changeSummaryText(changedCount) {
  return `${changedCount} ${changedCount === 1 ? "person's" : "people's"} info changed on this update.`;
}

function setRefreshing(isRefreshing) {
  elements.refresh.disabled = isRefreshing;
  elements.refresh.classList.toggle('is-loading', isRefreshing);
}

// Only one refresh runs at a time; a request made meanwhile (e.g. adding a person)
// queues exactly one follow-up refresh so nobody is left out.
function refreshResults() {
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = runRefresh().finally(() => {
    refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      refreshResults();
    }
  });
  return refreshInFlight;
}

async function runRefresh() {
  const current = state;
  if (!current) return;
  if (current.watchList.length === 0) {
    setStatus('Add a person to start tracking their results.');
    return;
  }
  // Snapshot the list: the user can add or remove people while requests are in flight.
  const watchList = [...current.watchList];
  setRefreshing(true);
  setStatus(`Refreshing ${watchList.length} ${watchList.length === 1 ? 'person' : 'people'}…`);
  try {
    const settled = await Promise.allSettled(watchList.map((query) => fetchParticipant(current.eventId, query)));
    const loaded = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const resultsAvailable = loaded.length ? loaded.some((participant) => participant.resultsAvailable) : Boolean(current.resultsAvailable);
    let resultPages = null;
    let resultsFailed = false;
    if (resultsAvailable && loaded.length) {
      setStatus('Loading results…');
      try {
        const fetched = await fetchResultPages(current.eventId, loaded);
        resultPages = fetched.pages;
        resultsFailed = fetched.failed > 0;
      } catch (error) {
        resultsFailed = true;
      }
    }
    // The event was reset (or replaced) while we were waiting; drop these results.
    if (state !== current) return;
    const previousResults = current.results || [];
    let changedCount = 0;
    const results = settled.map((item, index) => {
      const query = watchList[index];
      const oldResult = previousResults.find((result) => result.query === query);
      if (item.status === 'fulfilled') {
        const { resultsAvailable: _ignored, ...fetchedParticipant } = item.value;
        const participant = attachResults(fetchedParticipant, resultPages, oldResult);
        const changed = Boolean(oldResult && !oldResult.neverLoaded && !sameParticipant(oldResult, participant));
        if (changed) changedCount += 1;
        return { ...participant, changed };
      }
      return oldResult
        ? { ...oldResult, changed: false, error: item.reason.message }
        : { query, name: query, competitions: [], neverLoaded: true, changed: false, error: item.reason.message };
    }).filter((result) => current.watchList.includes(result.query));
    current.results = results;
    current.changedCount = changedCount;
    current.resultsAvailable = resultsAvailable;
    current.fetchedAt = new Date().toISOString();
    saveState();
    renderAll();
    const failed = settled.filter((item) => item.status === 'rejected').length;
    const changeSummary = changeSummaryText(changedCount);
    const resultsNote = resultsFailed ? ' Some competition results could not be loaded; cached results are shown where available.' : '';
    setStatus(failed ? `${failed} result${failed === 1 ? '' : 's'} could not be refreshed. Cached data is shown where available. ${changeSummary}${resultsNote}` : `Updated ${formatTime(current.fetchedAt)}. ${changeSummary}${resultsNote}`, failed || resultsFailed ? 'error' : 'info');
    scheduleChangedIndicatorReset();
  } finally {
    setRefreshing(false);
  }
}

function scheduleChangedIndicatorReset() {
  clearTimeout(changedIndicatorTimer);
  if (!(state?.results || []).some((result) => result.changed)) return;
  changedIndicatorTimer = setTimeout(() => {
    if (!state?.results) return;
    state.results = state.results.map((result) => ({ ...result, changed: false }));
    saveState();
    renderAll();
  }, 10000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function renderResults() {
  const results = state?.results || [];
  if (!results.length) {
    elements.results.innerHTML = '<div class="empty-state">No results yet.</div>';
    return;
  }
  elements.results.innerHTML = results.map((participant) => `
    <article class="participant${participant.changed ? ' is-changed' : ''}">
      <header class="participant-header"><div><h2 class="participant-name">${escapeHtml(participant.name)}</h2><span class="bib">Search: ${escapeHtml(participant.query)}</span></div><div class="participant-tools">${participant.changed ? '<strong class="change-label">CHANGED</strong>' : ''}<button class="remove-button" type="button" data-remove-query="${escapeHtml(participant.query)}" aria-label="Remove ${escapeHtml(participant.name)}" title="Remove person">×</button></div></header>
      ${renderParticipantBody(participant)}
    </article>`).join('');
}

function renderParticipantBody(participant) {
  const competitions = (participant.competitions || []).map(renderCompetition).join('');
  if (!participant.error) return competitions || '<p class="participant-error">No competition details found.</p>';
  const prefix = competitions ? 'Showing cached results. ' : '';
  return `<p class="participant-error">${escapeHtml(prefix + participant.error)}</p>${competitions}`;
}

function renderCompetition(competition) {
  return `<section class="competition"><h3 class="competition-title">${escapeHtml(competition.title)}</h3>${competition.role ? `<p class="meta-line">Role: ${escapeHtml(competition.role)}</p>` : ''}${competition.partner ? `<p class="meta-line">Partner: ${escapeHtml(competition.partner)}</p>` : ''}<div class="rounds">${competition.rounds.map((round) => `<div class="round"><span class="round-name">${escapeHtml(round.name)}</span><span class="round-status ${round.status}">${round.status === 'in' ? '✓ In' : '× Out'}</span>${round.heat ? `<span class="heat">${escapeHtml(round.heat)}</span>` : ''}${renderRoundResultChip(round.result)}</div>`).join('')}</div></section>`;
}

function hasResult(result) {
  return Boolean(result && !result.notFound);
}

function callbackOutcome(result) {
  const alternate = result.state.match(/^alt\s*(\d+)$/i);
  if (/^cb$/i.test(result.state)) return { kind: 'callback', short: 'CB', long: 'Callback' };
  if (alternate) return { kind: 'alternate', short: `Alt ${alternate[1]}`, long: `Alternate ${alternate[1]}` };
  return { kind: 'no-callback', short: 'No CB', long: 'No callback' };
}

function renderRoundResultChip(result) {
  if (!hasResult(result)) return '';
  if (result.kind === 'final') {
    return `<span class="round-result final${result.placement && result.placement <= 3 ? ' podium' : ''}">${escapeHtml(result.value)}<small> of ${result.fieldSize}</small></span>`;
  }
  const outcome = callbackOutcome(result);
  return `<span class="round-result ${outcome.kind}">${outcome.short}${result.value ? ` · Σ${escapeHtml(result.value)}` : ''}</span>`;
}

function renderPlacement(value) {
  const [, number, suffix] = String(value).match(/^(\d+)\s*(\D*)$/) || [null, value, ''];
  return `${escapeHtml(number)}<sup>${escapeHtml(suffix)}</sup>`;
}

function renderResultsView() {
  const participants = state?.results || [];
  const blocks = participants.map(renderParticipantResults).join('');
  elements.resultsList.innerHTML = blocks || '<div class="empty-state">No results yet. Refresh the watch list once results are published.</div>';
}

function renderParticipantResults(participant) {
  const competitions = (participant.competitions || []).filter((competition) => competition.rounds.some((round) => round.status === 'in'));
  const body = competitions.map(renderCompetitionResults).join('') || '<p class="participant-error">No competition details found.</p>';
  return `<article class="participant">
      <header class="participant-header"><div><h2 class="participant-name">${escapeHtml(participant.name)}</h2><span class="bib">Bib ${escapeHtml(participant.query)}</span></div></header>
      ${body}
    </article>`;
}

function renderCompetitionResults(competition) {
  const danced = competition.rounds.filter((round) => round.status === 'in');
  const final = danced.find((round) => hasResult(round.result) && round.result.kind === 'final');
  const meta = [competition.role, competition.partner && `Partner: ${competition.partner}`].filter(Boolean).map(escapeHtml).join(' · ');
  // Newest round first, so the final (the result that matters most) leads.
  const rounds = [...danced].reverse().map(renderRoundResults).join('');
  const hero = final ? `<div class="placement-hero${final.result.placement && final.result.placement <= 3 ? ' podium' : ''}"><span class="placement-number">${renderPlacement(final.result.value)}</span><span class="placement-copy"><strong>Final placement</strong><span>of ${final.result.fieldSize}${final.result.partner ? ` · with ${escapeHtml(final.result.partner)}` : ''}</span></span></div>` : '';
  return `<section class="competition"><h3 class="competition-title">${escapeHtml(competition.title)}</h3>${meta ? `<p class="meta-line">${meta}</p>` : ''}${hero}${rounds}</section>`;
}

function renderRoundResults(round) {
  const result = round.result;
  let outcome = '<span class="outcome pending">No results yet</span>';
  if (result?.notFound) outcome = '<span class="outcome pending">Not found in the results</span>';
  else if (hasResult(result) && result.kind === 'final') outcome = `<span class="outcome final">${escapeHtml(result.value)} of ${result.fieldSize}</span>`;
  else if (hasResult(result)) {
    const callback = callbackOutcome(result);
    outcome = `<span class="outcome ${callback.kind}">${callback.long}${result.value ? ` · Σ ${escapeHtml(result.value)}` : ''}</span>`;
  }
  const partner = hasResult(result) && result.partner && result.kind !== 'final' ? `<p class="round-partner">with ${escapeHtml(result.partner)}</p>` : '';
  const judges = hasResult(result) ? `<div class="judge-grid">${result.judges.map(renderJudgeScore).join('')}</div>` : '';
  return `<div class="round-results"><div class="round-results-head"><span class="round-name">${escapeHtml(round.name)}</span>${outcome}</div>${partner}${judges}</div>`;
}

function judgeScoreKind(score) {
  if (/^yes$/i.test(score)) return 'yes';
  if (/^no$/i.test(score)) return 'no';
  if (/^alt/i.test(score)) return 'alt';
  return score ? 'rank' : 'empty';
}

function renderJudgeScore(judge) {
  const kind = judgeScoreKind(judge.score);
  const score = judge.score ? `${judge.tiebreak ? '<span aria-label="Tie-break score">⚖ </span>' : ''}${escapeHtml(judge.score)}` : '–';
  return `<div class="judge${judge.chief ? ' chief' : ''}" title="${escapeHtml(judge.name)}"><span class="judge-initials">${judge.chief ? '<span aria-hidden="true">♛</span>' : ''}${escapeHtml(judge.initials)}</span><span class="judge-score ${kind}">${score}</span><span class="judge-name">${escapeHtml(judge.name)}${judge.chief ? '<em>Chief judge</em>' : ''}</span></div>`;
}

function hasAnyResults() {
  return (state?.results || []).some((participant) => (participant.competitions || []).some((competition) => competition.rounds.some((round) => hasResult(round.result))));
}

function renderAll() {
  renderResults();
  elements.showResults.hidden = !(state?.resultsAvailable || hasAnyResults());
  if (!elements.resultsView.hidden) renderResultsView();
}

function formatTime(value) {
  const date = new Date(value);
  const isToday = date.toDateString() === new Date().toDateString();
  // Browsers pick 12/24-hour from the language (en-US → AM/PM) and can't see the phone's
  // 24-hour setting, so force a 24-hour clock.
  const options = isToday
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function openAddDialog() { elements.personQuery.value = ''; elements.addDialog.showModal(); elements.personQuery.focus(); }

elements.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const eventId = normalizeQuery(elements.eventId.value);
  elements.findEventButton.disabled = true;
  elements.findEventButton.classList.add('is-loading');
  elements.findEventLabel.textContent = 'Finding event...';
  setStatus('Finding event…', 'info', elements.setupStatus);
  try {
    pendingEvent = { eventId, eventTitle: await fetchEvent(eventId) };
    elements.eventPreviewTitle.textContent = pendingEvent.eventTitle;
    setStatus('', 'info', elements.setupStatus);
    elements.eventPreviewDialog.showModal();
  } catch (error) {
    pendingEvent = null;
    setStatus(`Could not find that event. ${error.message}`, 'error', elements.setupStatus);
  } finally {
    elements.findEventButton.disabled = false;
    elements.findEventButton.classList.remove('is-loading');
    elements.findEventLabel.textContent = 'Find event';
  }
});

elements.personQuery.addEventListener('input', keepDigitsOnly);
elements.continueButton.addEventListener('click', () => {
  if (!pendingEvent) return;
  state = { version: 1, eventId: pendingEvent.eventId, eventTitle: pendingEvent.eventTitle, watchList: [], results: [], fetchedAt: null, changedCount: 0 };
  pendingEvent = null;
  saveState();
  elements.eventPreviewDialog.close();
  openDashboard();
});
elements.eventPreviewDialog.addEventListener('close', () => elements.eventId.focus());
elements.eventIdHelp.addEventListener('click', () => elements.eventIdDialog.showModal());

elements.refresh.addEventListener('click', refreshResults);
elements.addButton.addEventListener('click', openAddDialog);
elements.closeAddDialog.addEventListener('click', () => elements.addDialog.close());
elements.results.addEventListener('click', (event) => {
  const removeButton = event.target.closest('[data-remove-query]');
  if (!removeButton) return;
  const query = removeButton.dataset.removeQuery;
  const name = (state?.results || []).find((result) => result.query === query)?.name || query;
  pendingRemoval = query;
  elements.confirmTitle.textContent = `Remove ${name}?`;
  elements.confirmCopy.textContent = 'This removes the person and their cached results from the watch list.';
  elements.confirmAction.textContent = 'Remove person';
  elements.confirmDialog.showModal();
});
elements.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = normalizeQuery(elements.personQuery.value);
  elements.addDialog.close();
  if (!query) return;
  if (state.watchList.includes(query)) {
    setStatus(`Bib ${query} is already on your watch list.`);
    return;
  }
  state.watchList.push(query);
  saveState();
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
    renderAll();
    setStatus(`${query} removed from the watch list.`);
    pendingRemoval = null;
    elements.confirmDialog.close();
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  clearTimeout(changedIndicatorTimer);
  state = null;
  pendingEvent = null;
  elements.confirmDialog.close();
  elements.setupForm.reset();
  elements.eventPreviewTitle.textContent = '';
  setStatus('', 'info', elements.setupStatus);
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  showView('setup');
});

function eventLabelText() {
  return state.eventTitle ? `${state.eventTitle} · #${state.eventId}` : `#${state.eventId}`;
}

function openDashboard() {
  showView('dashboard');
  elements.eventLabel.textContent = eventLabelText();
  renderAll();
  scheduleChangedIndicatorReset();
  if (state.fetchedAt) {
    setStatus(`Last updated ${formatTime(state.fetchedAt)}. ${changeSummaryText(state.changedCount || 0)}`);
  }
}

function openResultsView() {
  showView('results');
  elements.resultsEventLabel.textContent = eventLabelText();
  renderResultsView();
}

// The results view lives at #results so the phone's back gesture returns to the watch list.
function route() {
  if (!state) showView('setup');
  else if (location.hash === '#results') openResultsView();
  else openDashboard();
}

elements.showResults.addEventListener('click', () => {
  history.pushState({ fromDashboard: true }, '', '#results');
  route();
  window.scrollTo(0, 0);
});
elements.backButton.addEventListener('click', () => {
  if (history.state?.fromDashboard) {
    history.back();
    return;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  route();
  window.scrollTo(0, 0);
});
window.addEventListener('popstate', route);

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A controller change while one was already active means a new version was deployed.
  // The very first install also fires it, but there is nothing to reload then.
  let hasController = Boolean(navigator.serviceWorker.controller);
  let reloadPending = false;
  const isBusy = () => Boolean(refreshInFlight || document.querySelector('dialog[open]'));
  const reloadWhenIdle = () => {
    if (!reloadPending) return;
    // Don't yank the page away mid-refresh or while a dialog is being filled in;
    // reload as soon as the app is hidden instead, where nobody sees it.
    if (document.visibilityState === 'visible' && isBusy()) return;
    reloadPending = false;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hasController) {
      hasController = true;
      return;
    }
    reloadPending = true;
    reloadWhenIdle();
  });
  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('./sw.js').catch(() => null);
    if (!registration) return;
    // Home-screen apps on iOS are usually resumed rather than relaunched, which skips the
    // browser's own update check, so check every time the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
      else reloadWhenIdle();
    });
  });
}

setupServiceWorker();
route();