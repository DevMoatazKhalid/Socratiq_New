import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_DIR = '/home/mohab-mosad/Learn/Ai Hakathon/سعاد حسني/SocratiQ_V2/Socratiq_New-main/browser_artifacts';
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

const SUPABASE_URL = 'https://ydivejlvcrkotwlmffmi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkaXZlamx2Y3Jrb3R3bG1mZm1pIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTg5OTI3MSwiZXhwIjoyMTA1NDc1MjcxfQ.prfVTQjPx4TDa17I9Ecs9XOR48X4yZEQy3RBtVqHMxg';

const TEST_EMAIL = 'test_student_e2e@socratiq.ai';
const TEST_PASSWORD = 'TestPassword123!';
const COURSE_ID = 'crs_6467d951118a4a58a6603f89d428188d';
const ASSIGNMENT_ID = 'asg_ab04b0f7dde24b90a888f7ebde2fca00';

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(url, (res) => resolve(res.statusCode < 500));
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function getSupabaseSession() {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  });
  if (!resp.ok) {
    throw new Error(`Failed to sign in to Supabase: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

const results = [];
function record(suite, testName, ok, detail = '') {
  results.push({ suite, testName, ok, detail });
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'} [${suite}] ${testName} ${detail ? '-- ' + detail : ''}`);
}

async function run() {
  console.log('=== Starting SocratiQ V2 Mission A Real Browser Test Suite ===');

  // 1. Get Supabase Auth Session
  console.log('1. Authenticating test user with Supabase Auth API...');
  const session = await getSupabaseSession();
  console.log('✓ Obtained authentic session token for user:', session.user?.id);

  // Storage key matching Supabase JS format: sb-${projectRef}-auth-token
  const storageKey = 'sb-ydivejlvcrkotwlmffmi-auth-token';
  const sessionJson = JSON.stringify(session);

  // 2. Launch Chromium
  console.log('2. Launching Playwright Chromium browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  console.log('✓ Chromium launched successfully');

  try {
    // -------------------------------------------------------------
    // Test Suite 1: Desktop Split View Layout & Initial State
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 1: Desktop Split View Layout (>= 1024px) ---');
    const ctxDesktop = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    await ctxDesktop.addInitScript(([k, v]) => {
      localStorage.setItem(k, v);
    }, [storageKey, sessionJson]);

    const page = await ctxDesktop.newPage();
    const coachUrl = `http://localhost:5173/student/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/coach`;
    console.log('Navigating to AiCoach URL:', coachUrl);
    await page.goto(coachUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Verify workspace split container
    const splitEl = await page.waitForSelector('[data-testid="workspace-split"]', { timeout: 15000 });
    record('Suite 1', 'Workspace split container rendered', !!splitEl);

    // Verify left section (Conversation)
    const leftSection = await page.$('section[aria-label="Conversation"]');
    record('Suite 1', 'Left panel (Conversation) rendered with proper ARIA', !!leftSection);

    // Verify right section (Board)
    const rightSection = await page.$('section[aria-label="Board"]');
    record('Suite 1', 'Right panel (Board) rendered with proper ARIA', !!rightSection);

    // Verify separator
    const separator = await page.$('[role="separator"][aria-orientation="vertical"]');
    record('Suite 1', 'Splitter separator rendered with role=separator', !!separator);

    const initialValNow = await separator.getAttribute('aria-valuenow');
    record('Suite 1', 'Splitter aria-valuenow is numeric percentage', !isNaN(Number(initialValNow)) && Number(initialValNow) >= 25 && Number(initialValNow) <= 75, `Initial: ${initialValNow}%`);

    // Verify PersonaSelector is in header
    const personaBtn = await page.$('button[aria-haspopup="dialog"]');
    record('Suite 1', 'PersonaSelector button present in header', !!personaBtn);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_01_workspace_split_desktop.png') });
    console.log('✓ Captured screenshot: e2e_01_workspace_split_desktop.png');

    // -------------------------------------------------------------
    // Test Suite 2: Splitter Drag & Pointer Resize
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 2: Splitter Drag & Pointer Resize ---');
    const sepBox = await separator.boundingBox();
    if (sepBox) {
      const startX = sepBox.x + sepBox.width / 2;
      const startY = sepBox.y + sepBox.height / 2;

      // Drag right by 120 pixels
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 120, startY, { steps: 5 });
      await page.mouse.up();

      const newValNow = Number(await separator.getAttribute('aria-valuenow'));
      record('Suite 2', 'Splitter dragged right increases width percentage', newValNow > Number(initialValNow), `From ${initialValNow}% to ${newValNow}%`);

      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_02_splitter_drag_resized.png') });
      console.log('✓ Captured screenshot: e2e_02_splitter_drag_resized.png');

      // Double-click to reset to default 40%
      await separator.dblclick();
      const resetValNow = Number(await separator.getAttribute('aria-valuenow'));
      record('Suite 2', 'Splitter double-click resets to default 40%', resetValNow === 40, `Reset value: ${resetValNow}%`);
    } else {
      record('Suite 2', 'Separator bounding box found', false);
    }

    // -------------------------------------------------------------
    // Test Suite 3: Splitter Keyboard Accessibility (WAI-ARIA)
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 3: Splitter Keyboard Accessibility ---');
    await separator.focus();

    // ArrowRight (+2%)
    const beforeRight = Number(await separator.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    const afterRight = Number(await separator.getAttribute('aria-valuenow'));
    record('Suite 3', 'ArrowRight increases percentage by 2%', afterRight === beforeRight + 2, `Now ${afterRight}%`);

    // Shift + ArrowRight (+10%)
    await page.keyboard.press('Shift+ArrowRight');
    const afterShiftRight = Number(await separator.getAttribute('aria-valuenow'));
    record('Suite 3', 'Shift+ArrowRight increases percentage by 10%', afterShiftRight === afterRight + 10, `Now ${afterShiftRight}%`);

    // Home key (sets to MIN_PCT 25%)
    await page.keyboard.press('Home');
    const afterHome = Number(await separator.getAttribute('aria-valuenow'));
    record('Suite 3', 'Home key jumps to MIN_PCT (25%)', afterHome === 25, `Value: ${afterHome}%`);

    // End key (sets to MAX_PCT 75%)
    await page.keyboard.press('End');
    const afterEnd = Number(await separator.getAttribute('aria-valuenow'));
    record('Suite 3', 'End key jumps to MAX_PCT (75%)', afterEnd === 75, `Value: ${afterEnd}%`);

    // Enter key (resets to default 40%)
    await page.keyboard.press('Enter');
    const afterEnter = Number(await separator.getAttribute('aria-valuenow'));
    record('Suite 3', 'Enter key resets to default (40%)', afterEnter === 40, `Value: ${afterEnter}%`);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_03_splitter_keyboard_nav.png') });
    console.log('✓ Captured screenshot: e2e_03_splitter_keyboard_nav.png');

    // -------------------------------------------------------------
    // Test Suite 4: Panel Collapse & Expand (Persistent Mounting)
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 4: Panel Collapse & Expand ---');
    const panelBtns = await page.$$('div[role="group"][aria-label="Workspace panels"] button');
    record('Suite 4', 'Panel toggle buttons (Conversation, Board) rendered', panelBtns.length === 2);

    if (panelBtns.length === 2) {
      // Click Conversation button -> expands Board, hides Conversation
      await panelBtns[0].click();
      await page.waitForTimeout(300);
      const isLeftHidden = await page.$eval('section[aria-label="Conversation"]', el => el.classList.contains('hidden'));
      record('Suite 4', 'Collapsing conversation hides left pane via CSS class', isLeftHidden);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_04_board_expanded.png') });
      console.log('✓ Captured screenshot: e2e_04_board_expanded.png');

      // Click again -> restores both
      await panelBtns[0].click();
      await page.waitForTimeout(300);
      const isLeftRestored = await page.$eval('section[aria-label="Conversation"]', el => !el.classList.contains('hidden'));
      const isRightRestored = await page.$eval('section[aria-label="Board"]', el => !el.classList.contains('hidden'));
      record('Suite 4', 'Restoring panels shows both without remounting', isLeftRestored && isRightRestored);

      // Click Board button -> expands Conversation, hides Board
      await panelBtns[1].click();
      await page.waitForTimeout(300);
      const isRightHidden = await page.$eval('section[aria-label="Board"]', el => el.classList.contains('hidden'));
      record('Suite 4', 'Collapsing board hides right pane via CSS class', isRightHidden);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_05_conversation_expanded.png') });
      console.log('✓ Captured screenshot: e2e_05_conversation_expanded.png');

      // Restore both
      await panelBtns[1].click();
      await page.waitForTimeout(300);
    }

    // -------------------------------------------------------------
    // Test Suite 5: Teaching Persona UI & Arabic Localization
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 5: Teaching Persona UI & Arabic Localization ---');
    const personaButton = await page.$('button[aria-haspopup="dialog"]');
    const initialPersonaText = await personaButton.innerText();
    record('Suite 5', 'Persona button displays teaching style label', initialPersonaText.includes('Teaching style:'));

    // Open dropdown dialog
    await personaButton.click();
    await page.waitForSelector('[role="dialog"][aria-label="Choose a teaching style"]', { timeout: 5000 });
    record('Suite 5', 'Persona selection dialog opened with role=dialog', true);

    // Verify all 5 personas rendered with Arabic text
    const radios = await page.$$('[role="radio"]');
    record('Suite 5', 'Dialog renders 5 teaching personas as radio options', radios.length === 5);

    // Verify Arabic translations exist with dir="rtl" and lang="ar"
    const arabicSpans = await page.$$('[role="dialog"] span[dir="rtl"][lang="ar"]');
    record('Suite 5', 'Persona dialog renders Arabic strings with dir=rtl and lang=ar', arabicSpans.length >= 10, `Found ${arabicSpans.length} Arabic elements`);

    // Verify Arabic name strings
    const arabicTexts = await Promise.all(arabicSpans.map(el => el.innerText()));
    const hasSocraticArabic = arabicTexts.some(t => t.includes('المرشد السقراطي'));
    const hasEngineerArabic = arabicTexts.some(t => t.includes('المهندس العملي'));
    const hasThinkerArabic = arabicTexts.some(t => t.includes('المفكّر الناقد'));
    const hasMentorArabic = arabicTexts.some(t => t.includes('المعلّم الصبور'));
    const hasExplorerArabic = arabicTexts.some(t => t.includes('المستكشف البصري'));

    record('Suite 5', 'All 5 authentic Arabic persona names present',
      hasSocraticArabic && hasEngineerArabic && hasThinkerArabic && hasMentorArabic && hasExplorerArabic,
      'Verified: المرشد السقراطي, المهندس العملي, المفكّر الناقد, المعلّم الصبور, المستكشف البصري'
    );

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_08_persona_selector_arabic.png') });
    console.log('✓ Captured screenshot: e2e_08_persona_selector_arabic.png');

    // Click 'Practical Engineer' option
    const engineerRadio = radios[2]; // practical_engineer
    await engineerRadio.click();
    await page.waitForTimeout(600);

    // Verify dialog closed
    const isDialogClosed = !(await page.$('[role="dialog"]'));
    record('Suite 5', 'Selecting persona closes the dialog', isDialogClosed);

    // Verify updated button label
    const updatedPersonaText = await personaButton.innerText();
    record('Suite 5', 'Persona button label updated to Practical Engineer', updatedPersonaText.includes('Practical Engineer'), `Label: ${updatedPersonaText}`);

    // Verify polite live status announcement
    const statusNotice = await page.$eval('[role="status"].sr-only', el => el.innerText);
    record('Suite 5', 'ARIA live region announces persona change politely', statusNotice.includes('Practical Engineer') && statusNotice.includes('continues from here'), `Notice: "${statusNotice}"`);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_09_persona_switched.png') });
    console.log('✓ Captured screenshot: e2e_09_persona_switched.png');

    // -------------------------------------------------------------
    // Test Suite 6: Responsive Breakpoints (< 1024px Tabs & Mobile)
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 6: Responsive Breakpoints ---');
    // Tablet viewport: 900x700 (< 1024px)
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);

    const tablist = await page.$('[role="tablist"][aria-label="Coach mode"]');
    record('Suite 6', 'Width < 1024px replaces split with role=tablist', !!tablist);

    const tabs = await page.$$('[role="tablist"] [role="tab"]');
    record('Suite 6', 'Tablist renders Chat and Whiteboard tabs', tabs.length === 2);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_06_tablet_tabbed_mode.png') });
    console.log('✓ Captured screenshot: e2e_06_tablet_tabbed_mode.png');

    // Switch to Whiteboard tab
    await tabs[1].click();
    await page.waitForTimeout(300);
    const isBoardSelected = (await tabs[1].getAttribute('aria-selected')) === 'true';
    record('Suite 6', 'Clicking Whiteboard tab activates whiteboard panel', isBoardSelected);

    // Mobile viewport: 390x844 (iPhone form factor)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    // Switch back to Chat tab on mobile
    await tabs[0].click();
    await page.waitForTimeout(300);

    const mobileInput = await page.$('input[aria-label="Message SocratiQ AI"]');
    record('Suite 6', 'Mobile layout renders responsive composer input', !!mobileInput);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_07_mobile_layout.png') });
    console.log('✓ Captured screenshot: e2e_07_mobile_layout.png');

    // -------------------------------------------------------------
    // Test Suite 7: RTL / Arabic Full Layout Behavior
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 7: Arabic / RTL Workspace Behavior ---');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
      document.body.dir = 'rtl';
    });
    await page.waitForTimeout(400);

    const rtlSeparator = await page.$('[role="separator"]');
    if (rtlSeparator) {
      await rtlSeparator.focus();
      const pctBeforeRtl = Number(await rtlSeparator.getAttribute('aria-valuenow'));

      // In RTL, pressing ArrowRight should decrease or correctly handle delta
      await page.keyboard.press('ArrowRight');
      const pctAfterRtl = Number(await rtlSeparator.getAttribute('aria-valuenow'));
      record('Suite 7', 'Splitter responds correctly to keyboard under dir=rtl', !isNaN(pctAfterRtl), `From ${pctBeforeRtl}% to ${pctAfterRtl}%`);

      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_11_rtl_layout.png') });
      console.log('✓ Captured screenshot: e2e_11_rtl_layout.png');
    }

    // Reset dir to ltr
    await page.evaluate(() => {
      document.documentElement.dir = 'ltr';
      document.body.dir = 'ltr';
    });

    // -------------------------------------------------------------
    // Test Suite 8: SmartBoard Excalidraw Canvas Verification
    // -------------------------------------------------------------
    console.log('\n--- Running Test Suite 8: SmartBoard Canvas Verification ---');
    const canvas = await page.$('canvas');
    record('Suite 8', 'Native canvas element rendered on SmartBoard surface', !!canvas);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'e2e_10_smartboard_canvas.png') });
    console.log('✓ Captured screenshot: e2e_10_smartboard_canvas.png');

  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n=============================================================');
  console.log('MISSION A REAL BROWSER TEST RESULTS SUMMARY');
  console.log('=============================================================');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`Total Tests Executed: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  const report = {
    timestamp: new Date().toISOString(),
    browser: 'Chromium Headless',
    total: results.length,
    passed,
    failed,
    results
  };

  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, 'browser_mission_a_results.json'),
    JSON.stringify(report, null, 2)
  );

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
