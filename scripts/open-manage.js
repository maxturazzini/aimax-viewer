const { chromium } = require('playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('scripts/.browser-session', { headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://marketplace.visualstudio.com/manage/publishers/maxturazzini');
  console.log('Aperto — chiudi il browser quando hai finito.');
  await page.waitForTimeout(600000);
  await ctx.close();
})();
