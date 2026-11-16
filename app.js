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
  resetButtons: document.querySelectorAll('.reset-event-button'),
  roundsActions: document.querySelector('#rounds-actions'),
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
  backLabel: document.querySelector('#back-label'),
  viewTabs: document.querySelector('#view-tabs'),
  viewTabButtons: [...document.querySelectorAll('[data-view-tab]')],
  roundsView: document.querySelector('#rounds-view'),
  roundsBack: document.querySelector('#rounds-back-button'),
  roundsBackLabel: document.querySelector('#rounds-back-label'),
  roundsEventLabel: document.querySelector('#rounds-event-label'),
  roundsTitle: document.querySelector('#rounds-title'),
  roundsSubtitle: document.querySelector('#rounds-subtitle'),
  roundsRefresh: document.querySelector('#rounds-refresh-button'),
  roundsStatus: document.querySelector('#rounds-status'),
  roundsNote: document.querySelector('#rounds-note'),
  roundsContent: document.querySelector('#rounds-content'),
  pullIndicator: document.querySelector('#pull-indicator'),
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

// `tab` is the tab bar entry to highlight; the tab bar only shows on the two top-level pages.
function showView(view, tab = null) {
  elements.setup.hidden = view !== 'setup';
  elements.dashboard.hidden = view !== 'dashboard';
  elements.resultsView.hidden = view !== 'results';
  elements.roundsView.hidden = view !== 'rounds';
  elements.viewTabs.hidden = !tab;
  elements.addButton.hidden = view !== 'dashboard';
  document.body.classList.toggle('has-fab', view === 'dashboard');
  // On phones the tab bar is pinned to the bottom, so the page needs room below its content.
  document.body.classList.toggle('has-tab-bar', Boolean(tab));
  elements.viewTabButtons.forEach((button) => button.setAttribute('aria-selected', String(button.dataset.viewTab === tab)));
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
  const lists = round.lists || [];
  const roleLabels = kind === 'callback' && lists.length === 2 ? ['Leaders', 'Followers'] : [];
  const tables = lists.map((list, listIndex) => ({
    label: roleLabels[listIndex] || '',
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

const API_LIST_NOT_PUBLIC = 87;

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

// Heat lists of a round that has not published results yet. In couple competitions
// (Strictly, routines) the couple dances under the leader's bib, so followers have none and
// list position pairs them up. In Jack&Jill rounds the two lists are independent.
async function fetchMarshalList(roundId) {
  let list;
  try {
    list = await apiGet('round.marshlist', { round: roundId });
  } catch (error) {
    if (error.code === API_LIST_NOT_PUBLIC) throw new Error('The heat lists for this round are not public yet.');
    throw error;
  }
  const person = (entry) => ({
    bib: entry?.bib === null || entry?.bib === undefined ? '' : String(entry.bib),
    name: cleanName(entry?.name),
    scratched: Boolean(entry?.scratched),
    // "(1/2)": this person dances twice in the round (here for the first time).
    twice: (String(entry?.hoh || '').match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/'),
  });
  const heats = Object.entries(list?.heats || {})
    .map(([key, heat]) => ({ number: Number(heat?.heat ?? key), leaders: (heat?.leader || []).map(person), followers: (heat?.follower || []).map(person) }))
    .filter((heat) => heat.leaders.length || heat.followers.length)
    .sort((a, b) => a.number - b.number);
  if (!heats.length) throw new Error('The heat lists for this round are empty.');
  const couples = heats.every((heat) => heat.followers.length === heat.leaders.length && heat.followers.every((follower) => !follower.bib));
  return { id: String(roundId), heats, couples };
}

// The event's round list, reduced to what the app shows and keeps offline.
function slimRound(round) {
  return {
    id: String(round.id),
    name: cleanName(round.name),
    heats: Number(round.heats) || 0,
    published: Boolean(round.results_published),
    start: round.start && !round.start.hidden ? round.start.iso8601 || null : null,
  };
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
    if (eventRounds) {
      current.rounds = eventRounds.map(slimRound);
      current.roundsFetchedAt = new Date().toISOString();
    }
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

function roundInfo(roundId) {
  return (state?.rounds || []).find((round) => round.id === String(roundId)) || null;
}

function renderParticipantBody(participant) {
  const competitions = (participant.competitions || []).map((competition) => renderCompetition(competition, participant)).join('');
  if (!participant.error) return competitions || '<p class="participant-error">No competition details found.</p>';
  const prefix = competitions ? 'Showing cached results. ' : '';
  return `<p class="participant-error">${escapeHtml(prefix + participant.error)}</p>${competitions}`;
}

// Each round opens its heat lists, or this person's scores once results are out.
function renderCompetition(competition, participant) {
  return `<section class="competition"><h3 class="competition-title">${escapeHtml(competition.title)}</h3>${competition.role ? `<p class="meta-line">Role: ${escapeHtml(competition.role)}</p>` : ''}${competition.partner ? `<p class="meta-line">Partner: ${escapeHtml(competition.partner)}</p>` : ''}<div class="rounds">${competition.rounds.map((round) => {
    const label = `${competition.title} ${round.name}: ${isRoundPublished(round) ? 'show results' : 'show heat lists'}`;
    return `<button class="round round-link" type="button" data-open-round="${escapeHtml(round.id || '')}" data-bib="${escapeHtml(participant.query)}" data-heat="${escapeHtml((String(round.heat || '').match(/\d+/) || [''])[0])}" aria-label="${escapeHtml(label)}"><span class="round-name">${escapeHtml(round.name)}</span><span class="round-status ${round.status}">${round.status === 'in' ? '✓ In' : '× Out'}</span>${round.heat ? `<span class="heat">${escapeHtml(round.heat)}</span>` : ''}${renderRoundResultChip(round.result)}</button>`;
  }).join('')}</div></section>`;
}

function isRoundPublished(round) {
  const info = roundInfo(round.id);
  return info ? info.published : hasResult(round.result);
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
    return `<span class="round-result final ${placeClass(result.placement)}">${escapeHtml(result.value)}<small> of ${result.fieldSize}</small></span>`;
  }
  const outcome = callbackOutcome(result);
  return `<span class="round-result ${outcome.kind}">${outcome.short}${result.value ? ` · Σ${escapeHtml(result.value)}` : ''}</span>`;
}

// Gold, silver and bronze for the podium, one highlight for 4th and 5th place.
function placeClass(placement) {
  const place = Number(placement);
  return place >= 1 && place <= 5 ? `place-${place}` : '';
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
  const body = competitions.map((competition) => renderCompetitionResults(competition, participant)).join('') || '<p class="participant-error">No competition details found.</p>';
  return `<article class="participant" data-focus-key="${escapeHtml(participant.query)}">
      <header class="participant-header"><div><h2 class="participant-name">${escapeHtml(participant.name)}</h2><span class="bib">Bib ${escapeHtml(participant.query)}</span></div></header>
      ${body}
    </article>`;
}

function renderCompetitionResults(competition, participant) {
  const danced = competition.rounds.filter((round) => round.status === 'in');
  const final = danced.find((round) => hasResult(round.result) && round.result.kind === 'final');
  const meta = [competition.role, competition.partner && `Partner: ${competition.partner}`].filter(Boolean).map(escapeHtml).join(' · ');
  // Newest round first, so the final (the result that matters most) leads.
  const rounds = [...danced].reverse().map((round) => renderRoundResults(round, participant)).join('');
  const hero = final ? `<div class="placement-hero ${placeClass(final.result.placement)}"><span class="placement-number">${renderPlacement(final.result.value)}</span><span class="placement-copy"><strong>Final placement</strong><span>of ${final.result.fieldSize}${final.result.partner ? ` · with ${escapeHtml(final.result.partner)}` : ''}</span></span></div>` : '';
  return `<section class="competition"><h3 class="competition-title">${escapeHtml(competition.title)}</h3>${meta ? `<p class="meta-line">${meta}</p>` : ''}${hero}${rounds}</section>`;
}

function renderRoundResults(round, participant) {
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
  const fullResults = round.id ? `<button class="text-button round-results-link" type="button" data-open-round="${escapeHtml(round.id)}" data-bib="${escapeHtml(participant.query)}">${hasResult(result) ? 'Everyone in this round' : 'Heat lists'} ›</button>` : '';
  return `<div class="round-results" data-focus-key="${escapeHtml(`${participant.query}:${round.id}`)}"><div class="round-results-head"><span class="round-name">${escapeHtml(round.name)}</span>${outcome}</div>${partner}${judges}${fullResults}</div>`;
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
  if (!elements.roundsView.hidden) renderRoundsView();
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
elements.resetButtons.forEach((button) => button.addEventListener('click', () => {
  pendingRemoval = null;
  elements.confirmTitle.textContent = 'Reset this event?';
  elements.confirmCopy.textContent = 'This removes the saved event, watch list, and cached results from this device.';
  elements.confirmAction.textContent = 'Reset everything';
  elements.confirmDialog.showModal();
}));
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
  showView('dashboard', 'dashboard');
  elements.eventLabel.textContent = eventLabelText();
  renderAll();
  scheduleChangedIndicatorReset();
  if (state.fetchedAt) {
    setStatus(`Last updated ${formatTime(state.fetchedAt)}. ${changeSummaryText(state.changedCount || 0)}`);
  }
}

function openResultsView(params) {
  showView('results');
  elements.resultsEventLabel.textContent = eventLabelText();
  elements.backLabel.textContent = backLabelText('Watch list');
  renderResultsView();
  const bib = params.get('bib');
  if (bib) focusElement(elements.resultsList, params.get('round') ? `${bib}:${params.get('round')}` : bib);
}

// Marks the person (or their round) the user came for and scrolls it into view.
function focusElement(container, key) {
  const target = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)
    || container.querySelector(`[data-focus-key="${CSS.escape(key.split(':')[0])}"]`);
  if (!target) return;
  target.classList.add('is-focused');
  requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
}

// ---- All rounds: every round's heat lists, or its full results once published ----

const roundLoads = new Map();
const roundErrors = new Map();
let roundsLoading = null;
let roundsError = '';
let roundsParams = new URLSearchParams();
// The person to scroll to once the round's lists have loaded.
let pendingRoundFocus = '';

function roundCompetition(name) {
  const match = name.match(/^(.*\S)\s+(\S+)$/);
  return match ? { competition: match[1], round: match[2] } : { competition: name, round: '' };
}

// The schedule's own local time ("Sat 17:10"), whatever time zone the phone is in.
function roundTime(iso) {
  const match = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return '';
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${match[1]}T12:00:00Z`));
  return `${weekday} ${match[2]}`;
}

function loadRounds() {
  if (roundsLoading || !state) return roundsLoading;
  const current = state;
  roundsError = '';
  setRoundsRefreshing();
  roundsLoading = fetchEventRounds(current.eventId)
    .then((rounds) => {
      if (state !== current) return;
      current.rounds = rounds.map(slimRound);
      current.roundsFetchedAt = new Date().toISOString();
      saveState();
    })
    .catch((error) => { roundsError = `Could not load the rounds of this event. ${error.message}`; })
    .finally(() => {
      roundsLoading = null;
      setRoundsRefreshing();
      if (state === current && !elements.roundsView.hidden) {
        renderRoundsView();
        const roundId = roundsParams.get('round');
        if (roundId) loadRoundDetail(roundId);
      }
    });
  return roundsLoading;
}

function wantedRoundKind(roundId) {
  return roundInfo(roundId)?.published ? 'results' : 'marshal';
}

// Fetches a round's heat lists or results. Without `force`, a copy of the right kind
// already on this device is used, so opening a round does not hit scoring.dance again.
function loadRoundDetail(roundId, force = false) {
  if (!state || roundLoads.has(roundId)) return;
  if (!state.rounds) {
    loadRounds();
    return;
  }
  const kind = wantedRoundKind(roundId);
  const cached = state.roundCache?.[roundId];
  if (!force && cached?.kind === kind) return;
  const current = state;
  roundErrors.delete(roundId);
  const request = (kind === 'results' ? fetchRoundResults(roundId) : fetchMarshalList(roundId))
    .then((data) => {
      if (state !== current) return;
      current.roundCache = { ...(current.roundCache || {}), [roundId]: { kind, fetchedAt: new Date().toISOString(), data } };
      saveState();
    })
    .catch((error) => roundErrors.set(roundId, error.message))
    .finally(() => {
      roundLoads.delete(roundId);
      setRoundsRefreshing();
      if (state === current && !elements.roundsView.hidden && roundsParams.get('round') === roundId) renderRoundsView();
    });
  roundLoads.set(roundId, request);
  setRoundsRefreshing();
}

function setRoundsRefreshing() {
  const busy = Boolean(roundsLoading || roundLoads.size);
  elements.roundsRefresh.disabled = busy;
  elements.roundsRefresh.classList.toggle('is-loading', busy);
}

// Watched people by the rounds they dance in, for marking them in lists.
function watchedByRound() {
  const byRound = new Map();
  (state?.results || []).forEach((participant) => (participant.competitions || []).forEach((competition) => competition.rounds.forEach((round) => {
    if (round.status !== 'in' || !round.id) return;
    if (!byRound.has(round.id)) byRound.set(round.id, []);
    byRound.get(round.id).push(participant);
  })));
  return byRound;
}

// Followers in couple competitions have no bib of their own, so they are matched by name.
function watchedMatcher() {
  const bibs = new Set(state?.watchList || []);
  const names = new Map((state?.results || []).filter((participant) => participant.name !== participant.query).map((participant) => [searchKey(participant.name), participant.query]));
  return (person) => (person.bib && bibs.has(person.bib) ? person.bib : names.get(searchKey(person.name)) || '');
}

function openRoundsView(params) {
  roundsParams = params;
  const roundId = params.get('round');
  showView('rounds', roundId ? null : 'rounds');
  elements.roundsEventLabel.textContent = eventLabelText();
  elements.roundsBack.hidden = !roundId;
  elements.roundsBackLabel.textContent = backLabelText('All rounds');
  setStatus('', 'info', elements.roundsStatus);
  if (!state.rounds) loadRounds();
  else if (roundId) loadRoundDetail(roundId);
  pendingRoundFocus = (roundId && params.get('bib')) || '';
  renderRoundsView();
}

function renderRoundsView() {
  const roundId = roundsParams.get('round');
  setStatus(roundsError, 'error', elements.roundsStatus);
  // Reset sits at the bottom of the round list only, not inside a single round.
  elements.roundsActions.hidden = Boolean(roundId);
  if (roundId) renderRoundDetail(roundId);
  else renderRoundIndex();
}

function renderRoundIndex() {
  elements.roundsTitle.textContent = 'All rounds';
  elements.roundsTitle.classList.remove('is-round');
  elements.roundsSubtitle.hidden = true;
  const rounds = state.rounds || [];
  elements.roundsNote.textContent = state.roundsFetchedAt
    ? `Tap a round to see who dances in which heat, or everyone's results once they are published. Round list loaded ${formatTime(state.roundsFetchedAt)}.`
    : "Tap a round to see who dances in which heat, or everyone's results once they are published.";
  if (!rounds.length) {
    elements.roundsContent.innerHTML = roundsLoading
      ? '<div class="empty-state is-loading">Loading rounds…</div>'
      : '<div class="empty-state">No rounds found for this event yet.</div>';
    return;
  }
  const watched = watchedByRound();
  const competitions = new Map();
  rounds.forEach((round) => {
    const { competition } = roundCompetition(round.name);
    if (!competitions.has(competition)) competitions.set(competition, []);
    competitions.get(competition).push(round);
  });
  elements.roundsContent.innerHTML = `<article class="participant">${[...competitions].map(([competition, items]) => `<section class="competition"><h3 class="competition-title">${escapeHtml(competition)}</h3><div class="rounds">${items.map((round) => {
    const people = watched.get(round.id) || [];
    const kind = round.published ? '<span class="round-kind results">Results</span>' : round.heats ? `<span class="round-kind heats">${round.heats} heat${round.heats === 1 ? '' : 's'}</span>` : '<span class="round-kind pending">Not out yet</span>';
    const time = roundTime(round.start);
    return `<button class="round round-link" type="button" data-open-round="${escapeHtml(round.id)}"><span class="round-name">${escapeHtml(roundCompetition(round.name).round || round.name)}</span><span class="round-meta">${kind}${time ? `<span class="round-time">${escapeHtml(time)}</span>` : ''}</span>${people.length ? `<span class="round-watch" title="${escapeHtml(people.map((person) => person.name).join(', '))}">${people.length} of yours</span>` : ''}</button>`;
  }).join('')}</div></section>`).join('')}</article>`;
}

function renderRoundDetail(roundId) {
  const info = roundInfo(roundId);
  const name = info?.name || `Round #${roundId}`;
  const { competition, round } = roundCompetition(name);
  elements.roundsTitle.textContent = competition;
  elements.roundsTitle.classList.add('is-round');
  const cached = state.roundCache?.[roundId];
  const kind = state.rounds ? wantedRoundKind(roundId) : cached?.kind;
  const time = roundTime(info?.start);
  elements.roundsSubtitle.innerHTML = [round && `<strong>${escapeHtml(round)}</strong>`, kind === 'results' ? 'Results' : 'Heat lists', time && escapeHtml(time)].filter(Boolean).join(' · ');
  elements.roundsSubtitle.hidden = false;
  const loading = roundLoads.has(roundId) || (!state.rounds && roundsLoading);
  const error = roundErrors.get(roundId);
  const usable = cached && (!kind || cached.kind === kind) ? cached : null;
  const noun = kind === 'results' ? 'Results' : 'Heat lists';
  elements.roundsNote.textContent = usable ? `${noun} loaded ${formatTime(usable.fetchedAt)}. They do not refresh automatically; pull down or use ↻ to check for changes.` : '';
  if (error) setStatus(`${error}${usable ? ' Showing the copy loaded earlier.' : ''}`, usable ? 'error' : 'info', elements.roundsStatus);
  if (!usable) {
    elements.roundsContent.innerHTML = loading
      ? `<div class="empty-state is-loading">Loading ${noun.toLowerCase()}…</div>`
      : `<div class="empty-state">${escapeHtml(error ? 'Nothing to show yet. Use ↻ to try again later.' : `No ${noun.toLowerCase()} loaded.`)}</div>`;
    return;
  }
  elements.roundsContent.innerHTML = usable.kind === 'results' ? renderRoundStandings(usable.data) : renderMarshalList(usable.data);
  if (pendingRoundFocus && !loading) {
    focusElement(elements.roundsContent, pendingRoundFocus);
    pendingRoundFocus = '';
  }
}

function personEntry(person, matchWatched) {
  const watched = matchWatched(person);
  const classes = ['lineup-person', watched && 'is-watched', person.scratched && 'is-scratched'].filter(Boolean).join(' ');
  const twice = person.twice ? `<span class="lineup-tag" title="Dances twice in this round; this is time ${escapeHtml(person.twice.replace('/', ' of '))}">${escapeHtml(person.twice)}</span>` : '';
  return { watched, html: `<span class="lineup-bib">${escapeHtml(person.bib || '')}</span><span class="lineup-name">${escapeHtml(person.name)}${person.scratched ? ' <em>scratched</em>' : ''}</span>${twice}`, classes };
}

function renderMarshalList(data) {
  const matchWatched = watchedMatcher();
  const focusBib = roundsParams.get('bib') || '';
  const heatHasWatched = (heat) => [...heat.leaders, ...heat.followers].some((person) => matchWatched(person));
  const heatHas = (heat, bib) => [...heat.leaders, ...heat.followers].some((person) => matchWatched(person) === bib);
  const requested = Number(roundsParams.get('heat'));
  const heat = data.heats.find((item) => item.number === requested)
    || (focusBib && data.heats.find((item) => heatHas(item, focusBib)))
    || data.heats.find(heatHasWatched)
    || data.heats[0];
  const tabs = data.heats.length > 1 ? `<div class="tabs heat-tabs" role="tablist" aria-label="Heat">${data.heats.map((item) => `<button class="tab" type="button" role="tab" aria-selected="${item === heat}" data-heat-tab="${item.number}">Heat ${item.number}${heatHasWatched(item) ? '<span class="heat-dot" aria-label=" (your people dance here)"></span>' : ''}</button>`).join('')}</div>` : '';
  const item = (person) => {
    const entry = personEntry(person, matchWatched);
    return `<li class="${entry.classes}"${entry.watched ? ` data-focus-key="${escapeHtml(entry.watched)}"` : ''}>${entry.html}</li>`;
  };
  let body;
  if (data.couples) {
    body = `<ol class="lineup couples">${heat.leaders.map((leader, index) => {
      const follower = heat.followers[index] || { bib: '', name: '' };
      const lead = personEntry(leader, matchWatched);
      const follow = personEntry({ ...follower, bib: '' }, matchWatched);
      const watched = lead.watched || follow.watched;
      const scratched = leader.scratched || follower.scratched;
      return `<li class="lineup-person${watched ? ' is-watched' : ''}${scratched ? ' is-scratched' : ''}"${watched ? ` data-focus-key="${escapeHtml(watched)}"` : ''}><span class="lineup-bib">${escapeHtml(leader.bib)}</span><span class="lineup-name">${escapeHtml(leader.name)} <span class="lineup-amp">&amp;</span> ${escapeHtml(follower.name)}${scratched ? ' <em>scratched</em>' : ''}</span></li>`;
    }).join('')}</ol>`;
  } else {
    const column = (title, people) => `<section class="lineup-column"><h4 class="lineup-title">${title} <span>${people.length}</span></h4><ol class="lineup">${people.map(item).join('')}</ol></section>`;
    body = `<div class="lineup-columns">${column('Leaders', heat.leaders)}${column('Followers', heat.followers)}</div>`;
  }
  const twiceNote = [...heat.leaders, ...heat.followers].some((person) => person.twice) ? '<p class="field-note lineup-note">1/2 and 2/2 mark people who dance twice in this round.</p>' : '';
  const heading = `<h3 class="competition-title">Heat ${heat.number}${data.heats.length > 1 ? ` <span class="of-heats">of ${data.heats.length}</span>` : ''}</h3>`;
  return `${tabs}<article class="participant"><div class="competition">${heading}${body}${twiceNote}</div></article>`;
}

function shortMark(value, kind) {
  if (kind === 'final') return value;
  if (/^yes$/i.test(value)) return 'Y';
  if (/^no$/i.test(value)) return 'N';
  return value.replace(/^Alt/i, 'A');
}

function renderRoundStandings(data) {
  const matchWatched = watchedMatcher();
  const tables = data.tables.map((table) => {
    // The chief judge's column is usually empty: it only scores to break a tie.
    const shown = table.judges.map((judge, index) => ({ ...judge, index })).filter((judge) => table.rows.some((row) => row.scores[judge.index]?.value));
    const legend = `<p class="judge-legend">${shown.map((judge) => `<abbr title="${escapeHtml(judge.name)}">${judge.chief ? '♛' : ''}${escapeHtml(judge.initials)}</abbr>`).join('<span aria-hidden="true"> · </span>')}</p>`;
    const totals = table.rows.map((row) => Number(row.result) || 0);
    const rows = table.rows.map((row, index) => {
      const watched = matchWatched({ bib: row.bib, name: row.name }) || matchWatched({ bib: row.partnerBib, name: row.partnerName });
      const rank = data.kind === 'final' ? row.placement || index + 1 : 1 + totals.filter((total) => total > totals[index]).length;
      const outcome = data.kind === 'final'
        ? ''
        : (() => { const callback = callbackOutcome(row); return `<span class="round-result ${callback.kind}">${callback.short}${row.result ? ` · Σ${escapeHtml(row.result)}` : ''}</span>`; })();
      const marks = shown.map((judge) => {
        const score = row.scores[judge.index] || { value: '' };
        const value = score.value ? shortMark(score.value, data.kind) : '–';
        return `<span class="mark ${judgeScoreKind(score.value)}${score.tiebreak ? ' tiebreak' : ''}" title="${escapeHtml(`${judge.name}: ${score.value || 'no score'}${score.tiebreak ? ' (tie-break)' : ''}`)}">${escapeHtml(value)}</span>`;
      }).join('');
      // A couple is two equal names, one per line: neither partner is the "main" one.
      const dancer = (name, bib) => `<span class="standing-name">${escapeHtml(name)}${bib ? ` <span class="standing-bib">#${escapeHtml(bib)}</span>` : ''}</span>`;
      const names = dancer(row.name, row.bib) + (row.partnerName ? dancer(row.partnerName, row.partnerBib) : '');
      const place = data.kind === 'final' ? placeClass(rank) : '';
      return `<li class="standing${watched ? ' is-watched' : ''}${place ? ` ${place}` : ''}"${watched ? ` data-focus-key="${escapeHtml(watched)}"` : ''}><span class="standing-rank">${data.kind === 'final' ? renderPlacement(ordinal(rank)) : rank}</span><span class="standing-main">${names}<span class="standing-marks">${marks}</span></span>${outcome}</li>`;
    }).join('');
    const label = table.label ? `<h3 class="competition-title">${table.label} <span class="of-heats">${table.rows.length}</span></h3>` : '';
    return `<article class="participant"><div class="competition">${label}${legend}<ol class="standings">${rows}</ol></div></article>`;
  });
  return tables.join('');
}

function backLabelText(fallback) {
  return { dashboard: 'Watch list', rounds: 'All rounds', results: 'Results' }[history.state?.from] || fallback;
}

function currentPage() {
  return location.hash.slice(1).split('?')[0];
}

// Pages live in the URL hash (#results, #rounds?round=…) so the phone's back gesture works.
function route() {
  const [page, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  if (!state) {
    if (elements.setup.hidden) openSetup();
  }
  else if (page === 'results') openResultsView(params);
  else if (page === 'rounds') openRoundsView(params);
  else openDashboard();
}

function navigate(hash, from) {
  history.pushState({ from }, '', hash);
  route();
  if (!new URLSearchParams(hash.split('?')[1] || '').get('bib')) window.scrollTo(0, 0);
}

function pageHash(page, params) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  return `#${page}${query ? `?${query}` : ''}`;
}

// From the watch list or results: rounds with published results jump to that person's
// scores, other rounds open the heat lists on the person's heat.
function openRoundFor(button, from) {
  const roundId = button.dataset.openRound;
  if (!roundId) return;
  const bib = button.dataset.bib || '';
  const participant = (state?.results || []).find((item) => item.query === bib);
  const round = participant?.competitions?.flatMap((competition) => competition.rounds).find((item) => item.id === roundId);
  if (from === 'dashboard' && round?.status === 'in' && isRoundPublished(round)) {
    navigate(pageHash('results', { bib, round: roundId }), from);
    return;
  }
  navigate(pageHash('rounds', { round: roundId, bib, heat: button.dataset.heat }), from);
}

elements.results.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-round]');
  if (button) openRoundFor(button, 'dashboard');
});
elements.resultsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-round]');
  if (button) openRoundFor(button, 'results');
});
elements.roundsContent.addEventListener('click', (event) => {
  const roundButton = event.target.closest('[data-open-round]');
  if (roundButton) {
    navigate(pageHash('rounds', { round: roundButton.dataset.openRound }), 'rounds');
    return;
  }
  const heatTab = event.target.closest('[data-heat-tab]');
  if (heatTab) {
    const params = new URLSearchParams(roundsParams);
    params.set('heat', heatTab.dataset.heatTab);
    history.replaceState(history.state, '', `#rounds?${params}`);
    roundsParams = params;
    renderRoundsView();
  }
});
elements.viewTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-view-tab]');
  if (!tab || tab.getAttribute('aria-selected') === 'true') return;
  history.replaceState(null, '', tab.dataset.viewTab === 'rounds' ? '#rounds' : `${location.pathname}${location.search}`);
  route();
  window.scrollTo(0, 0);
});
async function refreshRounds() {
  await loadRounds();
  const roundId = roundsParams.get('round');
  if (roundId && currentPage() === 'rounds') {
    loadRoundDetail(roundId, true);
    await roundLoads.get(roundId);
  }
}
elements.roundsRefresh.addEventListener('click', refreshRounds);

elements.showResults.addEventListener('click', () => navigate('#results', 'dashboard'));
function goBack(fallbackHash) {
  if (history.state?.from) {
    history.back();
    return;
  }
  history.replaceState(null, '', fallbackHash || `${location.pathname}${location.search}`);
  route();
  window.scrollTo(0, 0);
}
elements.backButton.addEventListener('click', () => goBack());
elements.roundsBack.addEventListener('click', () => goBack('#rounds'));
window.addEventListener('popstate', route);

// ---- Pull to refresh ----
// A browser's own pull-to-refresh reloads the page, which only shows the cached results.
// styles.css turns it off (overscroll-behavior) and this gesture runs the app's refresh instead.
// Where the browser's gesture can't be turned off, the reload itself fetches fresh results (see below).
const PULL_THRESHOLD = 72;
const PULL_MAX = 110;
const PULL_REST = 60;
const APP_RELOAD_KEY = 'comptracker-app-reload';

// What "refresh" means on the page that is showing; an update already running is reused.
function refreshCurrentView() {
  if (!elements.setup.hidden) return loadLiveEvents();
  if (!state) return Promise.resolve();
  if (!elements.roundsView.hidden) return refreshRounds();
  return refreshInFlight || refreshResults();
}

function setupPullToRefresh() {
  const indicator = elements.pullIndicator;
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let tracking = false;
  let pulling = false;
  let busy = false;

  const show = (pull, dragging) => {
    indicator.classList.toggle('is-dragging', dragging);
    indicator.classList.toggle('is-armed', dragging && pull >= PULL_THRESHOLD);
    indicator.style.setProperty('--pull', `${pull}px`);
    indicator.style.setProperty('--pull-turn', `${(pull / PULL_THRESHOLD) * 270}deg`);
    indicator.style.opacity = String(Math.min(1, pull / (PULL_THRESHOLD * 0.6)));
  };
  const stop = () => {
    tracking = false;
    if (!pulling) return false;
    pulling = false;
    return true;
  };

  document.addEventListener('touchstart', (event) => {
    tracking = !busy && event.touches.length === 1 && window.scrollY <= 0 && !document.querySelector('dialog[open]');
    if (!tracking) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    distance = 0;
  }, { passive: true });

  // Not passive: the pull has to cancel the browser's own scroll (and on iOS, its bounce and pull-to-refresh).
  document.addEventListener('touchmove', (event) => {
    if (!tracking) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!pulling) {
      if (dx === 0 && dy === 0) return;
      // Sideways, upward, or already scrolled: ordinary scrolling. If the browser has already
      // committed to scrolling (not cancelable), leave the gesture to it as well.
      if (event.touches.length !== 1 || dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0 || !event.cancelable) {
        tracking = false;
        return;
      }
      pulling = true;
    }
    if (event.cancelable) event.preventDefault();
    distance = Math.min(Math.max(dy, 0) * 0.5, PULL_MAX);
    show(distance, true);
  }, { passive: false });

  document.addEventListener('touchend', async () => {
    if (!stop()) return;
    if (distance < PULL_THRESHOLD) {
      show(0, false);
      return;
    }
    busy = true;
    indicator.classList.add('is-refreshing');
    show(PULL_REST, false);
    const started = Date.now();
    try {
      await refreshCurrentView();
    } catch (error) {
      // Each view reports its own errors in its status banner.
    }
    // A refresh with nothing to fetch finishes at once; keep the spinner long enough to be seen.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 500 - (Date.now() - started))));
    indicator.classList.remove('is-refreshing');
    show(0, false);
    busy = false;
  });

  document.addEventListener('touchcancel', () => {
    if (stop()) show(0, false);
  });
}

// Lets the next page load tell an update reload by the app apart from one by the user.
function markAppReload() {
  try {
    sessionStorage.setItem(APP_RELOAD_KEY, '1');
  } catch (error) {
    // Without storage the update reload just fetches results once more.
  }
}

// True when the user reloaded the page: the browser's reload button, or a pull-to-refresh
// the browser would not let the app take over.
function isUserReload() {
  let byApp = false;
  try {
    byApp = sessionStorage.getItem(APP_RELOAD_KEY) === '1';
    sessionStorage.removeItem(APP_RELOAD_KEY);
  } catch (error) {
    byApp = false;
  }
  const [navigation] = performance.getEntriesByType?.('navigation') || [];
  return !byApp && navigation?.type === 'reload';
}

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
    markAppReload();
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
setupPullToRefresh();
// The setup page already loads the live events on its own.
if (state && isUserReload()) refreshCurrentView();
