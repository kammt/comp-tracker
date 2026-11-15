// All app state lives in one localStorage record so a reload never loses the event.
const STORAGE_KEY = 'comptracker-state';
const API_URL = 'https://scoring.dance/api/';

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
  liveEvents: document.querySelector('#live-events-list'),
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
  addTabs: [...document.querySelectorAll('#add-dialog [role="tab"]')],
  nameForm: document.querySelector('#name-form'),
  rosterCopy: document.querySelector('#roster-copy'),
  rosterButton: document.querySelector('#roster-button'),
  rosterButtonLabel: document.querySelector('#roster-button-label'),
  nameSearch: document.querySelector('#name-search'),
  nameQuery: document.querySelector('#name-query'),
  nameSuggestions: document.querySelector('#name-suggestions'),
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

// scoring.dance serves its data as JSON at /api/<method>.json (the same API it sells on
// RapidAPI). Errors come back as `err.id` other than 0, often with HTTP 200.
async function apiGet(method, params) {
  const response = await fetch(`${API_URL}${method}.json?${new URLSearchParams(params)}`, { cache: 'no-store' });
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`scoring.dance returned error code ${response.status}.`);
  }
  if (body?.err?.id) {
    const error = new Error(body.err.msg || `scoring.dance returned error ${body.err.id}.`);
    error.code = body.err.id;
    throw error;
  }
  if (!response.ok) throw new Error(`scoring.dance returned error code ${response.status}.`);
  return body.result;
}

const API_PARTICIPANT_NOT_FOUND = 95;
const ROLE_NAMES = { L: 'Leader', F: 'Follower' };

// Every round of the event, in running order. Round names are "<competition> <round>".
function fetchEventRounds(eventId) {
  return apiGet('rounds.list', { event: eventId }).then((rounds) => rounds || []);
}

async function fetchParticipant(eventId, query, eventRounds) {
  let info;
  try {
    info = await apiGet('participant.info', { event: eventId, bib: query });
  } catch (error) {
    if (error.code === API_PARTICIPANT_NOT_FOUND) throw new Error(`Bib number ${query} does not exist in event ${eventId}.`);
    throw error;
  }
  const competitions = (info.competitions || []).map((competition) => ({
    title: competition.name,
    role: ROLE_NAMES[competition.role] || competition.role || '',
    partner: competition.partner_name || '',
    rounds: competitionRounds(competition, eventRounds),
  }));
  return { query, name: info.name || query, competitions };
}

// A participant only lists the rounds they made it into, so the competition's other rounds
// (taken from the event's round list) are the ones they are out of.
function competitionRounds(competition, eventRounds) {
  const own = new Map((competition.rounds || []).filter((round) => !round.is_canceled).map((round) => [String(round.id), round]));
  const prefix = `${competition.name} `;
  const listed = eventRounds
    .filter((round) => round.name.startsWith(prefix))
    .map((round) => ({ id: String(round.id), name: round.name.slice(prefix.length).trim() }));
  const listedIds = new Set(listed.map((round) => round.id));
  const unlisted = [...own.values()].filter((round) => !listedIds.has(String(round.id))).map((round) => ({ id: String(round.id), name: round.type }));
  return [...listed, ...unlisted].map(({ id, name }) => {
    const round = own.get(id);
    const isIn = Boolean(round?.is_in);
    return { id, name, status: isIn ? 'in' : 'out', heat: isIn ? (round.heats || []).map((heat) => `heat${heat}`).join(' ') : '' };
  });
}

const PRELIM_SCORE_LABELS = { YES: 'Yes', NO: 'No' };

function prelimScoreLabel(value) {
  if (!value) return '';
  return PRELIM_SCORE_LABELS[value] || String(value).replace(/^A(\d+)$/, 'Alt$1');
}

function ordinal(number) {
  const tens = number % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[number % 10] || 'th';
  return `${number}${suffix}`;
}

// Prelims and semis have one list per role, finals a single list of couples.
// A chief judge only scores to break a tie, and that score is in `raws`.
async function fetchRoundResults(roundId) {
  const round = await apiGet('round.result', { round: roundId });
  const kind = round.is_final ? 'final' : 'callback';
  const tables = (round.lists || []).map((list) => ({
    judges: list.judges.map((judge) => ({ initials: judge.name.short, name: judge.name.long, chief: Boolean(judge.cj) })),
    rows: list.rows.map((row) => {
      const marks = (kind === 'final' ? row.places : row.prelimscores) || [];
      return {
        bib: String(row.dancer?.bib ?? ''),
        name: row.dancer?.fullname || '',
        partnerBib: String(row.partner?.bib ?? ''),
        partnerName: row.partner?.fullname || '',
        state: row.state || '',
        result: kind === 'final' ? ordinal(row.total) : String(row.total ?? ''),
        placement: kind === 'final' ? row.total : null,
        scores: list.judges.map((judge, index) => {
          const raw = row.raws?.[index];
          if (raw !== null && raw !== undefined) return { value: String(raw), tiebreak: true };
          const mark = marks[index];
          return { value: kind === 'final' ? String(mark ?? '') : prelimScoreLabel(mark), tiebreak: false };
        }),
      };
    }),
  })).filter((table) => table.rows.length);
  if (!tables.length) throw new Error(`No results found for round ${roundId}.`);
  return { id: String(roundId), kind, tables };
}

function findPersonResult(page, participant) {
  const bib = participant.query;
  for (const table of page.tables) {
    const row = table.rows.find((candidate) => candidate.bib === bib || candidate.partnerBib === bib);
    if (!row) continue;
    return {
      kind: page.kind,
      value: row.result,
      placement: row.placement,
      fieldSize: table.rows.length,
      state: row.state,
      partner: row.bib === bib ? row.partnerName : row.name,
      judges: table.judges.map((judge, index) => ({ ...judge, score: row.scores[index]?.value || '', tiebreak: Boolean(row.scores[index]?.tiebreak) })),
    };
  }
  return { notFound: true };
}

// One request returns every public event (a few hundred), newest first.
function fetchEvents() {
  return apiGet('events.list', { limit: 1000 }).then((events) => events || []);
}

async function fetchEvent(eventId) {
  const event = (await fetchEvents()).find((item) => String(item.id) === String(eventId));
  if (event) return String(event.name).trim();
  // Events left out of the public list can still have rounds.
  if ((await fetchEventRounds(eventId)).length) return `Event #${eventId}`;
  throw new Error('No event found for that ID.');
}

// The API gives the event's real start (local midnight) and end (local 23:59) as Unix times
// but not its time zone. Shifting each by 12 hours towards the middle of the event and
// reading the date in UTC gives the event's own calendar dates for any time zone.
function eventDates(event) {
  const start = new Date((event.start.unix + 12 * 3600) * 1000);
  const end = new Date((event.end.unix - 12 * 3600) * 1000);
  const format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return end > start ? format.formatRange(start, end) : format.format(start);
}

// Same rule as the scoring.dance start page's "Lists" button: the event is running right now.
async function fetchLiveEvents() {
  const now = Date.now() / 1000;
  return (await fetchEvents())
    .filter((event) => /^\d+$/.test(String(event.id)) && event.name && event.start?.unix <= now && now <= event.end?.unix)
    .map((event) => ({
      id: String(event.id),
      name: String(event.name).trim(),
      dates: eventDates(event),
      place: event.country || '',
    }));
}

// Fetches each published round the watched people danced in once, however many of them were in it.
async function fetchResultPages(eventRounds, participants) {
  const pages = new Map();
  const published = new Set(eventRounds.filter((round) => round.results_published).map((round) => String(round.id)));
  const roundIds = [...new Set(participants.flatMap((participant) => participant.competitions.flatMap((competition) => competition.rounds
    .filter((round) => round.status === 'in' && published.has(round.id))
    .map((round) => round.id))))];
  const settled = await Promise.allSettled(roundIds.map(fetchRoundResults));
  settled.forEach((item, index) => { if (item.status === 'fulfilled') pages.set(roundIds[index], item.value); });
  return { pages, failed: settled.filter((item) => item.status === 'rejected').length };
}

const ROSTER_SEARCH_LIMIT = 100;

// Builds the list of everyone competing, for searching by name. The API has no "list all"
// call: its participant search matches everyone with `q=%` but returns at most 100 people,
// so the start list of every round is read as well. The search still covers people whose
// start lists are not public yet.
async function fetchRoster(eventId) {
  const rounds = await fetchEventRounds(eventId);
  const [search, ...lists] = await Promise.allSettled([
    apiGet('participant.search', { event: eventId, q: '%', limit: ROSTER_SEARCH_LIMIT }),
    ...rounds.map((round) => apiGet('round.marshlist', { round: round.id })),
  ]);
  const people = new Map();
  const add = (bib, name) => {
    const key = String(bib ?? '').trim();
    const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
    if (key && cleanName && !people.has(key)) people.set(key, cleanName);
  };
  lists.filter((item) => item.status === 'fulfilled').forEach((item) => Object.values(item.value?.heats || {})
    .forEach((heat) => ['leader', 'follower'].forEach((role) => (heat?.[role] || []).forEach((person) => add(person.bib, person.name)))));
  const searchResults = search.status === 'fulfilled' ? search.value?.results || [] : [];
  searchResults.forEach((person) => add(person.bib, person.name));
  const listsLoaded = lists.some((item) => item.status === 'fulfilled');
  if (!listsLoaded && search.status === 'rejected') throw search.reason;
  return {
    eventId: String(eventId),
    fetchedAt: new Date().toISOString(),
    people: [...people].map(([bib, name]) => ({ bib, name })).sort((a, b) => a.name.localeCompare(b.name)),
    // Without any public start list only the search's first 100 people are known.
    partial: !listsLoaded && searchResults.length >= ROSTER_SEARCH_LIMIT,
  };
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
    // Without the round list people still load, just without the rounds they are out of.
    const eventRounds = await fetchEventRounds(current.eventId).catch(() => null);
    const settled = await Promise.allSettled(watchList.map((query) => fetchParticipant(current.eventId, query, eventRounds || [])));
    const loaded = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const resultsAvailable = eventRounds ? eventRounds.some((round) => round.results_published) : Boolean(current.resultsAvailable);
    let resultPages = null;
    let resultsFailed = resultsAvailable && !eventRounds;
    if (resultsAvailable && eventRounds && loaded.length) {
      setStatus('Loading results…');
      try {
        const fetched = await fetchResultPages(eventRounds, loaded);
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
        const participant = attachResults(item.value, resultPages, oldResult);
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
  const empty = (state?.watchList || []).length
    ? 'No results yet. Refresh the watch list once results are published.'
    : 'Add a person to your watch list to see their results.';
  elements.resultsList.innerHTML = blocks || `<div class="empty-state">${empty}</div>`;
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
  // Results are shown per watched person, so there is nothing to open until someone is added.
  const hasPeople = (state?.watchList || []).length > 0;
  elements.showResults.hidden = !(hasPeople && (state?.resultsAvailable || hasAnyResults()));
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

let addTab = 'bib';
let rosterLoading = false;
let rosterError = '';
let rosterIndex = { roster: null, entries: [] };
const MAX_SUGGESTIONS = 8;

function openAddDialog() {
  elements.personQuery.value = '';
  elements.nameQuery.value = '';
  rosterError = '';
  renderRosterStatus();
  renderNameSuggestions();
  elements.addDialog.showModal();
  selectAddTab(addTab);
}

function selectAddTab(tab) {
  addTab = tab;
  elements.addTabs.forEach((button) => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  elements.addForm.hidden = tab !== 'bib';
  elements.nameForm.hidden = tab !== 'name';
  if (tab === 'bib') elements.personQuery.focus();
  else (state?.roster ? elements.nameQuery : elements.rosterButton).focus();
}

function addToWatchList(query) {
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
}

function renderRosterStatus() {
  const roster = state?.roster;
  elements.rosterButton.disabled = rosterLoading;
  elements.rosterButton.classList.toggle('is-loading', rosterLoading);
  elements.rosterButtonLabel.textContent = rosterLoading ? 'Loading competitors…' : roster ? 'Reload list' : 'Load competitor list';
  elements.nameSearch.hidden = !roster;
  let copy;
  if (rosterLoading) copy = 'Loading the name and bib of everyone competing from scoring.dance…';
  else if (roster) {
    const count = roster.people.length;
    copy = `${count} competitor${count === 1 ? '' : 's'}, list loaded ${formatTime(roster.fetchedAt)}.`;
    if (roster.partial) copy += ` No start lists are public yet, so only the first ${ROSTER_SEARCH_LIMIT} registered people are included.`;
  } else copy = 'To search by name, first load the names and bibs of everyone competing at this event from scoring.dance.';
  elements.rosterCopy.textContent = rosterError ? `${rosterError} ${roster ? 'The list loaded earlier is still used.' : ''}`.trim() : copy;
  elements.rosterCopy.classList.toggle('is-error', Boolean(rosterError));
}

async function loadRoster() {
  if (rosterLoading || !state) return;
  const current = state;
  rosterLoading = true;
  rosterError = '';
  renderRosterStatus();
  try {
    const roster = await fetchRoster(current.eventId);
    if (state !== current) return;
    current.roster = roster;
    saveState();
  } catch (error) {
    rosterError = `Could not load the competitor list. ${error.message}`;
  } finally {
    rosterLoading = false;
    if (state) {
      renderRosterStatus();
      renderNameSuggestions();
      if (state.roster && elements.addDialog.open && addTab === 'name') elements.nameQuery.focus();
    }
  }
}

// Names are searched without accents or case, so "lukasz" finds "Łukasz".
function searchKey(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ø/g, 'o').replace(/ß/g, 'ss');
}

// The search key of a name plus, for each key character, where it came from in the name,
// so a match in the key can be highlighted in the original spelling.
function indexName(name) {
  let key = '';
  const starts = [];
  const ends = [];
  let position = 0;
  for (const character of name) {
    const part = searchKey(character);
    for (let index = 0; index < part.length; index += 1) {
      starts.push(position);
      ends.push(position + character.length);
    }
    key += part;
    position += character.length;
  }
  return { key, starts, ends };
}

function rosterEntries() {
  const roster = state?.roster || null;
  if (rosterIndex.roster !== roster) {
    rosterIndex = { roster, entries: (roster?.people || []).map((person) => ({ ...person, ...indexName(person.name) })) };
  }
  return rosterIndex.entries;
}

function isWordStart(key, index) {
  return index === 0 || !/[\p{L}\p{N}]/u.test(key[index - 1]);
}

// Every typed word has to appear somewhere in the name; names where the words start
// a first or last name come first.
function matchRoster(query) {
  const words = searchKey(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return [];
  return rosterEntries().map((entry) => {
    let wordStarts = 0;
    const ranges = [];
    for (const word of words) {
      const first = entry.key.indexOf(word);
      if (first < 0) return null;
      let index = first;
      while (index >= 0 && !isWordStart(entry.key, index)) index = entry.key.indexOf(word, index + 1);
      if (index >= 0) wordStarts += 1;
      else index = first;
      ranges.push([entry.starts[index], entry.ends[index + word.length - 1]]);
    }
    return { entry, wordStarts, ranges };
  }).filter(Boolean).sort((a, b) => b.wordStarts - a.wordStarts || a.entry.name.localeCompare(b.entry.name));
}

function highlightName(name, ranges) {
  const merged = [...ranges].sort((a, b) => a[0] - b[0]).reduce((list, range) => {
    const last = list[list.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else list.push([...range]);
    return list;
  }, []);
  let html = '';
  let position = 0;
  for (const [start, end] of merged) {
    html += `${escapeHtml(name.slice(position, start))}<mark>${escapeHtml(name.slice(start, end))}</mark>`;
    position = end;
  }
  return html + escapeHtml(name.slice(position));
}

function renderNameSuggestions() {
  const query = elements.nameQuery.value.trim();
  const matches = state?.roster && query ? matchRoster(query) : [];
  if (!state?.roster || !query) {
    elements.nameSuggestions.innerHTML = '';
    return;
  }
  if (!matches.length) {
    elements.nameSuggestions.innerHTML = `<p class="suggestions-empty">No competitor matches “${escapeHtml(query)}”.</p>`;
    return;
  }
  const more = matches.length - MAX_SUGGESTIONS;
  elements.nameSuggestions.innerHTML = matches.slice(0, MAX_SUGGESTIONS).map(({ entry, ranges }) => {
    const tracked = state.watchList.includes(entry.bib);
    return `<button class="suggestion" type="button" data-bib="${escapeHtml(entry.bib)}"><span class="suggestion-name">${highlightName(entry.name, ranges)}</span>${tracked ? '<span class="suggestion-tag">On list</span>' : ''}<span class="suggestion-bib">#${escapeHtml(entry.bib)}</span></button>`;
  }).join('') + (more > 0 ? `<p class="suggestions-empty">${more} more. Keep typing to narrow it down.</p>` : '');
}

let liveEventsRequest = 0;

async function loadLiveEvents() {
  const request = ++liveEventsRequest;
  elements.liveEvents.innerHTML = '<p class="live-events-note is-loading">Loading current events…</p>';
  let markup;
  try {
    const events = await fetchLiveEvents();
    markup = events.length
      ? events.map(renderLiveEvent).join('')
      : '<p class="live-events-note">No events have lists open right now.</p>';
  } catch (error) {
    markup = '<p class="live-events-note">Could not load current events from scoring.dance. You can still enter an event ID below.</p>';
  }
  if (request === liveEventsRequest) elements.liveEvents.innerHTML = markup;
}

function renderLiveEvent(event) {
  const meta = [event.dates, event.place].filter(Boolean).map(escapeHtml).join(' · ');
  return `<button class="live-event" type="button" data-event-id="${escapeHtml(event.id)}" data-event-title="${escapeHtml(event.name)}">
      <span class="live-event-copy"><strong class="live-event-name">${escapeHtml(event.name)}</strong><span class="live-event-meta">${meta ? `${meta} · ` : ''}#${escapeHtml(event.id)}</span></span>
      <span class="live-event-arrow" aria-hidden="true">→</span>
    </button>`;
}

function startEvent(eventId, eventTitle) {
  state = { version: 1, eventId, eventTitle, watchList: [], results: [], fetchedAt: null, changedCount: 0 };
  pendingEvent = null;
  saveState();
  openDashboard();
  window.scrollTo(0, 0);
}

function openSetup() {
  showView('setup');
  loadLiveEvents();
}

elements.liveEvents.addEventListener('click', (event) => {
  const button = event.target.closest('[data-event-id]');
  if (button) startEvent(button.dataset.eventId, button.dataset.eventTitle);
});

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
  const { eventId, eventTitle } = pendingEvent;
  elements.eventPreviewDialog.close();
  startEvent(eventId, eventTitle);
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
  addToWatchList(normalizeQuery(elements.personQuery.value));
});
elements.addTabs.forEach((tab) => tab.addEventListener('click', () => selectAddTab(tab.dataset.tab)));
elements.rosterButton.addEventListener('click', loadRoster);
elements.nameQuery.addEventListener('input', renderNameSuggestions);
elements.nameSuggestions.addEventListener('click', (event) => {
  const suggestion = event.target.closest('[data-bib]');
  if (suggestion) addToWatchList(suggestion.dataset.bib);
});
// The keyboard's Go/Enter key picks the top suggestion.
elements.nameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const first = elements.nameSuggestions.querySelector('[data-bib]');
  if (first) addToWatchList(first.dataset.bib);
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
  openSetup();
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
  if (!state) {
    if (elements.setup.hidden) openSetup();
  }
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