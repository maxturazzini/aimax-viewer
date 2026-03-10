/**
 * Step 2: Create PAT on Azure DevOps — naviga a vista con screenshots
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, '.browser-session');
const SHOT_DIR = '/tmp/pat-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let idx = 0;
async function shot(page, label) {
  const p = path.join(SHOT_DIR, `${String(++idx).padStart(2,'0')}-${label}.png`);
  await page.screenshot({ path: p }).catch(() => {});
  console.log(`📸 ${p}`);
  return p;
}

async function waitForAzureLogin(page, timeout = 300000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    let url = 'about:blank';
    try { url = page.url(); } catch(_) {}
    if (url !== last) { console.log('  url:', url); last = url; }
    const host = (() => { try { return new URL(url).hostname; } catch(_) { return ''; } })();
    // Only accept the real DevOps pages — skip OAuth popups / vssps intermediaries
    if (host === 'aex.dev.azure.com' || host === 'dev.azure.com') {
      // Make sure it's loaded (not a blank/transitional state)
      const title = await page.title().catch(() => '');
      console.log('  title:', title);
      if (title && !title.toLowerCase().includes('redirect') && url.length > 20) {
        return true;
      }
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

(async () => {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    slowMo: 300,
  });
  const page = context.pages()[0] || await context.newPage();

  // Keep browser open on any crash
  process.on('unhandledRejection', async (err) => {
    console.log('\n❌', err.message);
    await shot(page, 'crash').catch(() => {});
    console.log('Browser aperto — chiudi tu.\n');
  });

  // ── 1. LOGIN ────────────────────────────────────────────────────────────────
  console.log('\n🔐 Navigo su Azure DevOps...\n');
  await page.goto('https://aex.dev.azure.com/me').catch(() => {});
  await shot(page, 'start');

  const loggedIn = await waitForAzureLogin(page);
  if (!loggedIn) { console.log('❌ Timeout login'); return; }
  await shot(page, 'logged-in');

  // ── 2. "FEW MORE DETAILS" FORM ──────────────────────────────────────────────
  const body1 = await page.innerText('body').catch(() => '');
  if (body1.includes('few more details') || body1.includes('Your name')) {
    console.log('\n📝 Compilo form "few more details"...');
    const inputs = await page.$$('input[type="text"], input:not([type])');
    if (inputs[0]) await inputs[0].fill('Massimiliano Turazzini');
    if (inputs[1]) await inputs[1].fill('max@turazzini.com');
    const sel = await page.$('select');
    if (sel) await sel.selectOption({ label: 'Italy' }).catch(() => sel.selectOption('IT').catch(() => {}));
    await shot(page, 'form-filled');
    await page.locator('button:has-text("Continue")').click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, 'form-submitted');
  }

  // ── 3. GET ORG NAME ─────────────────────────────────────────────────────────
  let orgName = '';

  // Check current URL for org
  const afterFormUrl = page.url();
  const m1 = afterFormUrl.match(/dev\.azure\.com\/([^\/\?#]+)/);
  if (m1 && !['_usersSettings','me'].includes(m1[1])) orgName = m1[1];

  // If not found, look for org links on the /me page
  if (!orgName) {
    if (!page.url().includes('aex.dev.azure.com/me')) {
      await page.goto('https://aex.dev.azure.com/me').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
    }
    await shot(page, 'me-page');
    const links = await page.$$('a');
    for (const a of links) {
      const href = await a.getAttribute('href').catch(() => '') || '';
      const m = href.match(/dev\.azure\.com\/([^\/\?#]+)/);
      if (m && !['_usersSettings','me',''].includes(m[1])) {
        orgName = m[1]; break;
      }
    }
    // Also scan page text for org badge/header
    if (!orgName) {
      const pageHtml = await page.content().catch(() => '');
      const m2 = pageHtml.match(/dev\.azure\.com\/([a-zA-Z0-9\-_]+)/g);
      if (m2) {
        for (const u of m2) {
          const mm = u.match(/dev\.azure\.com\/([a-zA-Z0-9\-_]+)/);
          if (mm && !['_usersSettings','me'].includes(mm[1])) {
            orgName = mm[1]; break;
          }
        }
      }
    }
  }

  console.log('\n🏢 Org:', orgName || '(non trovato — uso devops home)');

  // ── 4. GO TO PAT PAGE ───────────────────────────────────────────────────────
  if (!orgName) {
    // Try to pick up org from devops home
    await page.goto('https://dev.azure.com').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, 'devops-home');
    const homeUrl = page.url();
    const m3 = homeUrl.match(/dev\.azure\.com\/([^\/\?#]+)/);
    if (m3 && !['_usersSettings','me'].includes(m3[1])) orgName = m3[1];
    console.log('  Org da home:', orgName);
  }

  if (!orgName) { console.log('❌ Org non trovato — naviga manualmente ai PAT.'); return; }

  const patUrl = `https://dev.azure.com/${orgName}/_usersSettings/tokens`;
  console.log('\n🔗 Navigo a:', patUrl);
  await page.goto(patUrl).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  await shot(page, 'pat-page');

  // ── 5. NEW TOKEN BUTTON ──────────────────────────────────────────────────────
  console.log('\n🆕 Cerco "+ New Token"...');
  const newBtn = await page.waitForSelector(
    'button:has-text("New Token"), a:has-text("New Token")',
    { timeout: 20000 }
  ).catch(async (e) => { await shot(page, 'no-new-token'); throw e; });

  await newBtn.click();
  await page.waitForTimeout(2000);
  await shot(page, 'token-form');

  // ── 6. FILL FORM ─────────────────────────────────────────────────────────────
  const nameEl = await page.waitForSelector(
    'input[aria-label="Name"], input[aria-label="Token name"], input[placeholder*="name" i]',
    { timeout: 10000 }
  );
  await nameEl.click({ clickCount: 3 });
  await nameEl.fill('vsce-aimax-viewer');
  console.log('  ✅ Nome: vsce-aimax-viewer');

  // Organization: click dropdown → All accessible organizations
  await page.locator('[aria-label*="Organization" i], button:has-text("maxturazzini")').first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.getByText('All accessible organizations', { exact: false }).first().click().catch(() => {});
  console.log('  ✅ Organization: All accessible organizations');

  // Expiration: click "30 days" dropdown → 1 year
  await page.locator('button:has-text("30 days"), [aria-label*="Expiration" i]').first().click().catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'expiry-dropdown-open');
  await page.getByText('1 year', { exact: false }).first().click().catch(() => {});
  console.log('  ✅ Expiration: 1 year');
  await shot(page, 'name-expiry');

  // Custom defined scopes (already selected from screenshot, but ensure)
  const customEl = page.getByText('Custom defined', { exact: false }).first();
  if (await customEl.count() > 0) { await customEl.click().catch(() => {}); }
  await page.waitForTimeout(1000);

  // Show all scopes to find Marketplace
  const showAllBtn = page.getByText('Show all scopes', { exact: false }).first();
  if (await showAllBtn.count() > 0) {
    await showAllBtn.click();
    console.log('  ✅ Show all scopes');
    await page.waitForTimeout(1500);
  }
  await shot(page, 'all-scopes');

  // ── 7. MARKETPLACE > MANAGE ──────────────────────────────────────────────────
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(500);
  await shot(page, 'marketplace');

  let scopeFound = false;
  for (const cb of await page.$$('input[type="checkbox"]')) {
    const txt = await cb.evaluate(el => (el.closest('tr,div,li') || el.parentElement)?.innerText || '');
    if (txt.toLowerCase().includes('manage') && txt.toLowerCase().includes('marketplace')) {
      if (!await cb.isChecked()) await cb.click();
      console.log('  ✅ Marketplace > Manage');
      scopeFound = true; break;
    }
  }
  if (!scopeFound) {
    console.log('  ⚠️  Non trovato — spunta Marketplace > Manage manualmente (15s)...');
    await shot(page, 'manual-scope');
    await page.waitForTimeout(15000);
  }

  await shot(page, 'before-create');

  // ── 8. CREATE ────────────────────────────────────────────────────────────────
  await page.locator('button:has-text("Create")').last().click().catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, 'after-create');

  // ── 9. READ TOKEN ─────────────────────────────────────────────────────────────
  console.log('\n⏳ Leggo il token...');
  try {
    const tokenEl = await page.waitForSelector(
      'input[readonly], input[aria-label*="token" i], code, .token-value',
      { timeout: 15000 }
    );
    const token = await tokenEl.inputValue().catch(() => tokenEl.innerText());
    if (token && token.length > 10) {
      fs.writeFileSync('/tmp/pat-token.txt', token);
      console.log('\n🎉 TOKEN:\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(token);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\n✅ Salvato in /tmp/pat-token.txt\n');
    } else throw new Error('troppo corto');
  } catch (_) {
    await shot(page, 'no-token');
    console.log('⚠️  Copia il token dal browser.\n');
  }

  console.log('Browser aperto 10 minuti. Chiudi quando hai il token.\n');
  await page.waitForTimeout(600000);
  await context.close();
})();
