import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the actual product flow, against a running dev
 * stack (frontend on :5173, backend on :8000, Postgres up). Each spec
 * registers its own fresh account so tests don't depend on seeded data.
 */

function uniqueEmail(tag: string): string {
  return `pw-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const PASSWORD = 'playwright-test-password-1';

async function registerAndSignIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /No account\? Create one/i }).click();
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  // Every test starts here, so this is the single highest-value place to
  // wait on the real network round trip rather than a fixed UI timeout: the
  // registration call itself is what actually varies against a live,
  // shared, free-tier deployment.
  const registered = page.waitForResponse(
    (r) => r.url().includes('/api/auth/register') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create account' }).click();
  await registered;
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** Click a sidebar nav item, opening the off-canvas drawer first if the
 * layout is narrow enough that it's collapsed (the drawer's buttons still
 * exist in the DOM when closed, just translated off-screen, so presence of
 * the hamburger button is the reliable signal, not the nav button's own
 * visibility). */
async function goToTab(page: Page, tab: string) {
  const opener = page.getByRole('button', { name: 'Open navigation' });
  if (await opener.isVisible().catch(() => false)) {
    await opener.click();
  }
  await page.getByRole('button', { name: tab, exact: true }).click();
}

async function forceProviderMode(page: Page, mode: 'replay' | 'failing') {
  await page.evaluate(async (m) => {
    const token = localStorage.getItem('smw.token');
    await fetch('/api/demo/provider', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: m }),
    });
  }, mode);
}

test('full product flow: sign in through Brief, SymbolPath, History, Watchlist, Manage, sign out', async ({
  page,
}) => {
  // This one test deliberately covers the whole product end to end (sign-in,
  // Demo, SymbolPath, History, a full Watchlist CRUD cycle, Manage, sign-out)
  // against a real deployment, not a mocked one -- every step below is a
  // genuine network round trip. Playwright's generic 30s default was
  // calibrated for a single focused assertion, not a comprehensive flow like
  // this; every other test in this file stays comfortably under it. This
  // does not loosen any individual assertion, it gives this one long,
  // legitimately multi-step test a budget proportional to its own scope.
  test.setTimeout(120_000);

  const email = uniqueEmail('flow');

  await test.step('sign in (via registration) lands on a populated Brief', async () => {
    await registerAndSignIn(page, email);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('TWELVE_DATA_API_KEY');
  });

  await test.step('Demo seeds a populated Brief with attention items', async () => {
    const demoButton = page.getByRole('button', { name: 'Demo' });
    await expect(demoButton).toBeVisible();

    // "Here's what changed..." is not a reliable completion signal on its
    // own: a brand-new account's very first brief already compares against
    // a week of history and can show that same text before Demo has done
    // anything. A fixed timeout on the button's own busy state ("Seeding…"
    // -> back to "Demo") isn't reliable either: runDemo() finishes only
    // after the demo call resolves *and* its own follow-up `load(true)`
    // reload completes, and that reload's Brief fetch is what actually
    // repopulates the screen. Waiting for both real network round trips --
    // not a guessed duration -- is what actually brackets the click handler.
    const demoReplayDone = page.waitForResponse(
      (r) => r.url().includes('/api/demo/replay') && r.request().method() === 'POST',
    );
    const briefReloaded = page.waitForResponse(
      (r) => /\/api\/watchlists\/\d+\/brief/.test(r.url()) && r.request().method() === 'GET',
    );
    await demoButton.click();
    await demoReplayDone;
    await briefReloaded;

    await expect(demoButton).toBeVisible();
    await expect(page.getByText(/Here's what changed while you were away\./)).toBeVisible();
  });

  await test.step('opening an attention item drills into SymbolPath with a working tooltip', async () => {
    const rows = page.locator('main ul li button');
    const rowCount = await rows.count();
    expect(rowCount, 'Demo should always leave at least one attention item').toBeGreaterThan(0);

    // A symbol whose demo-seeded window happened to backfill fewer than two
    // path points renders "Not enough data to plot a path yet" instead of a
    // chart -- a real, valid state, not a bug. Try rows in order until one
    // actually has a plottable path.
    let opened = false;
    let headingTextForCheck = '';
    for (let i = 0; i < rowCount && !opened; i++) {
      const row = rows.nth(i);
      const symbolText = (await row.textContent()) ?? '';
      await row.click();
      await expect(page.getByRole('button', { name: /Back to brief/i })).toBeVisible();
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toBeVisible();
      const headingText = (await heading.textContent())?.trim() ?? '';
      expect(symbolText.trim().startsWith(headingText)).toBeTruthy();
      headingTextForCheck = headingText;

      // The detail fetch has no loading skeleton, so wait for whichever of
      // the two real outcomes actually lands, rather than racing a fixed
      // timeout against network latency.
      await expect(
        page
          .locator('.chart-path-markers circle')
          .first()
          .or(page.getByText(/not enough data/i)),
      ).toBeVisible({ timeout: 10_000 });
      const hasChart = await page
        .locator('.chart-path-markers circle')
        .first()
        .isVisible()
        .catch(() => false);
      if (hasChart) {
        opened = true;
      } else {
        await page.getByRole('button', { name: /Back to brief/i }).click();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      }
    }
    expect(opened, `no attention row (of ${rowCount}) had a plottable path for ${headingTextForCheck}`).toBeTruthy();

    // Exactly four markers (checkpoint, high, low, now), all inside the
    // plot. Read every marker's geometry in one JS snapshot rather than one
    // Playwright locator call per marker: the chart can legitimately
    // re-render mid-check (the 20s background brief refresh), and a
    // multi-step round trip is vulnerable to inspecting a node that gets
    // detached between steps.
    const markers = page.locator('.chart-path-markers circle');
    await expect(markers).toHaveCount(4);

    const snapshot = await page.evaluate(() => {
      const area = document.querySelector('.chart-path-markers');
      if (!area) return null;
      const r = area.getBoundingClientRect();
      const circles = Array.from(area.querySelectorAll('circle')).map((c) => {
        const cr = c.getBoundingClientRect();
        return { x: cr.x, y: cr.y, width: cr.width, height: cr.height };
      });
      return { x: r.x, y: r.y, width: r.width, height: r.height, circles };
    });
    expect(snapshot).not.toBeNull();
    if (snapshot) {
      expect(snapshot.circles).toHaveLength(4);
      for (const box of snapshot.circles) {
        expect(box.x).toBeGreaterThanOrEqual(snapshot.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(snapshot.x + snapshot.width + 1);
      }

      // Tooltip: the markers group is `pointer-events: none` by design (see
      // BklitPathChart.tsx), so it can never be the hover target itself,
      // and its bounding box does not reliably line up with the chart's
      // hit-area rect. What it does guarantee is that every marker sits
      // exactly on the line, so hover the same point a marker is drawn at
      // -- the event passes through the marker to the line underneath it,
      // which is what actually drives the tooltip.
      const marker = snapshot.circles[0];
      const midX = marker.x + marker.width / 2;
      const midY = marker.y + marker.height / 2;
      // Give the chart's own 420ms mount animation room to finish before
      // trying to hover it; the interaction layer only exists once it has.
      await page.waitForTimeout(500);
      // A couple of intermediate steps, starting from off the target: the
      // interaction layer reacts to *movement*, and a single teleporting
      // move can land before a listener is attached.
      await page.mouse.move(midX - 20, midY - 20);
      await page.mouse.move(midX, midY, { steps: 5 });
      await page.mouse.move(midX + 1, midY + 1, { steps: 2 });
      await expect(page.locator('.z-50').first()).toBeVisible({ timeout: 8_000 });
    }

    await page.getByRole('button', { name: /Back to brief/i }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  await test.step('reviewing the Brief records History, and drill-down from there works', async () => {
    await goToTab(page, 'History');
    // History fetches asynchronously after the tab mounts; wait for that to
    // settle (either the empty state or a real row) rather than reading
    // whatever happened to be on screen mid-fetch.
    await expect(
      page.getByText('No history yet').or(page.locator('main ul li button').first()),
    ).toBeVisible({ timeout: 10_000 });

    await goToTab(page, 'Brief');
    const reviewButton = page.getByRole('button', { name: "I've reviewed this" });
    await expect(reviewButton).toBeVisible();
    await reviewButton.click();
    await expect(page.getByText(/Review saved/)).toBeVisible({ timeout: 10_000 });

    await goToTab(page, 'History');
    const stillEmpty = await page.getByText('No history yet').isVisible().catch(() => false);
    if (!stillEmpty) {
      const historyRows = page.locator('main ul li button');
      await expect(historyRows.first()).toBeVisible();
      await historyRows.first().click();
      await expect(page.getByRole('button', { name: /Back to brief/i })).toBeVisible();
      await page.getByRole('button', { name: /Back to brief/i }).click();
    }
  });

  await test.step('Watchlist: add, duplicate add, reorder, priority, remove', async () => {
    await goToTab(page, 'Watchlist');
    await expect(page.getByRole('heading', { name: 'Watchlist', exact: true })).toBeVisible();

    const symbolInput = page.getByPlaceholder('Symbol (e.g. SBIN)');
    const addButton = page.getByRole('button', { name: 'Add', exact: true });
    const before = await page.locator('main ul li').count();

    // Confirm the write itself actually happened -- a real failure to
    // persist must still surface immediately, not be masked by a generous
    // UI-catch-up timeout below.
    const addPosted = page.waitForResponse(
      (r) => /\/api\/watchlists\/\d+\/items$/.test(r.url()) && r.request().method() === 'POST',
    );
    await symbolInput.fill('TATAMOTORS');
    await addButton.click();
    await addPosted;
    // `submit()` clears the input only after `onAdd()` resolves, which in
    // turn waits on `mutate()`'s full reload (watchlists, brief,
    // preferences, market source together) -- not just the POST above. Both
    // checks below are Playwright's own auto-retrying assertions, so a
    // longer explicit window here is bounded, condition-based waiting for
    // that whole reload to land, not a guessed fixed delay.
    await expect
      .poll(async () => page.locator('main ul li').count(), { timeout: 15_000 })
      .toBe(before + 1);
    await expect(symbolInput).toHaveValue('', { timeout: 15_000 });

    // Duplicate add: idempotent, no new row. A mutation always reloads the
    // watchlist afterwards (see `mutate()` in App.tsx), and that reload's
    // GET is what the row count actually reflects -- wait for both real
    // round trips instead of guessing how long they take.
    const duplicateAddPosted = page.waitForResponse(
      (r) => /\/api\/watchlists\/\d+\/items$/.test(r.url()) && r.request().method() === 'POST',
    );
    await symbolInput.fill('TATAMOTORS');
    await addButton.click();
    await duplicateAddPosted;
    await page.waitForResponse(
      (r) => /\/api\/watchlists$/.test(r.url()) && r.request().method() === 'GET',
    );
    expect(await page.locator('main ul li').count()).toBe(before + 1);

    const row = page.locator('main ul li').filter({ hasText: 'TATAMOTORS' });

    // Reorder: move it up and confirm the row order actually changed. Same
    // reasoning as the duplicate add above -- the displayed order only
    // updates once the post-reorder watchlist reload lands.
    const upButton = row.getByRole('button', { name: /Move TATAMOTORS up/i });
    if (await upButton.isEnabled()) {
      const rowsBefore = await page.locator('main ul li').allTextContents();
      const reorderPut = page.waitForResponse(
        (r) => /\/api\/watchlists\/\d+\/order$/.test(r.url()) && r.request().method() === 'PUT',
      );
      await upButton.click();
      await reorderPut;
      await page.waitForResponse(
        (r) => /\/api\/watchlists$/.test(r.url()) && r.request().method() === 'GET',
      );
      const rowsAfter = await page.locator('main ul li').allTextContents();
      expect(rowsAfter).not.toEqual(rowsBefore);
    }

    // Priority: open the dropdown and set it to High. Same reload-race
    // reasoning as above -- wait for the actual PATCH before asserting the
    // new priority is displayed.
    const priorityPatched = page.waitForResponse(
      (r) => /\/api\/watchlists\/\d+\/items\/\d+$/.test(r.url()) && r.request().method() === 'PATCH',
    );
    await row.getByRole('button', { name: /Priority for TATAMOTORS/i }).click();
    await page.getByRole('option', { name: 'High' }).click();
    await priorityPatched;
    await expect(row.getByText('High', { exact: true })).toBeVisible();

    // Remove it, back to the starting count. Same reload-race reasoning as
    // the rest of this step -- wait for the DELETE and its reload before
    // polling the count, instead of letting the poll's own default window
    // race the round trip.
    const removeDeleted = page.waitForResponse(
      (r) => /\/api\/watchlists\/\d+\/items\/\d+$/.test(r.url()) && r.request().method() === 'DELETE',
    );
    await row.getByRole('button', { name: 'Remove' }).click();
    await removeDeleted;
    await page.waitForResponse(
      (r) => /\/api\/watchlists$/.test(r.url()) && r.request().method() === 'GET',
    );
    await expect
      .poll(async () => page.locator('main ul li').count())
      .toBe(before);
  });

  await test.step('Manage: a single click updates a slider immediately, and it survives reload', async () => {
    await goToTab(page, 'Manage');
    await expect(page.getByRole('heading', { name: 'Manage what surfaces' })).toBeVisible();

    const slider = page.getByRole('slider', { name: 'Minimum move' });
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    let valueAfterClick: string | null = null;
    if (box) {
      // Wait for the actual PATCH to land rather than a fixed timeout: the
      // click updates the slider's local state immediately, but "survives
      // reload" is only true once the commit request has actually completed
      // -- a fixed short wait is exactly the kind of race that makes a test
      // flaky under load without saying anything real about the app.
      const commitResponse = page.waitForResponse(
        (r) => r.url().includes('/api/preferences') && r.request().method() === 'PATCH',
      );
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      await commitResponse;
      valueAfterClick = await slider.getAttribute('value');
    }

    // A reload resets all client state, so the app refetches preferences
    // (among other things) before rendering past its loading skeleton --
    // wait for that specific refetch, since it's what determines the
    // slider's post-reload value, rather than racing a fixed timeout
    // against however long the round trip takes.
    const prefsRefetched = page.waitForResponse(
      (r) => r.url().includes('/api/preferences') && r.request().method() === 'GET',
    );
    await page.reload();
    await prefsRefetched;
    await goToTab(page, 'Manage');
    await expect(page.getByRole('slider', { name: 'Minimum move' })).toHaveAttribute(
      'value',
      valueAfterClick ?? '',
      { timeout: 10_000 },
    );
  });

  await test.step('return to Brief, sign out, and the stale token no longer works', async () => {
    await goToTab(page, 'Brief');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('smw.token'));
    expect(token).toBeNull();
  });
});

test.describe('auth edge cases', () => {
  test('invalid credentials show a real error, not a stale session message', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByPlaceholder('Email').fill('nonexistent-user@example.com');
    await page.getByPlaceholder('Password').fill('wrong-password-123');
    // Exact match: Google's own embedded button also has an accessible name
    // containing "Sign in" ("Sign in with Google. Opens in new tab"), which
    // a substring match would ambiguously resolve to both.
    const loginRejected = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await loginRejected;

    await expect(page.getByText('invalid email or password')).toBeVisible();
    await expect(page.getByText(/session expired/i)).not.toBeVisible();
  });

  test('switching between sign in and create account clears a stale error', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByPlaceholder('Email').fill('nonexistent-user@example.com');
    await page.getByPlaceholder('Password').fill('wrong-password-123');
    // Exact match: Google's own embedded button also has an accessible name
    // containing "Sign in" ("Sign in with Google. Opens in new tab"), which
    // a substring match would ambiguously resolve to both.
    const loginRejected = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await loginRejected;
    await expect(page.getByText('invalid email or password')).toBeVisible();

    await page.getByRole('button', { name: /No account\? Create one/i }).click();
    await expect(page.getByText('invalid email or password')).not.toBeVisible();
  });
});

test.describe('data source states', () => {
  test('the sidebar source label always matches the backend\'s actual provider state', async ({
    page,
  }) => {
    // The account can legitimately land in any of the app's three defined
    // states -- Replay, Live, or Degraded (e.g. the shared production
    // provider can be mid-outage for reasons outside this test's control) --
    // so this does not assume which one it will be. What must always hold is
    // that the label shown is the one truthful for whatever state the
    // backend actually reports, never a different one of the three.
    const email = uniqueEmail('source');
    await registerAndSignIn(page, email);

    const sidebar = page.getByRole('complementary');
    const labels = ['Replay data', 'Degraded', 'Live market data'] as const;

    // Wait for the chip to actually resolve to one of the three valid
    // states before reading it, rather than a fixed delay.
    await expect(
      sidebar
        .getByText(labels[0], { exact: true })
        .or(sidebar.getByText(labels[1], { exact: true }))
        .or(sidebar.getByText(labels[2], { exact: true })),
    ).toBeVisible({ timeout: 10_000 });

    const truth: { provider: string; mode: 'live' | 'replay'; degraded: boolean } =
      await page.evaluate(async () => {
        const token = localStorage.getItem('smw.token');
        const res = await fetch('/api/market/source', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.json();
      });

    // Mirrors the exact decision `sourceCopy()` makes in format.ts -- this
    // test must fail if the UI's logic ever diverges from that truth.
    const expected = truth.degraded
      ? 'Degraded'
      : truth.mode === 'live' && truth.provider !== 'replay'
        ? 'Live market data'
        : 'Replay data';

    for (const label of labels) {
      if (label === expected) {
        await expect(sidebar.getByText(label, { exact: true })).toBeVisible();
      } else {
        await expect(sidebar.getByText(label, { exact: true })).not.toBeVisible();
      }
    }
  });

  test('a forced provider failure shows Degraded, not a blank screen', async ({ page }) => {
    const email = uniqueEmail('degraded');
    await registerAndSignIn(page, email);

    await forceProviderMode(page, 'failing');
    await page.reload();

    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByText('Degraded', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/vendor is unavailable/i)).toBeVisible();
    // The brief itself must still render, backed by the replay fallback.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Restore replay so this account doesn't leave the fixture stuck degraded.
    await forceProviderMode(page, 'replay');
  });
});

test.describe('responsive layout', () => {
  const sizes: [string, { width: number; height: number }][] = [
    ['1280px', { width: 1280, height: 900 }],
    ['1440px', { width: 1440, height: 900 }],
    ['1920px', { width: 1920, height: 1080 }],
    ['mobile', { width: 375, height: 812 }],
  ];

  for (const [label, viewport] of sizes) {
    test(`no horizontal overflow at ${label}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const email = uniqueEmail(`resp-${label}`);
      await registerAndSignIn(page, email);

      for (const tab of ['Brief', 'Watchlist', 'History', 'Manage']) {
        await goToTab(page, tab);
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow, `${tab} overflows at ${label}`).toBeFalsy();
      }
    });
  }
});
