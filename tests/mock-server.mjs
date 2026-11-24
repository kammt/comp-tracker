// A stand-in for scoring.dance and SwingPoints that also serves the app itself, so the
// tests run the real app against crafted API responses on one origin. The tests point the
// app at it by setting window.COMPTRACKER_API_URL and COMPTRACKER_SWINGPOINTS_URL.
//
//   node tests/mock-server.mjs            → http://localhost:4173 (PORT to change it)
//
// Every test gets its own copy of the mock data under /mock/<test id>/ (api/, graphql and
// state), so tests run in parallel. A test changes what its APIs return with
// POST /mock/<test id>/state, which is merged into that test's state.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const EVENT_ID = 393;
const SWINGPOINTS_LOGIN = { email: 'dancer@example.com', password: 'correct horse' };

const INITIAL_STATE = {
  // The prelim's results and the final's heat lists are out.
  resultsReleased: false,
  // Ada was moved from heat 2 to heat 3 (a change to her info that isn't a result).
  adaMovedHeat: false,
};
const states = new Map();

function stateOf(id) {
  if (!states.has(id)) states.set(id, { ...INITIAL_STATE });
  return states.get(id);
}

const PEOPLE = {
  1: { name: 'Ada Lovelace', role: 'L', heat: 2 },
  2: { name: 'Grace Hopper', role: 'F', heat: 2 },
  3: { name: 'Alan Turing', role: 'L', heat: 1 },
  4: { name: 'Émilie du Châtelet', role: 'F', heat: 1 },
};
const PRELIM = 101;
const FINAL = 102;
const JUDGES = [{ name: { short: 'AB', long: 'Anna Berg' } }, { name: { short: 'CD', long: 'Carl Dahl' } }];

// ---- scoring.dance: /api/<method>.json, errors as `err.id` with HTTP 200 ----

const ok = (result) => ({ err: { id: 0 }, result });
const apiError = (id, msg) => ({ err: { id, msg } });

function eventsList() {
  const now = Math.floor(Date.now() / 1000);
  return [
    // Running right now, so it is listed under "Happening now".
    { id: EVENT_ID, name: ' Mock Swing Open 2026 ', country: 'Austria', start: { unix: now - 86400 }, end: { unix: now + 86400 } },
    { id: 12, name: 'Old Swing Classic', country: 'Germany', start: { unix: 1500000000 }, end: { unix: 1500200000 } },
  ];
}

function roundsList(state) {
  return [
    { id: PRELIM, name: 'Novice Jack&Jill prelim', heats: 3, results_published: state.resultsReleased, start: { iso8601: '2026-11-24T10:00:00+01:00', hidden: false } },
    { id: FINAL, name: 'Novice Jack&Jill final', heats: state.resultsReleased ? 1 : 0, results_published: false, start: { iso8601: '2026-11-24T18:00:00+01:00', hidden: false } },
  ];
}

function heatOf(bib, state) {
  return bib === '1' && state.adaMovedHeat ? 3 : PEOPLE[bib].heat;
}

function participantInfo(bib, state) {
  const person = PEOPLE[bib];
  if (!person) return apiError(95, 'Participant not found');
  const rounds = [{ id: PRELIM, type: 'prelim', is_in: true, heats: [heatOf(bib, state)] }];
  // Ada and Grace made the final.
  if (state.resultsReleased && (bib === '1' || bib === '2')) rounds.push({ id: FINAL, type: 'final', is_in: true, heats: [1] });
  return ok({ name: person.name, competitions: [{ name: 'Novice Jack&Jill', role: person.role, partner_name: '', rounds }] });
}

function marshList(roundId, state) {
  if (roundId !== String(PRELIM)) return apiError(87, 'List is not public');
  const heats = {};
  for (const [bib, person] of Object.entries(PEOPLE)) {
    const number = heatOf(bib, state);
    heats[number] ||= { heat: number, leader: [], follower: [] };
    heats[number][person.role === 'L' ? 'leader' : 'follower'].push({ bib: Number(bib), name: person.name });
  }
  return ok({ heats });
}

function roundResult(roundId, state) {
  if (roundId !== String(PRELIM) || !state.resultsReleased) return apiError(88, 'No results yet');
  const row = (bib, total, prelimscores, rowState) => ({ dancer: { bib, fullname: PEOPLE[bib].name }, total, prelimscores, state: rowState });
  return ok({
    is_final: false,
    lists: [
      { judges: JUDGES, rows: [row(1, 2, ['YES', 'YES'], 'cb'), row(3, 1, ['NO', 'A1'], 'alt1')] },
      { judges: JUDGES, rows: [row(2, 2, ['YES', 'YES'], 'cb'), row(4, 0, ['NO', 'NO'], '')] },
    ],
  });
}

function scoringDance(method, params, state) {
  switch (method) {
    case 'events.list': return ok(eventsList());
    case 'rounds.list': return ok(params.get('event') === String(EVENT_ID) ? roundsList(state) : []);
    case 'participant.info': return participantInfo(params.get('bib'), state);
    case 'participant.search': return ok({ results: Object.entries(PEOPLE).map(([bib, person]) => ({ bib: Number(bib), name: person.name })) });
    case 'round.marshlist': return marshList(params.get('round'), state);
    case 'round.result': return roundResult(params.get('round'), state);
    default: return apiError(1, `Unknown method ${method}`);
  }
}

// ---- SwingPoints: one GraphQL endpoint ----

const TOKEN = 'mock-access-token';
const FOLLOWED = [
  { fullName: 'Alan Turing', wsdcId: 1001, roles: ['LEADER'], highestDivision: { totalPoints: 12, division: { name: 'Novice' } } },
  { fullName: 'Emilie du Chatelet', wsdcId: 1002, roles: ['FOLLOWER'], highestDivision: { totalPoints: 1, division: { name: 'Novice' } } },
  { fullName: 'Someone Elsewhere', wsdcId: 1003, roles: ['LEADER', 'FOLLOWER'], highestDivision: null },
];

function swingPoints({ query, variables }, authorization) {
  if (query.includes('authenticate')) {
    const { user, password } = variables.params;
    if (user.email !== SWINGPOINTS_LOGIN.email || password !== SWINGPOINTS_LOGIN.password) {
      return { errors: [{ message: 'Incorrect password' }], data: null };
    }
    return { data: { authenticate: { tokens: { accessToken: TOKEN } } } };
  }
  if (query.includes('followedDancers')) {
    if (authorization !== `Bearer ${TOKEN}`) return { errors: [{ message: 'Not logged in' }], data: null };
    // Two pages, so the app has to follow the cursor.
    const page = variables.after === 'page-2' ? FOLLOWED.slice(1) : FOLLOWED.slice(0, 1);
    const hasNextPage = variables.after !== 'page-2';
    return { data: { getUser: { followedDancers: {
      pageInfo: { endCursor: hasNextPage ? 'page-2' : null, hasNextPage },
      edges: page.map((node) => ({ node })),
    } } } };
  }
  return { errors: [{ message: 'Unknown query' }], data: null };
}

// ---- The server ----

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const mock = url.pathname.match(/^\/mock\/([\w-]+)\/(.*)$/);
    if (mock) {
      const [, id, rest] = mock;
      const api = rest.match(/^api\/([\w.]+)\.json$/);
      if (api) return send(response, 200, scoringDance(api[1], url.searchParams, stateOf(id)));
      if (rest === 'graphql' && request.method === 'POST') {
        return send(response, 200, swingPoints(await readBody(request), request.headers.authorization));
      }
      if (rest === 'state' && request.method === 'POST') {
        return send(response, 200, Object.assign(stateOf(id), await readBody(request)));
      }
      return send(response, 404, 'Not found', 'text/plain');
    }
    // The app's own files.
    const path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT) || !TYPES[extname(path)]) return send(response, 404, 'Not found', 'text/plain');
    return send(response, 200, await readFile(path), TYPES[extname(path)]);
  } catch (error) {
    return send(response, error.code === 'ENOENT' ? 404 : 500, String(error.message), 'text/plain');
  }
});

server.listen(PORT, () => console.log(`Mock server on http://localhost:${PORT}`));
