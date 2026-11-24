// End-to-end tests: the real app in Chromium, talking to tests/mock-server.mjs.
import { test as base, expect } from '@playwright/test';

// Each test talks to its own copy of the mock data (see mock-server.mjs).
const test = base.extend({
  mockUrl: async ({}, use, testInfo) => {
    await use(`/mock/${testInfo.testId}-${testInfo.retry}`);
  },
  page: async ({ page, mockUrl }, use) => {
    await page.addInitScript((base) => {
      window.COMPTRACKER_API_URL = `${base}/api/`;
      window.COMPTRACKER_SWINGPOINTS_URL = `${base}/graphql`;
    }, mockUrl);
    await use(page);
  },
  // Changes what this test's mock APIs return from now on (see INITIAL_STATE in mock-server.mjs).
  setMock: async ({ request, mockUrl }, use) => {
    await use(async (changes) => {
      expect((await request.post(`${mockUrl}/state`, { data: changes })).ok()).toBe(true);
    });
  },
});

// Ada (1) and Grace (2) are in heat 2 of the prelim, Alan (3) and Émilie (4) in heat 1.
function card(page, name) {
  return page.locator('#results .participant').filter({ hasText: name });
}

async function openEvent(page) {
  await page.goto('/');
  await page.locator('#live-events-list').getByRole('button', { name: /Mock Swing Open 2026/ }).click();
  await expect(page.locator('#event-label')).toHaveText('Mock Swing Open 2026 · #393');
}

async function addByBib(page, bib) {
  await page.locator('#add-person-button').click();
  await page.locator('#person-query').fill(bib);
  await page.locator('#add-form').getByRole('button', { name: 'Add person' }).click();
}

async function refresh(page) {
  await page.locator('#refresh-button').click();
  await expect(page.locator('#refresh-button')).toBeEnabled();
}

test('looks up an event by its ID', async ({ page }) => {
  await page.goto('/');
  // Only the event running right now is offered under "Happening now".
  await expect(page.locator('#live-events-list .live-event')).toHaveCount(1);

  await page.locator('#event-id').fill('999');
  await page.getByRole('button', { name: 'Find event' }).click();
  await expect(page.locator('#setup-status')).toHaveText('Could not find that event. No event found for that ID.');

  await page.locator('#event-id').fill('393');
  await page.getByRole('button', { name: 'Find event' }).click();
  await expect(page.locator('#event-preview-title')).toHaveText('Mock Swing Open 2026');
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.locator('#event-label')).toHaveText('Mock Swing Open 2026 · #393');
  await expect(page.locator('#results')).toContainText('No one on your watch list yet.');
});

test('fetches a competitor by bib number', async ({ page }) => {
  await openEvent(page);
  await addByBib(page, '1');

  const ada = card(page, 'Ada Lovelace');
  await expect(ada.locator('.bib')).toHaveText('Bib 1');
  await expect(ada.locator('.competition-title')).toHaveText('Novice Jack&Jill');
  await expect(ada.locator('.meta-line')).toHaveText('Leader');
  await expect(ada.locator('.comp-progress')).toHaveText('prelimHeat 2');
  // The final has no heats yet, so she is neither in nor out of it.
  await expect(ada.locator('.round-row.is-pending')).toContainText('Not out yet');

  await addByBib(page, '77');
  await expect(card(page, '77')).toContainText('Bib number 77 does not exist in event 393.');
});

test('marks people whose info changed since the last refresh', async ({ page, setMock }) => {
  await openEvent(page);
  await addByBib(page, '1');
  await expect(card(page, 'Ada Lovelace')).toBeVisible();
  await addByBib(page, '2');
  await expect(card(page, 'Grace Hopper')).toBeVisible();

  await refresh(page);
  await expect(page.locator('#status-line')).toContainText('no changes');
  await expect(page.locator('#results .is-changed')).toHaveCount(0);

  await setMock({ adaMovedHeat: true });
  await refresh(page);
  // The app clears the marks 10 seconds after a refresh, so check them right away.
  await expect(page.locator('#status-line')).toContainText('1 person changed');
  await expect(card(page, 'Ada Lovelace')).toHaveClass(/is-changed/);
  await expect(card(page, 'Ada Lovelace').locator('.change-label')).toHaveText('Changed');
  await expect(card(page, 'Ada Lovelace').locator('.comp-progress')).toHaveText('prelimHeat 3');
  await expect(card(page, 'Grace Hopper')).not.toHaveClass(/is-changed/);
});

test('shows results once they are released', async ({ page, setMock }) => {
  await openEvent(page);
  await addByBib(page, '1');
  await expect(card(page, 'Ada Lovelace')).toBeVisible();
  await expect(page.locator('#show-results-button')).toBeHidden();

  await setMock({ resultsReleased: true });
  await refresh(page);
  const ada = card(page, 'Ada Lovelace');
  await expect(ada).toHaveClass(/is-changed/);
  // She got a callback from the prelim and is in heat 1 of the final.
  await expect(ada.locator('.round-row', { hasText: 'prelim' }).locator('.round-result')).toHaveText('CB · Σ2');
  await expect(ada.locator('.comp-progress')).toHaveText('finalHeat 1');

  await page.locator('#show-results-button').click();
  const marks = page.locator('#results-list .round-results', { hasText: 'prelim' }).locator('.judge-mark');
  await expect(marks).toHaveText(['ABYes', 'CDYes']);
});

test('loads every competitor\'s name and adds one by name', async ({ page }) => {
  await openEvent(page);
  await page.locator('#add-person-button').click();
  await page.getByRole('tab', { name: 'By name' }).click();
  await page.getByRole('button', { name: 'Load competitor list' }).click();
  await expect(page.locator('#roster-copy')).toContainText('4 competitors');

  // Accents and case don't matter.
  await page.locator('#name-query').fill('emilie');
  const suggestions = page.locator('#name-suggestions .suggestion');
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions).toContainText('Émilie du Châtelet');
  await expect(suggestions).toContainText('#4');
  await suggestions.click();

  const emilie = card(page, 'Émilie du Châtelet');
  await expect(emilie.locator('.bib')).toHaveText('Bib 4');
  await expect(emilie.locator('.meta-line')).toHaveText('Follower');
});

test('syncs SwingPoints favourites and adds those competing', async ({ page }) => {
  await page.goto('/#favourites');
  await page.locator('#swingpoints-email').fill('dancer@example.com');
  await page.locator('#swingpoints-password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in and sync' }).click();
  await expect(page.locator('#favourites-status')).toHaveText('Could not sign in to SwingPoints. Incorrect password.');

  await page.locator('#swingpoints-password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in and sync' }).click();
  // Two pages of followed dancers, sorted by name.
  await expect(page.locator('#favourites-status')).toHaveText('Synced 3 favourites from SwingPoints.');
  await expect(page.locator('#favourites-list .favourite-name')).toHaveText(['Alan Turing', 'Emilie du Chatelet', 'Someone Elsewhere']);
  await expect(page.locator('#favourites-list .favourite').first()).toContainText('WSDC #1001 · Leader');
  await expect(page.locator('#favourites-note')).toContainText('signed in as dancer@example.com');

  // At the event, the two who compete there are offered for the watch list.
  await page.getByRole('tab', { name: 'Home' }).click();
  await page.locator('#live-events-list').getByRole('button', { name: /Mock Swing Open 2026/ }).click();
  await page.locator('#add-person-button').click();
  await page.getByRole('tab', { name: 'By name' }).click();
  await page.getByRole('button', { name: 'Load competitor list' }).click();
  await expect(page.locator('#favourites-banner-copy')).toHaveText('2 favourites here aren\'t on your watch list yet.');
  await page.locator('#favourites-banner-button').click();
  await expect(page.locator('#bulk-list')).toContainText('1 not in this event');
  await page.getByRole('button', { name: 'Add 2 people' }).click();

  await expect(card(page, 'Alan Turing')).toBeVisible();
  await expect(card(page, 'Émilie du Châtelet')).toBeVisible();
});
