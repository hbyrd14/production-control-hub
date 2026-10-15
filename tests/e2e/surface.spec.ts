import { expect, test, type Page } from '@playwright/test';

const MOCK = 'http://127.0.0.1:26680';

interface MockEvent {
  pressed: boolean;
  location: string;
  via: string;
}

async function mockEvents(): Promise<MockEvent[]> {
  return (await fetch(`${MOCK}/events`)).json();
}

async function mockPost(path: string) {
  await fetch(`${MOCK}${path}`, { method: 'POST' });
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await page.getByTestId('username').fill('admin');
  await page.getByTestId('password').fill('e2e-admin-password');
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('companion-lamp')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('key-0').locator('img')).toBeVisible();
}

async function pressAndRelease(page: Page, index: number, touch: boolean) {
  const key = page.getByTestId(`key-${index}`);
  if (touch) {
    await key.tap();
  } else {
    await key.hover();
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
  }
}

test.beforeEach(async () => {
  await mockPost('/resume-pong');
  await mockPost('/up');
  await mockPost('/reset');
});

test('renders exactly 32 square keys in an 8 × 4 grid', async ({ page }) => {
  await signIn(page);
  const keys = page.locator('[data-testid^="key-"][data-index]');
  await expect(keys).toHaveCount(32);
  const boxes = await keys.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: r.height })));
  expect(new Set(boxes.map((b) => b.x)).size).toBe(8);
  expect(new Set(boxes.map((b) => b.y)).size).toBe(4);
  for (const b of boxes) expect(Math.abs(b.w - b.h)).toBeLessThan(1);
  // Whole surface fits the viewport without scrolling
  const scroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(scroll).toBeLessThanOrEqual(1);
});

test('pressing a key sends press then release to Companion and live feedback updates', async ({ page }, info) => {
  await signIn(page);
  const touch = info.project.name.includes('touch');
  const before = await page.getByTestId('key-11').locator('img').getAttribute('src');
  await pressAndRelease(page, 11, touch); // PVW 4 on the ATEM page
  await expect.poll(async () => (await mockEvents()).map((e) => `${e.location}:${e.pressed}`)).toEqual(['1/1/3:true', '1/1/3:false']);
  await expect.poll(() => page.getByTestId('key-11').locator('img').getAttribute('src')).not.toBe(before);
});

test('pointer cancel releases the key', async ({ page }) => {
  await signIn(page);
  const key = page.getByTestId('key-4');
  await key.dispatchEvent('pointerdown', { pointerId: 7, isPrimary: true, button: 0, pointerType: 'touch' });
  await expect.poll(async () => (await mockEvents()).length).toBe(1);
  await key.dispatchEvent('pointercancel', { pointerId: 7, isPrimary: true, pointerType: 'touch' });
  await expect.poll(async () => (await mockEvents()).map((e) => e.pressed)).toEqual([true, false]);
});

test('long press does not open a context menu and does not select text', async ({ page }) => {
  await signIn(page);
  const prevented = await page.getByTestId('key-2').evaluate((el) => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true);
  const styles = await page.getByTestId('key-2').evaluate((el) => {
    const op = el.closest('.operator')!;
    const cs = getComputedStyle(op);
    return { userSelect: cs.userSelect || cs.webkitUserSelect, touchAction: getComputedStyle(el).touchAction };
  });
  expect(styles.userSelect).toBe('none');
  expect(styles.touchAction).toBe('none');
});

test('a Companion outage disables keys, sends nothing, and recovers without replay', async ({ page }) => {
  await signIn(page);
  await mockPost('/down'); // Companion unreachable
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('key-5').click({ force: true });
  await expect(page.getByTestId('toast').filter({ hasText: 'Companion offline' })).toBeVisible();
  await expect(page.getByTestId('key-5')).toHaveAttribute('aria-disabled', 'true');
  await mockPost('/up');
  await page.getByTestId('retry-companion').click();
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(500);
  expect(await mockEvents()).toEqual([]);
});

test('pages, folders and back navigation', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('page-name')).toHaveText('ATEM');
  await page.getByTestId('nav-next').click();
  await expect(page.getByTestId('page-name')).toHaveText('vMix');
  await page.getByTestId('key-29').click(); // Safety folder key
  await expect(page.getByTestId('page-name')).toContainText('Safety Controls');
  await page.getByTestId('nav-back').click();
  await expect(page.getByTestId('page-name')).toHaveText('vMix');
  // Navigation is restored after a reload
  await page.reload();
  await expect(page.getByTestId('page-name')).toHaveText('vMix');
  await page.getByTestId('nav-prev').click();
  await expect(page.getByTestId('page-name')).toHaveText('ATEM');
});

test('switching to the Companion surface profile shows Companion-owned keys', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('profile-select').selectOption({ label: 'Companion Surface' });
  await expect(page.getByTestId('page-name')).toHaveText('Companion page 1');
  await expect(page.getByTestId('key-0').locator('img')).toBeVisible();
  await page.getByTestId('key-0').click();
  await expect.poll(async () => (await mockEvents()).map((e) => `${e.via}:${e.location}`)).toContain('key:1/0/0');
  await page.getByTestId('profile-select').selectOption({ label: 'Show Control' });
  await expect(page.getByTestId('page-name')).toHaveText('ATEM');
});

test('editor changes a key label and the change persists', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('edit-button').click();
  await page.getByTestId('edit-key-31').click();
  const label = `Next ${Date.now() % 1000}`;
  await page.getByTestId('slot-label').fill(label);
  await page.getByTestId('save-profile').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Profile saved' })).toBeVisible();
  await page.getByTestId('back-to-surface').click();
  await expect(page.getByTestId('key-31')).toContainText(label);
  await page.reload();
  await expect(page.getByTestId('key-31')).toContainText(label);
});

test('unauthenticated visitors only see the sign-in form', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('sign-in')).toBeVisible();
  const res = await page.request.get('/api/profiles');
  expect(res.status()).toBe(401);
  await ctx.close();
});
