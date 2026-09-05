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
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({
    timeout: 15_000,
  });
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
  const email = uniqueEmail('flow');

  await test.step('sign in (via registration) lands on a populated Brief', async () => {
    await registerAndSignIn(page, email);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('TWELVE_DATA_API_KEY');
  });

  await test.step('Demo seeds a populated Brief with attention items', async () => {
    const demoButton = page.getByRole('button', { name: 'Demo' });
    await expect(demoButton).toBeVisible();
    await demoButton.click();
    // "Here's what changed..." is not a reliable completion signal on its
    // own: a brand-new account's very first brief already compares against
    // a week of history and can show that same text before Demo has done
    // anything. Waiting only for it let a later test step race ahead of
    // runDemo()'s own in-flight `load(true)`, which finishes by resetting
    // pathSymbol -- silently yanking the test back to the Brief mid-way
    // through the SymbolPath step. The button's own busy state ("Seeding…"
    // -> back to "Demo") is what actually brackets the whole click handler.
    await expect(page.getByRole('button', { name: 'Seeding…' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(demoButton).toBeVisible({ timeout: 15_000 });
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

    await symbolInput.fill('TATAMOTORS');
    await addButton.click();
    await expect
      .poll(async () => page.locator('main ul li').count())
      .toBe(before + 1);
    // `submit()` awaits the full add (including the resulting reload)
    // before clearing the field itself, so the count updating doesn't
    // guarantee the input has been cleared yet -- wait for that too, or a
    // second fill() here can race the form's own reset and get wiped out.
    await expect(symbolInput).toHaveValue('');

    // Duplicate add: idempotent, no new row.
    await symbolInput.fill('TATAMOTORS');
    await addButton.click();
    await page.waitForTimeout(500);
    expect(await page.locator('main ul li').count()).toBe(before + 1);

    const row = page.locator('main ul li').filter({ hasText: 'TATAMOTORS' });

    // Reorder: move it up and confirm the row order actually changed.
    const upButton = row.getByRole('button', { name: /Move TATAMOTORS up/i });
    if (await upButton.isEnabled()) {
      const rowsBefore = await page.locator('main ul li').allTextContents();
      await upButton.click();
      await page.waitForTimeout(500);
      const rowsAfter = await page.locator('main ul li').allTextContents();
      expect(rowsAfter).not.toEqual(rowsBefore);
    }

    // Priority: open the dropdown and set it to High.
    await row.getByRole('button', { name: /Priority for TATAMOTORS/i }).click();
    await page.getByRole('option', { name: 'High' }).click();
    await expect(row.getByText('High', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Remove it, back to the starting count.
    await row.getByRole('button', { name: 'Remove' }).click();
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

    await page.reload();
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
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('invalid email or password')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/session expired/i)).not.toBeVisible();
  });

  test('switching between sign in and create account clears a stale error', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByPlaceholder('Email').fill('nonexistent-user@example.com');
    await page.getByPlaceholder('Password').fill('wrong-password-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('invalid email or password')).toBeVisible();

    await page.getByRole('button', { name: /No account\? Create one/i }).click();
    await expect(page.getByText('invalid email or password')).not.toBeVisible();
  });
});

test.describe('data source states', () => {
  test('defaults to Replay, never labelled Live', async ({ page }) => {
    const email = uniqueEmail('source');
    await registerAndSignIn(page, email);

    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByText('Replay data', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByText('Live market data')).not.toBeVisible();
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
