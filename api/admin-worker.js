// ============================================
// Blue Sky Cattery - Admin Worker
// Cloudflare Worker + D1 Database
// Dedicated admin portal with full management
// ============================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---- Utility Functions ----

function now() {
  return new Date().toISOString();
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'bluesky-cattery-salt-2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const computed = await hashPassword(password);
  return computed === hash;
}

function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

async function parseBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return request.json();
  }
  const text = await request.text();
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// ---- Session Management ----

const TOKEN_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours

async function createSession(db, userId, role) {
  const token = generateToken();
  const expires = new Date(Date.now() + TOKEN_EXPIRY).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, role, expires).run();
  return token;
}

async function validateSession(db, token) {
  if (!token) return null;
  const session = await db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, now()).first();
  return session;
}

// ---- Auto-Grading System ----

function gradeApplication(app) {
  const categories = {};
  const highlights = [];
  const risks = [];

  // ============ HOME ENVIRONMENT (max 25) ============
  let homeScore = 0;

  if (app.housing_type === 'house' && app.housing_own_rent === 'own') {
    homeScore += 15; highlights.push('Owns their own house');
  } else if (app.housing_type === 'house') {
    homeScore += 10;
  } else if (app.housing_type === 'townhouse') {
    homeScore += 8;
  } else if (app.housing_type === 'apartment') {
    homeScore += 5;
    if (app.housing_own_rent === 'rent' && !app.landlord_info) {
      risks.push('Rents apartment - no landlord verification provided');
    }
  } else {
    homeScore += 3;
  }

  if (app.housing_own_rent === 'rent' && app.landlord_info && app.landlord_info.length > 10) {
    homeScore += 3; highlights.push('Provided landlord contact for pet verification');
  }

  if (app.indoor_only === 'yes') {
    homeScore += 7;
  } else if (app.indoor_only === 'enclosed') {
    homeScore += 5; highlights.push('Has enclosed outdoor access (catio)');
  } else {
    homeScore += 0; risks.push('Plans outdoor access - Orientals must be indoor only');
  }

  categories.home = { score: homeScore, max: 25, label: 'Home Environment' };

  // ============ COMPANION & PETS (max 20) ============
  let companionScore = 0;
  const pets = (app.other_pets || '').toLowerCase();
  const petSource = (app.pet_source || '').toLowerCase();

  if (pets.includes('oriental') || pets.includes('siamese')) {
    companionScore += 20; highlights.push('Already has Oriental/Siamese companion');
  } else if (pets.includes('cat') || pets.includes('kitten')) {
    companionScore += 15; highlights.push('Has existing cat companion');
  } else if (pets.includes('getting') || pets.includes('plan') || pets.includes('will get') || pets.includes('two kittens') || pets.includes('pair')) {
    companionScore += 13; highlights.push('Plans to get companion cat');
  } else if (pets.includes('dog')) {
    companionScore += 7;
  } else if (pets.includes('no') || pets.includes('none') || pets.length < 5) {
    companionScore += 0; risks.push('No companion cat - Orientals require a feline companion');
  } else {
    companionScore += 5;
  }

  if (petSource.includes('breeder') || petSource.includes('rescue') || petSource.includes('shelter')) {
    companionScore = Math.min(companionScore + 2, 20);
  }

  categories.companion = { score: companionScore, max: 20, label: 'Companion & Pets' };

  // ============ EXPERIENCE & KNOWLEDGE (max 20) ============
  let expScore = 0;
  const exp = (app.cat_experience || '').toLowerCase();
  const why = (app.why_oriental || '').toLowerCase();
  const vocal = (app.vocal_comfort || '').toLowerCase();

  if (exp.includes('oriental') || exp.includes('siamese') || exp.includes('breeder') || exp.includes('show')) {
    expScore += 10; highlights.push('Experience with Oriental/Siamese breeds');
  } else if ((exp.includes('cat') || exp.includes('years')) && exp.length > 30) {
    expScore += 7;
  } else if (exp.includes('first') || exp.includes('new') || exp.includes('never')) {
    expScore += 2; risks.push('First-time cat owner');
  } else {
    expScore += 4;
  }

  const knowledgeWords = ['personality', 'intelligent', 'vocal', 'companion', 'bond', 'research', 'active', 'social', 'honk', 'dog-like', 'follow', 'attention'];
  const knowledgeCount = knowledgeWords.filter(w => why.includes(w)).length;
  if (knowledgeCount >= 4) { expScore += 7; highlights.push('Demonstrates strong breed knowledge'); }
  else if (knowledgeCount >= 2) { expScore += 5; }
  else if (why.length > 50) { expScore += 3; }
  else { expScore += 1; }

  if (vocal.includes('love') || vocal.includes('enjoy') || vocal.includes('excited') || vocal.includes('great') || vocal.includes('hilarious')) {
    expScore += 3; highlights.push('Enthusiastic about vocal personality');
  } else if (vocal.includes('fine') || vocal.includes('ok') || vocal.includes('handle')) {
    expScore += 2;
  } else if (vocal.includes('concern') || vocal.includes('worry') || vocal.includes('loud') || vocal.includes('annoying')) {
    expScore += 0; risks.push('Expressed concern about vocality');
  } else {
    expScore += 1;
  }

  categories.experience = { score: expScore, max: 20, label: 'Experience & Knowledge' };

  // ============ COMMITMENT & READINESS (max 20) ============
  let commitScore = 0;
  const adjust = (app.adjustment_plan || '').toLowerCase();
  const rehome = (app.rehome_circumstances || '').toLowerCase();
  const spay = (app.spay_neuter_opinion || '').toLowerCase();
  const enrich = (app.enrichment_plan || '').toLowerCase();
  const finance = (app.financial_readiness || '').toLowerCase();

  if (adjust.includes('patience') || adjust.includes('time') || adjust.includes('vet') || adjust.includes('work with') || adjust.includes('behaviorist')) {
    commitScore += 5; highlights.push('Thoughtful adjustment plan');
  } else if (adjust.length > 30) {
    commitScore += 3;
  } else {
    commitScore += 0;
  }

  if (rehome.includes('never') || rehome.includes('no circumstance') || rehome.includes('would not') || rehome.includes('not an option') || rehome.includes('lifetime')) {
    commitScore += 5; highlights.push('Committed to lifetime ownership');
  } else if (rehome.includes('last resort') || rehome.includes('only if') || rehome.includes('breeder first')) {
    commitScore += 3;
  } else if (rehome.length > 10) {
    commitScore += 0; risks.push('Listed circumstances for rehoming');
  } else {
    commitScore += 1;
  }

  if (app.purpose === 'pet') {
    if (spay.includes('agree') || spay.includes('absolutely') || spay.includes('support') || spay.includes('of course') || spay.includes('no problem') || spay.includes('plan to')) {
      commitScore += 3;
    } else if (spay.includes('understand') || spay.includes('fine')) {
      commitScore += 2;
    } else if (spay.includes('disagree') || spay.includes('against') || spay.includes('don\'t want')) {
      commitScore += 0; risks.push('Resistant to spay/neuter requirement');
    } else {
      commitScore += 1;
    }
  } else {
    commitScore += 2;
  }

  const enrichWords = ['tree', 'toys', 'play', 'climb', 'puzzle', 'feather', 'interactive', 'scratch', 'perch', 'window'];
  const enrichCount = enrichWords.filter(w => enrich.includes(w)).length;
  if (enrichCount >= 3) { commitScore += 4; highlights.push('Detailed enrichment plan'); }
  else if (enrichCount >= 1) { commitScore += 2; }
  else if (enrich.length > 20) { commitScore += 1; }
  else { commitScore += 0; risks.push('No enrichment plan provided'); }

  if (finance.includes('yes') || finance.includes('prepared') || finance.includes('budget') || finance.match(/\$?\d{3,}/)) {
    commitScore += 3;
  } else if (finance.length > 10) {
    commitScore += 2;
  } else {
    commitScore += 0;
  }

  categories.commitment = { score: commitScore, max: 20, label: 'Commitment & Readiness' };

  // ============ VETERINARY & RESPONSIBILITY (max 10) ============
  let vetScore = 0;

  if (app.vet_name && app.vet_phone) {
    vetScore += 8; highlights.push('Provided veterinarian reference');
  } else if (app.vet_name || app.vet_phone) {
    vetScore += 4;
  } else {
    vetScore += 0; risks.push('No veterinarian information provided');
  }

  if (app.pet_health_history && app.pet_health_history.length > 20) {
    vetScore += 2; highlights.push('Transparent about pet health history');
  }

  categories.veterinary = { score: Math.min(vetScore, 10), max: 10, label: 'Veterinary & Responsibility' };

  // ============ SCHEDULE & LIFESTYLE (max 5) ============
  let schedScore = 0;
  const work = (app.work_schedule || '').toLowerCase();

  if (work.includes('home') || work.includes('remote') || work.includes('wfh') || work.includes('retired') || work.includes('stay at home')) {
    schedScore += 5; highlights.push('Home most of the day');
  } else if (work.includes('part') || work.includes('flexible') || work.includes('hybrid')) {
    schedScore += 3;
  } else if (work.includes('8') || work.includes('9-5') || work.includes('full time') || work.includes('office')) {
    schedScore += 1; risks.push('Full-time away from home');
  } else {
    schedScore += 2;
  }

  categories.schedule = { score: schedScore, max: 5, label: 'Schedule & Lifestyle' };

  // ============ DECEPTION DETECTION (penalties only) ============
  let deceptionPenalty = 0;
  const deceptionFlags = [];

  const catCount = (app.verify_cat_count || '').toLowerCase().trim();
  const petsDesc = (app.other_pets || '').toLowerCase();
  if ((catCount === '0' || catCount === 'none' || catCount === 'zero' || catCount === 'no') &&
      (petsDesc.includes('cat') || petsDesc.includes('kitten'))) {
    deceptionPenalty += 10;
    deceptionFlags.push('INCONSISTENT: Claims 0 cats but mentioned cats in pet description');
    risks.push('Inconsistent answers about cat ownership');
  }
  if ((catCount === '1' || catCount === '2' || catCount === '3') &&
      (petsDesc.includes('no') || petsDesc.includes('none')) && !petsDesc.includes('dog')) {
    deceptionPenalty += 10;
    deceptionFlags.push('INCONSISTENT: Claims cats in verification but said no pets earlier');
    risks.push('Inconsistent answers about pet ownership');
  }

  const homeDesc = (app.verify_home_description || '').toLowerCase();
  if (app.housing_type === 'house' && (homeDesc.includes('apartment') || homeDesc.includes('studio') || homeDesc.includes('small unit'))) {
    deceptionPenalty += 8;
    deceptionFlags.push('INCONSISTENT: Selected house but describes apartment-like space');
    risks.push('Housing description contradicts selection');
  }

  if (app.surrender_history === 'no' && app.pet_history) {
    const history = app.pet_history.toLowerCase();
    if (history.includes('rehome') || history.includes('gave away') || history.includes('returned') || history.includes('had to give') || history.includes('found a home for')) {
      deceptionPenalty += 8;
      deceptionFlags.push('INCONSISTENT: Denied rehoming but pet history suggests otherwise');
      risks.push('Possible undisclosed pet rehoming');
    }
  }

  if (app.surrender_history === 'yes' && (!app.surrender_details || app.surrender_details.length < 20)) {
    deceptionPenalty += 5;
    deceptionFlags.push('Admitted rehoming but provided no meaningful explanation');
    risks.push('Admitted surrendering pet - insufficient explanation');
  }

  categories.deception = { score: -deceptionPenalty, max: 0, label: 'Consistency Check', flags: deceptionFlags };

  // ============ CALCULATE TOTAL ============
  let totalScore = 0;
  let totalMax = 0;
  Object.values(categories).forEach(cat => {
    if (cat.max > 0) { totalScore += cat.score; totalMax += cat.max; }
    else { totalScore += cat.score; }
  });

  totalScore = Math.max(0, Math.min(100, totalScore));

  if (app.purpose === 'breeding') {
    highlights.push('Requesting breeding rights - requires additional screening');
    risks.push('Breeding applicant - verify breeding program credentials');
  }
  if (app.purpose === 'show') {
    highlights.push('Show home applicant - verify show experience');
  }

  return {
    score: totalScore,
    categories,
    highlights,
    risks,
    maxScore: 100,
    grade: totalScore >= 80 ? 'Excellent' : totalScore >= 65 ? 'Good' : totalScore >= 45 ? 'Fair' : 'Needs Review'
  };
}

// ---- AI-Powered Application Analysis (Cloudflare Workers AI) ----

async function aiAnalyzeApplication(app, baseGrading, env) {
  try {
    const prompt = `You are an expert cat breeder evaluating adoption applications for Oriental Shorthair kittens. These are rare, high-maintenance, vocal cats that need experienced owners, companion cats, and indoor-only homes.

Analyze this application and provide a JSON response with:
1. "score_adjustment" (integer -15 to +15): adjust the base score up or down based on your analysis
2. "ai_highlights" (array of strings): additional positive signals you detected in their writing
3. "ai_risks" (array of strings): additional concerns or red flags
4. "sincerity" (1-10): how genuine and thoughtful are their responses
5. "knowledge" (1-10): how well do they actually understand the breed
6. "red_flags" (array of strings): any deception, vagueness, or concerning patterns
7. "summary" (string): 2-3 sentence overall assessment for the breeder

APPLICATION DATA:
- Purpose: ${app.purpose || 'pet'}
- Housing: ${app.housing_type} (${app.housing_own_rent})
- Household: ${app.household_members || 'Not provided'}
- Work Schedule: ${app.work_schedule || 'Not provided'}
- Current Pets: ${app.other_pets || 'None listed'}
- Pet Source: ${app.pet_source || 'Not provided'}
- Pet History: ${app.pet_history || 'Not provided'}
- Surrendered Pets: ${app.surrender_history || 'Not answered'} ${app.surrender_details || ''}
- Cat Experience: ${app.cat_experience || 'Not provided'}
- Why Oriental: ${app.why_oriental || 'Not provided'}
- Vocal Comfort: ${app.vocal_comfort || 'Not provided'}
- Adjustment Plan: ${app.adjustment_plan || 'Not provided'}
- Rehome Circumstances: ${app.rehome_circumstances || 'Not provided'}
- Indoor Only: ${app.indoor_only || 'Not answered'}
- Enrichment Plan: ${app.enrichment_plan || 'Not provided'}
- Spay/Neuter Opinion: ${app.spay_neuter_opinion || 'Not provided'}
- Financial Readiness: ${app.financial_readiness || 'Not provided'}
- Vet Name: ${app.vet_name || 'Not provided'}
- Vet Phone: ${app.vet_phone || 'Not provided'}
- Pet Health History: ${app.pet_health_history || 'Not provided'}
- Allergies: ${app.allergies || 'Not provided'}
- Verify Cat Count: ${app.verify_cat_count || 'Not provided'}
- Home Description: ${app.verify_home_description || 'Not provided'}
- How Found Us: ${app.how_found_us || 'Not provided'}

Base score from rules: ${baseGrading.score}/100

RESPOND WITH ONLY VALID JSON, no markdown, no explanation outside the JSON.`;

    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a cat breeder application reviewer. Respond ONLY with valid JSON. No markdown formatting.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 600
    });

    const responseText = aiResponse.response || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const analysis = JSON.parse(jsonMatch[0]);
    return {
      scoreAdjustment: Math.max(-15, Math.min(15, parseInt(analysis.score_adjustment) || 0)),
      aiHighlights: Array.isArray(analysis.ai_highlights) ? analysis.ai_highlights : [],
      aiRisks: Array.isArray(analysis.ai_risks) ? analysis.ai_risks : [],
      sincerity: parseInt(analysis.sincerity) || 5,
      knowledge: parseInt(analysis.knowledge) || 5,
      redFlags: Array.isArray(analysis.red_flags) ? analysis.red_flags : [],
      summary: analysis.summary || ''
    };
  } catch (e) {
    console.error('AI analysis failed:', e);
    return null;
  }
}

// ---- Brevo CRM Sync ----

// CRM pipeline lists: Leads(5) -> Approved(6) -> Active(7) -> Adopters(10) or Rejected(8)/Waitlist(9)/Flagged(11)
// Separate public signup lists (in portal-worker): Newsletter(12), Litter Waitlist(13)
const BREVO_LISTS = { leads: 5, approved: 6, active: 7, rejected: 8, waitlist: 9, adopters: 10, flagged: 11 };

let _brevoKey = null;

async function syncToBrevoCRM(lead, listId, extraAttrs) {
  if (!_brevoKey) return null;
  try {
    const attrs = {
      FIRSTNAME: (lead.name || '').split(' ')[0],
      LASTNAME: (lead.name || '').split(' ').slice(1).join(' '),
      PHONE: lead.phone || '',
      CITY_STATE: lead.city_state || '',
      HOME_ADDRESS: lead.home_address || '',
      LEAD_SOURCE: lead.source || 'website',
      LEAD_STATUS: lead.status || 'new',
      ...extraAttrs
    };

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': _brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: lead.email,
        attributes: attrs,
        listIds: [listId],
        updateEnabled: true
      })
    });
    const result = await res.json();
    return result.id || null;
  } catch (e) {
    console.error('Brevo sync failed:', e);
    return null;
  }
}

async function updateBrevoContact(email, attrs, addToLists, removeFromLists) {
  if (!_brevoKey) return;
  try {
    const body = { attributes: attrs };
    if (addToLists) body.listIds = addToLists;
    if (removeFromLists) body.unlinkListIds = removeFromLists;
    await fetch('https://api.brevo.com/v3/contacts/' + encodeURIComponent(email), {
      method: 'PUT',
      headers: { 'api-key': _brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { console.error('Brevo update failed:', e); }
}

// ---- Email Sending (via Brevo) ----

async function sendEmail(to, subject, body, toName) {
  if (!_brevoKey) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': _brevoKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Blue Sky Cattery', email: 'kittens@blueskycattery.com' },
        replyTo: { name: 'Blue Sky Cattery', email: 'kittens@reply.blueskycattery.com' },
        to: [{ email: to, name: toName || to }],
        subject: subject,
        textContent: body
      })
    });
    const result = await res.json();
    return !!result.messageId;
  } catch (e) {
    console.error('Email failed:', e);
    return false;
  }
}

// ---- Audit Log ----

async function writeAuditLog(db, userId, action, details) {
  try {
    await db.prepare('INSERT INTO audit_log (user_id, action, details, created_at) VALUES (?, ?, ?, ?)')
      .bind(userId, action, typeof details === 'string' ? details : JSON.stringify(details), now()).run();
  } catch (e) {
    console.error('Audit log write failed:', e);
  }
}

// ---- Route Handler ----

export default {
  async fetch(request, env) {
    _brevoKey = env.BREVO_API_KEY || null;

    // Ensure all tables and columns exist - batched into one DB round-trip
    try {
      await env.DB.batch([
        env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, user_id INTEGER, role TEXT, expires_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, details TEXT, created_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS cats (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, breed TEXT, role TEXT, sex TEXT, color TEXT, bio TEXT, photo_url TEXT, registration TEXT, health_tested INTEGER DEFAULT 0, status TEXT DEFAULT \'active\', sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS email_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, template_name TEXT, subject TEXT, body_template TEXT, trigger_event TEXT, days_after INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS grading_config (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, key TEXT, value TEXT, updated_at TEXT)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, r2_key TEXT NOT NULL, filename TEXT, sort_order INTEGER DEFAULT 0, uploaded_at TEXT, source TEXT DEFAULT \'admin\')'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, note TEXT, details JSON, created_by INTEGER, created_at TEXT)'),
      ]);
    } catch(e) {}
    // Column migrations (can't batch ALTER TABLE - they throw on existing columns)
    const alters = [
      'ALTER TABLE kittens ADD COLUMN deposit_amount REAL',
      'ALTER TABLE kittens ADD COLUMN deposit_received_date TEXT',
      'ALTER TABLE kittens ADD COLUMN deposit_method TEXT',
      'ALTER TABLE kittens ADD COLUMN balance_due REAL',
      'ALTER TABLE kittens ADD COLUMN payment_notes TEXT',
      'ALTER TABLE kittens ADD COLUMN go_home_checklist JSON',
      'ALTER TABLE users ADD COLUMN admin_notes TEXT',
      'ALTER TABLE users ADD COLUMN verification JSON',
    ];
    for (const sql of alters) { try { await env.DB.prepare(sql).run(); } catch(e) {} }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Extract auth token
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');

    try {

      // =====================
      // PUBLIC API ENDPOINTS
      // =====================

      // Public: Get active cats for website
      if (path === '/api/cats' && method === 'GET') {
        const cats = await env.DB.prepare("SELECT id, name, breed, role, sex, color, bio, photo_url, registration, health_tested FROM cats WHERE status = 'active' ORDER BY sort_order ASC, name ASC").all();
        return json({ cats: cats.results });
      }

      // =====================
      // AUTH ENDPOINTS
      // =====================

      // Login - admin only
      if (path === '/api/auth/login' && method === 'POST') {
        const { email, password } = await request.json();
        if (!email || !password) {
          return json({ error: 'Email and password required' }, 400);
        }

        const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND status = ?').bind(email, 'active').first();
        if (!user) {
          return json({ error: 'Invalid credentials' }, 401);
        }

        // REJECT non-admin users
        if (user.role !== 'admin') {
          return json({ error: 'Access denied. Admin accounts only.' }, 403);
        }

        // Handle initial admin setup
        if (user.password_hash === 'ADMIN_INITIAL_SETUP') {
          const hash = await hashPassword(password);
          await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(hash, now(), user.id).run();
          const sessionToken = await createSession(env.DB, user.id, user.role);
          return json({ success: true, token: sessionToken, role: user.role, needsPasswordChange: true });
        }

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
          return json({ error: 'Invalid credentials' }, 401);
        }

        const sessionToken = await createSession(env.DB, user.id, user.role);
        return json({ success: true, token: sessionToken, role: user.role });
      }

      // Logout
      // Forgot password
      if (path === '/api/auth/forgot-password' && method === 'POST') {
        const { email } = await parseBody(request);
        if (!email) return json({ error: 'Email required' }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND status = 'active' AND role = 'admin'").bind(email).first();
        if (!user) return json({ success: true, message: 'If an admin account exists, a reset link has been sent.' });
        const resetToken = generateToken();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await env.DB.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').bind(resetToken, expires, user.id).run();
        await sendEmail(email, 'Blue Sky Cattery Admin - Password Reset',
          'You requested a password reset for your Blue Sky Cattery admin account.\n\nClick this link to reset your password (expires in 1 hour):\nhttps://admin.blueskycattery.com/?reset=' + resetToken + '\n\nIf you did not request this, please secure your account immediately.\n\n- Blue Sky Cattery', user.email);
        return json({ success: true, message: 'If an admin account exists, a reset link has been sent.' });
      }

      // Reset password with token
      if (path === '/api/auth/reset-password' && method === 'POST') {
        const { token: resetToken, password } = await parseBody(request);
        if (!resetToken || !password) return json({ error: 'Token and new password required' }, 400);
        if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
        const user = await env.DB.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?').bind(resetToken, now()).first();
        if (!user) return json({ error: 'Invalid or expired reset link.' }, 400);
        const hash = await hashPassword(password);
        await env.DB.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, updated_at = ? WHERE id = ?').bind(hash, now(), user.id).run();
        await writeAuditLog(env.DB, user.id, 'password_reset', 'user', user.id, 'Password reset via forgot password link');
        return json({ success: true, message: 'Password has been reset.' });
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        if (token) {
          await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        }
        return json({ success: true });
      }

      // Check session
      if (path === '/api/auth/me' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const user = await env.DB.prepare('SELECT id, email, role, status FROM users WHERE id = ?').bind(session.user_id).first();
        return json({ user });
      }

      // =====================
      // ADMIN GUARD - all routes below require admin
      // =====================

      // Helper to validate admin session
      async function requireAdmin() {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return null;
        return session;
      }

      // =====================
      // ADMIN: LEADS
      // =====================

      // Get all leads (with optional search & filter)
      if (path === '/api/admin/leads' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const search = url.searchParams.get('search') || '';
        const status = url.searchParams.get('status') || '';
        const source = url.searchParams.get('source') || '';
        let sql = 'SELECT l.*, u.id as user_id FROM leads l LEFT JOIN users u ON u.lead_id = l.id WHERE 1=1';
        const params = [];
        if (search) { sql += " AND (LOWER(l.name) LIKE ? OR LOWER(l.email) LIKE ? OR LOWER(l.phone) LIKE ? OR LOWER(COALESCE(l.sex_preference,'')) LIKE ? OR LOWER(COALESCE(l.color_preference,'')) LIKE ? OR LOWER(COALESCE(l.temperament_preference,'')) LIKE ? OR LOWER(COALESCE(l.eye_color_preference,'')) LIKE ?)"; const s = '%'+search.toLowerCase()+'%'; params.push(s, s, s, s, s, s, s); }
        if (status) { sql += ' AND l.status = ?'; params.push(status); }
        if (source) { sql += ' AND l.source = ?'; params.push(source); }
        sql += ' ORDER BY l.created_at DESC';
        const leads = await env.DB.prepare(sql).bind(...params).all();
        return json({ leads: leads.results });
      }

      // Get single lead with messages
      if (path.match(/^\/api\/admin\/leads\/\d+$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const leadId = path.split('/').pop();
        const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
        const messages = await env.DB.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC').bind(leadId).all();
        return json({ lead, messages: messages.results });
      }

      // Update lead status
      if (path.match(/^\/api\/admin\/leads\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const leadId = path.split('/').pop();
        const { status } = await request.json();
        await env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), leadId).run();
        await writeAuditLog(env.DB, session.user_id, 'lead_status_change', { lead_id: leadId, status });
        return json({ success: true });
      }

      // Approve lead -> create applicant account
      if (path === '/api/admin/approve' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);

        const { lead_id } = await request.json();
        const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(lead_id).first();
        if (!lead) return json({ error: 'Lead not found' }, 404);

        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(lead.email).first();
        if (existingUser) return json({ error: 'User account already exists for this email' }, 400);

        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        await env.DB.prepare(
          'INSERT INTO users (lead_id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(lead_id, lead.email, passwordHash, 'applicant', 'active', now(), now()).run();

        await env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').bind('approved', now(), lead_id).run();

        // Move in Brevo: Leads -> Approved Applicants
        await updateBrevoContact(lead.email, { LEAD_STATUS: 'approved', APPLICANT_TYPE: 'applicant' }, [BREVO_LISTS.approved], [BREVO_LISTS.leads]);

        const emailBody = `Dear ${lead.name},\n\nThank you for your interest in Blue Sky Cattery! We're excited to invite you to complete our adoption application.\n\nYour login credentials:\nEmail: ${lead.email}\nPassword: ${password}\n\nPlease visit https://portal.blueskycattery.com to log in and complete your application.\n\nWe look forward to learning more about you!\n\nWarm regards,\nDeanna\nBlue Sky Cattery`;

        await sendEmail(lead.email, 'Welcome to Blue Sky Cattery - Application Portal Access', emailBody, lead.name);

        await env.DB.prepare('UPDATE users SET welcome_sent_at = ? WHERE email = ?').bind(now(), lead.email).run();

        await writeAuditLog(env.DB, session.user_id, 'lead_approved', { lead_id, name: lead.name, email: lead.email });

        return json({ success: true, message: 'Account created and welcome email sent', tempPassword: password });
      }

      // =====================
      // ADMIN: APPLICATIONS
      // =====================

      // Get all applications (with search & filter)
      if (path === '/api/admin/applications' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const search = url.searchParams.get('search') || '';
        const status = url.searchParams.get('status') || '';
        const purpose = url.searchParams.get('purpose') || '';
        let sql = 'SELECT a.*, u.email as user_email FROM applications a JOIN users u ON a.user_id = u.id WHERE 1=1';
        const params = [];
        if (search) { sql += ' AND (LOWER(a.full_name) LIKE ? OR LOWER(a.email) LIKE ?)'; params.push('%'+search.toLowerCase()+'%', '%'+search.toLowerCase()+'%'); }
        if (status) { sql += ' AND a.status = ?'; params.push(status); }
        if (purpose) { sql += ' AND a.purpose = ?'; params.push(purpose); }
        sql += ' ORDER BY a.created_at DESC';
        const apps = await env.DB.prepare(sql).bind(...params).all();
        return json({ applications: apps.results });
      }

      // Get single application
      if (path.match(/^\/api\/admin\/applications\/\d+$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const appId = path.split('/').pop();
        const app = await env.DB.prepare('SELECT a.*, u.email as user_email FROM applications a JOIN users u ON a.user_id = u.id WHERE a.id = ?').bind(appId).first();
        return json({ application: app });
      }

      // Update application status/notes
      if (path.match(/^\/api\/admin\/applications\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const appId = path.split('/').pop();
        const { status, admin_notes } = await request.json();
        const adminUser = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
        await env.DB.prepare('UPDATE applications SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
          .bind(status, admin_notes, adminUser.email, now(), now(), appId).run();
        await writeAuditLog(env.DB, session.user_id, 'application_status_change', { application_id: appId, status });
        return json({ success: true });
      }

      // Re-run AI analysis
      if (path.match(/^\/api\/admin\/applications\/\d+\/reanalyze$/) && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const appId = path.split('/')[4];
        const app = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first();
        if (!app) return json({ error: 'Application not found' }, 404);

        const grading = gradeApplication(app);
        let aiResult = null;
        if (env.AI) {
          aiResult = await aiAnalyzeApplication(app, grading, env);
        }

        if (aiResult) {
          grading.score = Math.max(0, Math.min(100, grading.score + aiResult.scoreAdjustment));
          grading.highlights = grading.highlights.concat(aiResult.aiHighlights);
          grading.risks = grading.risks.concat(aiResult.aiRisks);
          if (aiResult.redFlags.length > 0) grading.risks = grading.risks.concat(aiResult.redFlags.map(f => 'AI FLAG: ' + f));
          grading.categories.ai = {
            score: aiResult.scoreAdjustment,
            max: 15,
            label: 'AI Analysis',
            sincerity: aiResult.sincerity,
            knowledge: aiResult.knowledge,
            summary: aiResult.summary
          };
          grading.grade = grading.score >= 80 ? 'Excellent' : grading.score >= 65 ? 'Good' : grading.score >= 45 ? 'Fair' : 'Needs Review';
        }

        await env.DB.prepare('UPDATE applications SET score = ?, score_breakdown = ?, highlights = ?, risks = ?, updated_at = ? WHERE id = ?')
          .bind(grading.score, JSON.stringify(grading.categories), JSON.stringify(grading.highlights), JSON.stringify(grading.risks), now(), appId).run();

        return json({ success: true, score: grading.score, grade: grading.grade, aiResult: aiResult ? true : false });
      }

      // =====================
      // ADMIN: CANDIDATES
      // =====================

      if (path === '/api/admin/candidates' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);

        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ candidates: {} });
        const kittens = await env.DB.prepare('SELECT * FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();

        const candidates = {};
        for (const kitten of kittens.results) {
          const label = kitten.name || 'Kitten #' + kitten.number;
          const apps = await env.DB.prepare(`
            SELECT id, full_name, email, score, purpose, sex_preference, kitten_primary, kitten_backup1, kitten_backup2, status, highlights, risks
            FROM applications
            WHERE kitten_primary = ? OR kitten_backup1 = ? OR kitten_backup2 = ?
            ORDER BY score DESC
          `).bind(label, label, label).all();

          candidates[label] = apps.results.map(a => ({
            ...a,
            preference: a.kitten_primary === label ? 'Primary' : a.kitten_backup1 === label ? 'Backup 1' : 'Backup 2'
          }));
        }

        const sexOnly = await env.DB.prepare(`
          SELECT id, full_name, email, score, purpose, sex_preference, kitten_primary, status, highlights, risks
          FROM applications
          WHERE (kitten_primary IS NULL OR kitten_primary = '' OR kitten_primary = 'No preference')
          ORDER BY score DESC
        `).all();
        candidates['No Specific Preference'] = sexOnly.results;

        return json({ candidates, litter_code: litter.litter_code });
      }

      // =====================
      // ADMIN: LITTERS & KITTENS
      // =====================

      // Get litters with kittens
      if (path === '/api/admin/litters' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const litters = await env.DB.prepare('SELECT * FROM litters ORDER BY year DESC, dam_name ASC').all();
        const result = [];
        for (const litter of litters.results) {
          const kittens = await env.DB.prepare('SELECT * FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
          result.push({ ...litter, kittens: kittens.results });
        }
        return json({ litters: result });
      }

      // Add new litter
      if (path === '/api/admin/litters' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const data = await request.json();
        const code = data.year + '-' + data.dam_name;
        const result = await env.DB.prepare(
          'INSERT INTO litters (litter_code, year, dam_name, sire_name, born_date, go_home_date, total_kittens, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(code, data.year, data.dam_name, data.sire_name, data.born_date || null, data.go_home_date || null, data.total_kittens || 0, 'active', data.notes || null, now(), now()).run();
        const litterId = result.meta.last_row_id;
        for (let i = 1; i <= (data.total_kittens || 0); i++) {
          await env.DB.prepare(
            'INSERT INTO kittens (litter_id, number, name, color, status, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(litterId, i, 'Kitten #' + i, 'TBD', 'available', 1800, now(), now()).run();
        }
        return json({ success: true, litter_id: litterId, litter_code: code });
      }

      // Update kitten
      if (path.match(/^\/api\/admin\/kittens\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const kittenId = path.split('/').pop();
        const data = await request.json();
        const fields = [];
        const values = [];
        if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
        if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
        if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color); }
        if (data.sex !== undefined) { fields.push('sex = ?'); values.push(data.sex); }
        if (data.price !== undefined) { fields.push('price = ?'); values.push(data.price); }
        if (data.reserved_by !== undefined) { fields.push('reserved_by = ?'); values.push(data.reserved_by); }
        if (data.reserved_lead_id !== undefined) { fields.push('reserved_lead_id = ?'); values.push(data.reserved_lead_id); }
        if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
        if (data.deposit_amount !== undefined) { fields.push('deposit_amount = ?'); values.push(data.deposit_amount); }
        if (data.deposit_received_date !== undefined) { fields.push('deposit_received_date = ?'); values.push(data.deposit_received_date); }
        if (data.deposit_method !== undefined) { fields.push('deposit_method = ?'); values.push(data.deposit_method); }
        if (data.balance_due !== undefined) { fields.push('balance_due = ?'); values.push(data.balance_due); }
        if (data.payment_notes !== undefined) { fields.push('payment_notes = ?'); values.push(data.payment_notes); }
        fields.push('updated_at = ?'); values.push(now());
        values.push(kittenId);
        await env.DB.prepare('UPDATE kittens SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();
        return json({ success: true });
      }

      // =====================
      // ADMIN: STATS
      // =====================

      if (path === '/api/admin/stats' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);

        const totalLeads = await env.DB.prepare('SELECT COUNT(*) as count FROM leads').first();
        const newLeads = await env.DB.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").first();
        const totalApps = await env.DB.prepare('SELECT COUNT(*) as count FROM applications').first();
        const pendingApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'submitted'").first();
        const avgScore = await env.DB.prepare('SELECT AVG(score) as avg FROM applications').first();
        const availableKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'available'").first();
        const reservedKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'reserved' OR status = 'pending'").first();
        const soldKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'sold'").first();

        // Funnel data
        const approvedLeads = await env.DB.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'approved'").first();
        const rejectedApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'rejected'").first();
        const approvedApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'approved'").first();
        const waitlistApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'waitlist'").first();

        // Score distribution
        const scoreRanges = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN score >= 80 THEN 1 ELSE 0 END) as excellent,
            SUM(CASE WHEN score >= 65 AND score < 80 THEN 1 ELSE 0 END) as good,
            SUM(CASE WHEN score >= 45 AND score < 65 THEN 1 ELSE 0 END) as fair,
            SUM(CASE WHEN score < 45 THEN 1 ELSE 0 END) as needs_review
          FROM applications
        `).first();

        // Lead sources
        const sources = await env.DB.prepare(`
          SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC
        `).all();

        // Purpose breakdown
        const purposes = await env.DB.prepare(`
          SELECT purpose, COUNT(*) as count FROM applications WHERE purpose IS NOT NULL GROUP BY purpose ORDER BY count DESC
        `).all();

        // Recent activity (last 10 leads and apps)
        const recentLeads = await env.DB.prepare('SELECT id, name, email, source, status, created_at FROM leads ORDER BY created_at DESC LIMIT 10').all();
        const recentApps = await env.DB.prepare('SELECT id, full_name, email, score, status, purpose, created_at FROM applications ORDER BY created_at DESC LIMIT 10').all();

        // Email stats
        let emailsSent = { count: 0 };
        try { emailsSent = await env.DB.prepare('SELECT COUNT(*) as count FROM email_sent_log').first(); } catch(e) {}

        return json({
          stats: {
            totalLeads: totalLeads.count,
            newLeads: newLeads.count,
            approvedLeads: approvedLeads.count,
            totalApplications: totalApps.count,
            pendingApplications: pendingApps.count,
            approvedApplications: approvedApps.count,
            rejectedApplications: rejectedApps.count,
            waitlistApplications: waitlistApps.count,
            averageScore: Math.round(avgScore.avg || 0),
            availableKittens: availableKittens.count,
            reservedKittens: reservedKittens.count,
            soldKittens: soldKittens.count,
            emailsSent: emailsSent.count || 0
          },
          funnel: {
            leads: totalLeads.count,
            approved: approvedLeads.count,
            applied: totalApps.count,
            accepted: approvedApps.count,
            sold: soldKittens.count
          },
          scoreDistribution: {
            excellent: scoreRanges.excellent || 0,
            good: scoreRanges.good || 0,
            fair: scoreRanges.fair || 0,
            needsReview: scoreRanges.needs_review || 0
          },
          leadSources: sources.results,
          purposes: purposes.results,
          recentLeads: recentLeads.results,
          recentApps: recentApps.results
        });
      }

      // =====================
      // ADMIN: SETTINGS
      // =====================

      // Get all settings
      if (path === '/api/admin/settings' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const settings = await env.DB.prepare('SELECT * FROM config ORDER BY key ASC').all();
        return json({ settings: settings.results });
      }

      // Bulk update settings
      if (path === '/api/admin/settings' && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const { settings } = await request.json();
        if (!settings || typeof settings !== 'object') return json({ error: 'Settings object required' }, 400);

        for (const [key, value] of Object.entries(settings)) {
          await env.DB.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?')
            .bind(key, value, now(), value, now()).run();
        }
        await writeAuditLog(env.DB, session.user_id, 'settings_updated', { keys: Object.keys(settings) });
        return json({ success: true });
      }

      // =====================
      // ADMIN: CATS MANAGEMENT
      // =====================

      // List all cats
      if (path === '/api/admin/cats' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const cats = await env.DB.prepare('SELECT * FROM cats ORDER BY sort_order ASC, name ASC').all();
        return json({ cats: cats.results });
      }

      // Add a cat
      if (path === '/api/admin/cats' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const data = await request.json();
        const result = await env.DB.prepare(
          'INSERT INTO cats (name, breed, role, sex, color, bio, photo_url, registration, health_tested, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          data.name, data.breed || 'Oriental Shorthair', data.role || 'queen', data.sex || 'female',
          data.color || '', data.bio || '', data.photo_url || '', data.registration || '',
          data.health_tested ? 1 : 0, data.status || 'active', data.sort_order || 0, now(), now()
        ).run();
        await writeAuditLog(env.DB, session.user_id, 'cat_added', { name: data.name, role: data.role });
        return json({ success: true, id: result.meta.last_row_id });
      }

      // Update a cat
      if (path.match(/^\/api\/admin\/cats\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const catId = path.split('/').pop();
        const data = await request.json();
        const fields = [];
        const values = [];
        const allowed = ['name', 'breed', 'role', 'sex', 'color', 'bio', 'photo_url', 'registration', 'health_tested', 'status', 'sort_order'];
        for (const key of allowed) {
          if (data[key] !== undefined) {
            if (key === 'health_tested') {
              fields.push(key + ' = ?'); values.push(data[key] ? 1 : 0);
            } else {
              fields.push(key + ' = ?'); values.push(data[key]);
            }
          }
        }
        fields.push('updated_at = ?'); values.push(now());
        values.push(catId);
        await env.DB.prepare('UPDATE cats SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();
        await writeAuditLog(env.DB, session.user_id, 'cat_updated', { cat_id: catId, changes: Object.keys(data) });
        return json({ success: true });
      }

      // Soft-delete a cat
      if (path.match(/^\/api\/admin\/cats\/\d+$/) && method === 'DELETE') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const catId = path.split('/').pop();
        await env.DB.prepare("UPDATE cats SET status = 'inactive', updated_at = ? WHERE id = ?").bind(now(), catId).run();
        await writeAuditLog(env.DB, session.user_id, 'cat_deactivated', { cat_id: catId });
        return json({ success: true });
      }

      // =====================
      // ADMIN: EMAIL SCHEDULES
      // =====================

      // List email schedules
      if (path === '/api/admin/email-schedules' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const schedules = await env.DB.prepare('SELECT * FROM email_schedules ORDER BY trigger_event ASC, days_after ASC').all();
        return json({ schedules: schedules.results });
      }

      // Update email schedule
      if (path.match(/^\/api\/admin\/email-schedules\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const schedId = path.split('/').pop();
        const data = await request.json();
        const fields = [];
        const values = [];
        if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
        if (data.days_after !== undefined) { fields.push('days_after = ?'); values.push(data.days_after); }
        if (data.subject !== undefined) { fields.push('subject = ?'); values.push(data.subject); }
        if (data.body_template !== undefined) { fields.push('body_template = ?'); values.push(data.body_template); }
        fields.push('updated_at = ?'); values.push(now());
        values.push(schedId);
        await env.DB.prepare('UPDATE email_schedules SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();
        return json({ success: true });
      }

      // Send test email from template
      if (path.match(/^\/api\/admin\/email-schedules\/test\/\d+$/) && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const schedId = path.split('/').pop();
        const schedule = await env.DB.prepare('SELECT * FROM email_schedules WHERE id = ?').bind(schedId).first();
        if (!schedule) return json({ error: 'Schedule not found' }, 404);
        const adminUser = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
        const testBody = '[TEST EMAIL]\n\nTemplate: ' + schedule.template_name + '\nTrigger: ' + schedule.trigger_event + '\nDays After: ' + schedule.days_after + '\n\n---\n\n' + (schedule.body_template || '(no body template)');
        const sent = await sendEmail(adminUser.email, '[TEST] ' + (schedule.subject || schedule.template_name), testBody, 'Admin');
        return json({ success: sent, message: sent ? 'Test email sent to ' + adminUser.email : 'Failed to send test email' });
      }

      // =====================
      // ADMIN: GRADING CONFIG
      // =====================

      // Get grading config
      if (path === '/api/admin/grading' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const config = await env.DB.prepare('SELECT * FROM grading_config ORDER BY category ASC, key ASC').all();
        return json({ grading: config.results });
      }

      // Update grading config
      if (path === '/api/admin/grading' && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const { entries } = await request.json();
        if (!Array.isArray(entries)) return json({ error: 'entries array required' }, 400);
        for (const entry of entries) {
          if (entry.id) {
            await env.DB.prepare('UPDATE grading_config SET value = ?, updated_at = ? WHERE id = ?')
              .bind(entry.value, now(), entry.id).run();
          } else {
            await env.DB.prepare('INSERT INTO grading_config (category, key, value, updated_at) VALUES (?, ?, ?, ?)')
              .bind(entry.category, entry.key, entry.value, now()).run();
          }
        }
        await writeAuditLog(env.DB, session.user_id, 'grading_config_updated', { count: entries.length });
        return json({ success: true });
      }

      // =====================
      // ADMIN: EXPORT LEADS CSV
      if (path === '/api/admin/leads/export' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const leads = await env.DB.prepare('SELECT name, email, phone, source, status, home_address, marital_status, partner_name, partner_email, created_at FROM leads ORDER BY created_at DESC').all();
        let csv = 'Name,Email,Phone,Source,Status,Address,Marital Status,Partner Name,Partner Email,Created\n';
        leads.results.forEach(l => {
          csv += [l.name,l.email,l.phone||'',l.source,l.status,l.home_address||'',l.marital_status||'',l.partner_name||'',l.partner_email||'',l.created_at].map(v => '"' + (v||'').replace(/"/g, '""') + '"').join(',') + '\n';
        });
        return new Response(csv, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="leads-export.csv"' }});
      }

      // ADMIN: EXPORT APPLICATIONS CSV
      if (path === '/api/admin/applications/export' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const apps = await env.DB.prepare('SELECT full_name, email, phone, city_state, housing_type, housing_own_rent, other_pets, cat_experience, indoor_only, purpose, kitten_primary, sex_preference, score, status, created_at FROM applications WHERE status != ? ORDER BY created_at DESC').bind('draft').all();
        let csv = 'Name,Email,Phone,City,Housing,Own/Rent,Pets,Experience,Indoor,Purpose,Kitten Choice,Sex Pref,Score,Status,Submitted\n';
        apps.results.forEach(a => {
          csv += [a.full_name,a.email,a.phone||'',a.city_state||'',a.housing_type||'',a.housing_own_rent||'',a.other_pets||'',a.cat_experience||'',a.indoor_only||'',a.purpose||'',a.kitten_primary||'',a.sex_preference||'',a.score,a.status,a.created_at].map(v => '"' + String(v||'').replace(/"/g, '""') + '"').join(',') + '\n';
        });
        return new Response(csv, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="applications-export.csv"' }});
      }

      // ADMIN: SEND MESSAGE TO LEAD
      if (path === '/api/admin/send-message' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const { lead_id, subject, body } = await request.json();
        if (!lead_id || !subject || !body) return json({ error: 'lead_id, subject, and body required' }, 400);

        const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(lead_id).first();
        if (!lead) return json({ error: 'Lead not found' }, 404);

        // Send email via Brevo
        const sent = await sendEmail(lead.email, subject, body, lead.name);

        // Log the outbound message
        await env.DB.prepare('INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(lead_id, 'outbound', subject, body, now()).run();

        await writeAuditLog(env.DB, session.user_id, 'send_message', 'lead', lead_id, 'To: ' + lead.email + ' Subject: ' + subject);

        return json({ success: true, sent });
      }

      // ADMIN: NOTIFICATIONS (new leads + pending apps count)
      if (path === '/api/admin/notifications' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const newLeads = await env.DB.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").first();
        const pendingApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'submitted'").first();
        return json({
          newLeads: newLeads.count,
          pendingApps: pendingApps.count,
          total: newLeads.count + pendingApps.count
        });
      }

      // ADMIN: LITTER ANNOUNCEMENT - email all interested leads + waitlist
      if (path === '/api/admin/announce-litter' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const { litter_id, template_type, custom_message } = await request.json();

        const litter = await env.DB.prepare('SELECT * FROM litters WHERE id = ?').bind(litter_id).first();
        if (!litter) return json({ error: 'Litter not found' }, 404);

        // Find all recipients:
        // 1. Leads who didn't get a kitten (status: new, approved, contacted)
        // 2. Applicants on waitlist
        // 3. Applicants who were not approved for previous litters
        const leads = await env.DB.prepare(`
          SELECT DISTINCT l.email, l.name FROM leads l
          WHERE l.status IN ('new', 'approved', 'contacted')
          AND l.email NOT IN (SELECT reserved_by FROM kittens WHERE reserved_by IS NOT NULL AND status = 'sold')
        `).all();

        const waitlist = await env.DB.prepare(`
          SELECT DISTINCT a.email, a.full_name as name FROM applications a
          WHERE a.status IN ('waitlist', 'submitted', 'reviewed')
        `).all();

        // Deduplicate by email
        const recipientMap = {};
        leads.results.forEach(r => { recipientMap[r.email] = r.name; });
        waitlist.results.forEach(r => { recipientMap[r.email] = r.name; });

        // Remove admin emails
        delete recipientMap['Deanna@blueskycattery.com'];

        const recipients = Object.entries(recipientMap);
        const templateId = template_type === 'photos' ? 9 : 8;

        let sent = 0;
        let failed = 0;
        for (const [email, name] of recipients) {
          try {
            await fetch('https://api.brevo.com/v3/smtp/email', {
              method: 'POST',
              headers: { 'api-key': _brevoKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                templateId,
                to: [{ email, name: name || email }],
                params: {
                  FIRSTNAME: (name || '').split(' ')[0] || 'there',
                  LITTER_NAME: litter.litter_code,
                  SIRE: litter.sire_name,
                  DAM: litter.dam_name,
                  EXPECTED_DATE: litter.born_date || 'Coming soon',
                  ANNOUNCEMENT_MESSAGE: custom_message || 'We are thrilled to announce a new litter and wanted to reach out to you first!',
                  PHOTO_MESSAGE: custom_message || 'Head to our website to see photos of every kitten in this litter!'
                }
              })
            });
            sent++;
          } catch (e) { failed++; }
        }

        await writeAuditLog(env.DB, session.user_id, 'litter_announcement', 'litter', litter_id,
          template_type + ' sent to ' + sent + ' recipients (' + failed + ' failed)');

        return json({ success: true, sent, failed, total: recipients.length });
      }

      // ADMIN: TODO / ACTION CENTER
      if (path === '/api/admin/todo' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);

        // New leads needing review
        const newLeads = await env.DB.prepare("SELECT l.id, l.name, l.email, l.source, l.created_at, u.id as user_id FROM leads l LEFT JOIN users u ON u.lead_id = l.id WHERE l.status = 'new' ORDER BY l.created_at DESC").all();

        // Pending applications needing review
        const pendingApps = await env.DB.prepare("SELECT id, full_name, email, score, purpose, created_at FROM applications WHERE status = 'submitted' ORDER BY score DESC").all();

        // Approved apps not yet assigned a kitten
        const unassigned = await env.DB.prepare("SELECT id, full_name, email, score, kitten_primary FROM applications WHERE status = 'approved' AND (kitten_primary IS NULL OR kitten_primary = '')").all();

        // Kittens pending deposit
        const pendingKittens = await env.DB.prepare("SELECT k.id, k.name, k.number, k.reserved_by, l.litter_code FROM kittens k JOIN litters l ON k.litter_id = l.id WHERE k.status = 'pending'").all();

        // Reserved kittens approaching go-home (within 30 days)
        const soldKittens = await env.DB.prepare("SELECT k.id, k.name, k.number, k.reserved_by, l.litter_code, l.born_date FROM kittens k JOIN litters l ON k.litter_id = l.id WHERE k.status IN ('reserved', 'sold')").all();

        // Recent inbound messages (last 7 days, not yet responded to)
        const recentMessages = await env.DB.prepare(`
          SELECT m.id, m.lead_id, m.subject, m.created_at, l.name, l.email
          FROM messages m JOIN leads l ON m.lead_id = l.id
          WHERE m.direction = 'inbound' AND m.created_at > datetime('now', '-7 days')
          AND m.lead_id NOT IN (SELECT lead_id FROM messages WHERE direction = 'outbound' AND created_at > m.created_at)
          ORDER BY m.created_at DESC LIMIT 20
        `).all();

        // Upcoming scheduled emails (next 30 days for sold kittens)
        let upcomingEmails = [];
        try {
          const sentLog = await env.DB.prepare('SELECT kitten_id, schedule_id FROM email_sent_log').all();
          const sentSet = new Set(sentLog.results.map(r => r.kitten_id + '-' + r.schedule_id));
          const schedules = await env.DB.prepare("SELECT * FROM email_schedules WHERE active = 1 AND trigger_type = 'go_home' ORDER BY days_after ASC").all();

          for (const kitten of soldKittens.results) {
            if (!kitten.born_date) continue;
            const goHome = new Date(kitten.born_date);
            goHome.setDate(goHome.getDate() + 98);

            for (const sched of schedules.results) {
              if (sentSet.has(kitten.id + '-' + sched.id)) continue;
              const triggerDate = new Date(goHome);
              triggerDate.setDate(triggerDate.getDate() + sched.days_after);
              const daysUntil = Math.round((triggerDate - Date.now()) / 86400000);
              if (daysUntil >= -1 && daysUntil <= 30) {
                upcomingEmails.push({
                  kitten: kitten.name || 'Kitten #' + kitten.number,
                  recipient: kitten.reserved_by,
                  email_name: sched.name,
                  days_until: daysUntil,
                  trigger_date: triggerDate.toISOString().split('T')[0]
                });
              }
            }
          }
          upcomingEmails.sort((a, b) => a.days_until - b.days_until);
        } catch (e) { /* email_sent_log might not exist yet */ }

        // Unassigned photos
        let unassignedPhotos = [];
        try {
          const uPhotos = await env.DB.prepare("SELECT * FROM photos WHERE entity_type = 'unassigned' ORDER BY uploaded_at DESC").all();
          unassignedPhotos = uPhotos.results.map(p => ({ ...p, url: 'https://portal.blueskycattery.com/photos/' + p.r2_key }));
        } catch(e) {}

        // Red flag users - verification failures
        let redFlagUsers = [];
        try {
          const flagged = await env.DB.prepare("SELECT u.id, u.email, u.verification, l.name FROM users u LEFT JOIN leads l ON u.lead_id = l.id WHERE u.verification IS NOT NULL AND u.verification LIKE '%fail%'").all();
          redFlagUsers = flagged.results.map(u => {
            let v = {}; try { v = JSON.parse(u.verification); } catch(e) {}
            const fails = Object.entries(v).filter(([,val]) => val === 'fail').map(([key]) => key.replace(/_/g, ' '));
            return { id: u.id, email: u.email, name: u.name, fails };
          });
        } catch(e) {}

        return json({
          newLeads: newLeads.results,
          pendingApps: pendingApps.results,
          unassigned: unassigned.results,
          pendingKittens: pendingKittens.results,
          recentMessages: recentMessages.results,
          upcomingEmails: upcomingEmails,
          unassignedPhotos: unassignedPhotos,
          redFlagUsers: redFlagUsers
        });
      }

      // Delete a message
      if (path.match(/^\/api\/admin\/messages\/\d+$/) && method === 'DELETE') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const msgId = path.split('/').pop();
        await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msgId).run();
        await writeAuditLog(env.DB, session.user_id, 'message_deleted', { message_id: msgId });
        return json({ success: true });
      }

      // =====================
      // ADMIN: GO-HOME CHECKLIST
      // =====================

      // Update kitten go-home checklist
      if (path.match(/^\/api\/admin\/kittens\/\d+\/checklist$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const kittenId = path.split('/')[4];
        const data = await parseBody(request);
        if (!data.checklist) return json({ error: 'checklist object required' }, 400);
        // Merge with existing checklist
        const existing = await env.DB.prepare('SELECT go_home_checklist FROM kittens WHERE id = ?').bind(kittenId).first();
        let merged = {};
        try { merged = JSON.parse(existing.go_home_checklist || '{}'); } catch (e) {}
        Object.assign(merged, data.checklist);
        await env.DB.prepare('UPDATE kittens SET go_home_checklist = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(merged), now(), kittenId).run();
        return json({ success: true });
      }

      // Get kitten go-home checklist
      if (path.match(/^\/api\/admin\/kittens\/\d+\/checklist$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const kittenId = path.split('/')[4];
        const row = await env.DB.prepare('SELECT go_home_checklist FROM kittens WHERE id = ?').bind(kittenId).first();
        let checklist = {};
        try { checklist = JSON.parse((row && row.go_home_checklist) || '{}'); } catch (e) {}
        return json({ checklist });
      }

      // =====================
      // ADMIN: PHOTOS
      // =====================

      // Upload photos for a cat or kitten
      if (path === '/api/admin/photos/upload' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const data = await parseBody(request);
        const { entity_type, entity_id, photos } = data;

        if (!entity_type || !entity_id || !photos || !photos.length) {
          return json({ error: 'entity_type, entity_id, and photos[] required' }, 400);
        }
        if (!['cat', 'kitten'].includes(entity_type)) {
          return json({ error: 'entity_type must be cat or kitten' }, 400);
        }

        const results = [];
        for (const photo of photos) {
          if (!photo.data) continue;
          const ext = (photo.filename || 'photo.jpg').split('.').pop().toLowerCase();
          const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          const timestamp = Date.now();
          const r2Key = entity_type + 's/' + entity_id + '/' + timestamp + '.' + ext;

          // Decode base64 and upload to R2
          const binary = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));
          await env.PHOTOS.put(r2Key, binary, { httpMetadata: { contentType } });

          // Get current max sort_order
          const maxSort = await env.DB.prepare('SELECT MAX(sort_order) as m FROM photos WHERE entity_type = ? AND entity_id = ?').bind(entity_type, entity_id).first();
          const sortOrder = (maxSort && maxSort.m !== null) ? maxSort.m + 1 : 0;

          await env.DB.prepare('INSERT INTO photos (entity_type, entity_id, r2_key, filename, sort_order, uploaded_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(entity_type, entity_id, r2Key, photo.filename || 'photo.' + ext, sortOrder, now(), 'admin').run();

          // If this is the first photo (sort_order 0), update the entity's photo_url
          const photoUrl = 'https://portal.blueskycattery.com/photos/' + r2Key;
          if (sortOrder === 0) {
            const table = entity_type === 'cat' ? 'cats' : 'kittens';
            await env.DB.prepare('UPDATE ' + table + ' SET photo_url = ?, updated_at = ? WHERE id = ?').bind(photoUrl, now(), entity_id).run();
          }

          results.push({ r2Key, filename: photo.filename, url: photoUrl });
        }

        await writeAuditLog(env.DB, session.user_id, 'photos_uploaded', { entity_type, entity_id, count: results.length });
        return json({ success: true, uploaded: results });
      }

      // List photos for a cat or kitten
      if (path.match(/^\/api\/admin\/photos\/(cat|kitten)\/\d+$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const parts = path.split('/');
        const entityType = parts[4];
        const entityId = parts[5];
        const photos = await env.DB.prepare('SELECT * FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY sort_order ASC').bind(entityType, entityId).all();
        const photoList = photos.results.map(p => ({
          ...p,
          url: 'https://portal.blueskycattery.com/photos/' + p.r2_key
        }));
        return json({ photos: photoList });
      }

      // Delete a photo
      if (path.match(/^\/api\/admin\/photos\/\d+$/) && method === 'DELETE') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const photoId = path.split('/').pop();
        const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photoId).first();
        if (!photo) return json({ error: 'Photo not found' }, 404);

        // Delete from R2
        await env.PHOTOS.delete(photo.r2_key);
        await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run();

        // If this was the primary photo, update entity's photo_url to next photo or null
        if (photo.sort_order === 0) {
          const next = await env.DB.prepare('SELECT r2_key FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY sort_order ASC LIMIT 1').bind(photo.entity_type, photo.entity_id).first();
          const table = photo.entity_type === 'cat' ? 'cats' : 'kittens';
          const newUrl = next ? 'https://portal.blueskycattery.com/photos/' + next.r2_key : null;
          await env.DB.prepare('UPDATE ' + table + ' SET photo_url = ?, updated_at = ? WHERE id = ?').bind(newUrl, now(), photo.entity_id).run();
        }

        await writeAuditLog(env.DB, session.user_id, 'photo_deleted', { photo_id: photoId, r2_key: photo.r2_key });
        return json({ success: true });
      }

      // Set a photo as primary
      if (path.match(/^\/api\/admin\/photos\/\d+\/primary$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const photoId = path.split('/')[4];
        const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photoId).first();
        if (!photo) return json({ error: 'Photo not found' }, 404);

        // Reset all sort_orders for this entity, set this one to 0
        await env.DB.prepare('UPDATE photos SET sort_order = sort_order + 1 WHERE entity_type = ? AND entity_id = ?').bind(photo.entity_type, photo.entity_id).run();
        await env.DB.prepare('UPDATE photos SET sort_order = 0 WHERE id = ?').bind(photoId).run();

        // Update entity photo_url
        const photoUrl = 'https://portal.blueskycattery.com/photos/' + photo.r2_key;
        const table = photo.entity_type === 'cat' ? 'cats' : 'kittens';
        await env.DB.prepare('UPDATE ' + table + ' SET photo_url = ?, updated_at = ? WHERE id = ?').bind(photoUrl, now(), photo.entity_id).run();

        return json({ success: true });
      }

      // Reassign a photo to a different cat/kitten (or from unassigned)
      if (path.match(/^\/api\/admin\/photos\/\d+\/assign$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const photoId = path.split('/')[4];
        const data = await parseBody(request);
        const { entity_type, entity_id } = data;
        if (!entity_type || !entity_id || !['cat', 'kitten'].includes(entity_type)) {
          return json({ error: 'entity_type (cat/kitten) and entity_id required' }, 400);
        }

        const photo = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(photoId).first();
        if (!photo) return json({ error: 'Photo not found' }, 404);

        // Get next sort_order for new entity
        const maxSort = await env.DB.prepare('SELECT MAX(sort_order) as m FROM photos WHERE entity_type = ? AND entity_id = ?').bind(entity_type, entity_id).first();
        const sortOrder = (maxSort && maxSort.m !== null) ? maxSort.m + 1 : 0;

        await env.DB.prepare('UPDATE photos SET entity_type = ?, entity_id = ?, sort_order = ?, uploaded_at = ? WHERE id = ?')
          .bind(entity_type, entity_id, sortOrder, now(), photoId).run();

        // If this is the first photo for the entity, set as photo_url
        if (sortOrder === 0) {
          const table = entity_type === 'cat' ? 'cats' : 'kittens';
          await env.DB.prepare('UPDATE ' + table + ' SET photo_url = ?, updated_at = ? WHERE id = ?')
            .bind('https://portal.blueskycattery.com/photos/' + photo.r2_key, now(), entity_id).run();
        }

        await writeAuditLog(env.DB, session.user_id, 'photo_assigned', { photo_id: photoId, from: photo.entity_type + '/' + photo.entity_id, to: entity_type + '/' + entity_id });
        return json({ success: true });
      }

      // Get unassigned photos
      if (path === '/api/admin/photos/unassigned' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const photos = await env.DB.prepare("SELECT * FROM photos WHERE entity_type = 'unassigned' ORDER BY uploaded_at DESC").all();
        const photoList = photos.results.map(p => ({ ...p, url: 'https://portal.blueskycattery.com/photos/' + p.r2_key }));
        return json({ photos: photoList });
      }

      // ADMIN: AUDIT LOG
      // =====================

      if (path === '/api/admin/audit' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const logs = await env.DB.prepare('SELECT a.*, u.email as user_email FROM audit_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 100').all();
        return json({ audit: logs.results });
      }

      // =====================
      // ADMIN: USER MANAGEMENT
      // =====================

      // List all users
      if (path === '/api/admin/users' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const search = url.searchParams.get('search') || '';

        let sql = "SELECT u.id, u.email, u.role, u.status, u.lead_id, u.welcome_sent_at, u.admin_notes, u.verification, u.created_at, u.updated_at, l.name as lead_name, l.phone as lead_phone FROM users u LEFT JOIN leads l ON u.lead_id = l.id WHERE 1=1";
        const params = [];
        if (search) {
          sql += " AND (LOWER(u.email) LIKE ? OR LOWER(COALESCE(l.name,'')) LIKE ? OR LOWER(COALESCE(l.phone,'')) LIKE ? OR LOWER(COALESCE(u.admin_notes,'')) LIKE ?)";
          const s = '%' + search.toLowerCase() + '%';
          params.push(s, s, s, s);
        }
        sql += ' ORDER BY u.created_at DESC';
        try {
          const users = await env.DB.prepare(sql).bind(...params).all();
          return json({ users: users.results });
        } catch (err) {
          // Fallback without verification column if it doesn't exist yet
          const fallbackSql = "SELECT u.id, u.email, u.role, u.status, u.lead_id, u.welcome_sent_at, u.admin_notes, u.created_at, u.updated_at, l.name as lead_name, l.phone as lead_phone FROM users u LEFT JOIN leads l ON u.lead_id = l.id ORDER BY u.created_at DESC";
          const users = await env.DB.prepare(fallbackSql).all();
          return json({ users: users.results });
        }
      }

      // Update user
      if (path.match(/^\/api\/admin\/users\/\d+$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/').pop();
        const data = await request.json();
        const fields = [];
        const values = [];
        if (data.role !== undefined) { fields.push('role = ?'); values.push(data.role); }
        if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
        if (data.admin_notes !== undefined) { fields.push('admin_notes = ?'); values.push(data.admin_notes); }
        fields.push('updated_at = ?'); values.push(now());
        values.push(userId);
        await env.DB.prepare('UPDATE users SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();

        // Sync admin notes to Brevo CRM
        if (data.admin_notes !== undefined) {
          const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
          if (user) {
            await updateBrevoContact(user.email, { ADMIN_NOTES: data.admin_notes }, [], []);
          }
        }

        await writeAuditLog(env.DB, session.user_id, 'user_updated', { target_user_id: userId, changes: data });
        return json({ success: true });
      }

      // Get trust rating for a user
      if (path.match(/^\/api\/admin\/users\/\d+\/trust$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/')[4];

        // Ensure verification columns exist
        try { await env.DB.prepare("ALTER TABLE users ADD COLUMN verification JSON").run(); } catch(e) {}

        const user = await env.DB.prepare('SELECT u.*, l.name, l.phone, l.email as lead_email, l.home_address FROM users u LEFT JOIN leads l ON u.lead_id = l.id WHERE u.id = ?').bind(userId).first();
        if (!user) return json({ error: 'User not found' }, 404);

        // ---- IDENTITY RISK: Duplicate Detection ----
        const duplicates = [];
        // Same phone, different email
        if (user.phone) {
          const phoneMatches = await env.DB.prepare('SELECT l.id, l.name, l.email, l.phone, l.source, u2.id as user_id FROM leads l LEFT JOIN users u2 ON u2.lead_id = l.id WHERE l.phone = ? AND l.email != ? AND l.phone IS NOT NULL').bind(user.phone, user.email).all();
          phoneMatches.results.forEach(m => duplicates.push({ type: 'Same phone', name: m.name, email: m.email, has_account: !!m.user_id, user_id: m.user_id }));
        }
        // Same name, different email (fuzzy)
        if (user.name) {
          const nameMatches = await env.DB.prepare('SELECT l.id, l.name, l.email, l.phone, u2.id as user_id FROM leads l LEFT JOIN users u2 ON u2.lead_id = l.id WHERE LOWER(l.name) = LOWER(?) AND l.email != ?').bind(user.name, user.email).all();
          nameMatches.results.forEach(m => duplicates.push({ type: 'Same name', name: m.name, email: m.email, phone: m.phone, has_account: !!m.user_id, user_id: m.user_id }));
        }
        // Same address, different email
        if (user.home_address && user.home_address.length > 5) {
          const addrMatches = await env.DB.prepare('SELECT l.id, l.name, l.email, u2.id as user_id FROM leads l LEFT JOIN users u2 ON u2.lead_id = l.id WHERE LOWER(l.home_address) = LOWER(?) AND l.email != ?').bind(user.home_address, user.email).all();
          addrMatches.results.forEach(m => duplicates.push({ type: 'Same address', name: m.name, email: m.email, has_account: !!m.user_id, user_id: m.user_id }));
        }

        // Check for multiple applications with different responses
        const allApps = await env.DB.prepare('SELECT id, full_name, email, phone, city_state, housing_type, score, status, created_at FROM applications WHERE user_id IN (SELECT u2.id FROM users u2 JOIN leads l2 ON u2.lead_id = l2.id WHERE l2.phone = ? OR LOWER(l2.name) = LOWER(?))').bind(user.phone || '___none___', user.name || '___none___').all();
        const appInconsistencies = [];
        if (allApps.results.length > 1) {
          const first = allApps.results[0];
          allApps.results.slice(1).forEach(a => {
            if (a.housing_type && first.housing_type && a.housing_type !== first.housing_type) appInconsistencies.push('Housing type differs: ' + first.housing_type + ' vs ' + a.housing_type);
            if (a.city_state && first.city_state && a.city_state.toLowerCase() !== first.city_state.toLowerCase()) appInconsistencies.push('Location differs: ' + first.city_state + ' vs ' + a.city_state);
          });
        }

        // Identity risk score (0 = clean, higher = more risk)
        let identityRisk = 0;
        if (duplicates.length > 0) identityRisk += duplicates.length * 15;
        if (duplicates.some(d => d.has_account)) identityRisk += 20; // Multiple actual accounts
        if (appInconsistencies.length > 0) identityRisk += appInconsistencies.length * 10;
        identityRisk = Math.min(100, identityRisk);

        // ---- VERIFICATION SCORE: Admin-rated items ----
        let verification = {};
        try { verification = user.verification ? JSON.parse(user.verification) : {}; } catch(e) {}

        const verifyItems = [
          { key: 'email_works', label: 'Email deliverable', weight: 15 },
          { key: 'phone_works', label: 'Phone number works', weight: 20 },
          { key: 'vet_exists', label: 'Vet clinic exists', weight: 15 },
          { key: 'vet_confirms_pet', label: 'Vet confirms pet history', weight: 20 },
          { key: 'identity_consistent', label: 'Identity info consistent', weight: 15 },
          { key: 'references_check', label: 'References / social media check', weight: 15 }
        ];

        // Calculate verification score
        let verifiedPoints = 0, maxPoints = 0, checkedCount = 0;
        verifyItems.forEach(item => {
          maxPoints += item.weight;
          const val = verification[item.key]; // 'pass', 'fail', 'concern', or undefined
          if (val === 'pass') { verifiedPoints += item.weight; checkedCount++; }
          else if (val === 'concern') { verifiedPoints += Math.round(item.weight * 0.5); checkedCount++; }
          else if (val === 'fail') { checkedCount++; } // 0 points
          // undefined = not checked yet
        });

        const verificationScore = maxPoints > 0 ? Math.round((verifiedPoints / maxPoints) * 100) : null;
        const verificationStatus = checkedCount === 0 ? 'not_started' : checkedCount < verifyItems.length ? 'partial' : 'complete';

        // ---- OVERALL TRUST RATING ----
        let overallRating = 'limited';
        let overallScore = null;
        const app = await env.DB.prepare('SELECT score FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first();
        const appScore = app ? app.score : null;

        if (verificationStatus === 'not_started') {
          overallRating = 'limited';
          overallScore = null; // Can't compute without verification
        } else {
          // Weighted: 40% app score, 30% verification, 30% identity (inverted)
          const identityClean = Math.max(0, 100 - identityRisk);
          overallScore = Math.round(
            (appScore || 50) * 0.4 +
            (verificationScore || 50) * 0.3 +
            identityClean * 0.3
          );
          if (overallScore >= 80) overallRating = 'trusted';
          else if (overallScore >= 60) overallRating = 'moderate';
          else if (overallScore >= 40) overallRating = 'caution';
          else overallRating = 'high_risk';
        }

        return json({
          userId,
          identity: { risk: identityRisk, duplicates, inconsistencies: appInconsistencies, relatedApps: allApps.results.length },
          verification: { status: verificationStatus, score: verificationScore, items: verifyItems.map(i => ({ ...i, value: verification[i.key] || 'not_checked', detail: verification[i.key + '_detail'] || '' })), checkedCount },
          overall: { rating: overallRating, score: overallScore, appScore },
        });
      }

      // Save verification ratings for a user
      if (path.match(/^\/api\/admin\/users\/\d+\/verify$/) && method === 'PUT') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/')[4];
        const data = await parseBody(request);

        try { await env.DB.prepare("ALTER TABLE users ADD COLUMN verification JSON").run(); } catch(e) {}

        // Merge with existing verification data
        const user = await env.DB.prepare('SELECT verification, email FROM users WHERE id = ?').bind(userId).first();
        if (!user) return json({ error: 'User not found' }, 404);
        let existing = {};
        try { existing = user.verification ? JSON.parse(user.verification) : {}; } catch(e) {}
        const merged = { ...existing, ...data.verification };

        await env.DB.prepare('UPDATE users SET verification = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(merged), now(), userId).run();

        // Sync to Brevo
        const passCount = Object.values(merged).filter(v => v === 'pass').length;
        const failCount = Object.values(merged).filter(v => v === 'fail').length;
        const totalChecked = Object.values(merged).filter(v => v !== 'not_checked' && v !== undefined).length;
        await updateBrevoContact(user.email, {
          ADMIN_NOTES: (user.admin_notes || '') + (user.admin_notes ? ' | ' : '') + 'Verified: ' + passCount + '/' + totalChecked + ' pass, ' + failCount + ' fail'
        }, [], []);

        await writeAuditLog(env.DB, session.user_id, 'user_verification_updated', { target_user_id: userId, verification: merged });
        return json({ success: true });
      }

      // Get activity log for a user
      if (path.match(/^\/api\/admin\/users\/\d+\/activity$/) && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/')[4];
        const entries = await env.DB.prepare('SELECT a.*, u.email as created_by_email FROM activity_log a LEFT JOIN users u ON a.created_by = u.id WHERE a.user_id = ? ORDER BY a.created_at DESC').bind(userId).all();
        return json({ entries: entries.results });
      }

      // Create activity log entry for a user
      if (path.match(/^\/api\/admin\/users\/\d+\/activity$/) && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/')[4];
        const { type, note, details } = await parseBody(request);
        if (!type) return json({ error: 'Type is required' }, 400);
        const validTypes = ['call', 'email', 'note', 'vet_check', 'video_visit', 'verification', 'system'];
        if (!validTypes.includes(type)) return json({ error: 'Invalid type' }, 400);
        const result = await env.DB.prepare('INSERT INTO activity_log (user_id, type, note, details, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(userId, type, note || '', details ? JSON.stringify(details) : null, session.user_id, now()).run();
        return json({ success: true, id: result.meta.last_row_id });
      }

      // Merge two user accounts (keep primary, absorb secondary)
      if (path === '/api/admin/users/merge' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const { primary_id, secondary_id } = await parseBody(request);
        if (!primary_id || !secondary_id || primary_id === secondary_id) {
          return json({ error: 'Two different user IDs required' }, 400);
        }

        const primary = await env.DB.prepare('SELECT u.*, l.name as lead_name, l.email as lead_email FROM users u LEFT JOIN leads l ON u.lead_id = l.id WHERE u.id = ?').bind(primary_id).first();
        const secondary = await env.DB.prepare('SELECT u.*, l.name as lead_name, l.email as lead_email FROM users u LEFT JOIN leads l ON u.lead_id = l.id WHERE u.id = ?').bind(secondary_id).first();
        if (!primary || !secondary) return json({ error: 'One or both users not found' }, 404);
        if (primary.role === 'admin' || secondary.role === 'admin') return json({ error: 'Cannot merge admin accounts' }, 400);

        const merged = [];

        // Move activity log entries
        const actMoved = await env.DB.prepare('UPDATE activity_log SET user_id = ? WHERE user_id = ?').bind(primary_id, secondary_id).run();
        merged.push('Activity entries: ' + (actMoved.meta.changes || 0));

        // Move applications
        const appsMoved = await env.DB.prepare('UPDATE applications SET user_id = ? WHERE user_id = ?').bind(primary_id, secondary_id).run();
        merged.push('Applications: ' + (appsMoved.meta.changes || 0));

        // Move messages (via lead_id)
        if (secondary.lead_id && primary.lead_id) {
          const msgsMoved = await env.DB.prepare('UPDATE messages SET lead_id = ? WHERE lead_id = ?').bind(primary.lead_id, secondary.lead_id).run();
          merged.push('Messages: ' + (msgsMoved.meta.changes || 0));
        }

        // Move sessions
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(secondary_id).run();

        // Merge admin notes
        if (secondary.admin_notes) {
          const combinedNotes = (primary.admin_notes || '') + (primary.admin_notes ? '\n---\n' : '') + '[Merged from ' + secondary.email + ']: ' + secondary.admin_notes;
          await env.DB.prepare('UPDATE users SET admin_notes = ? WHERE id = ?').bind(combinedNotes, primary_id).run();
          merged.push('Notes merged');
        }

        // Merge verification data
        if (secondary.verification) {
          try {
            const pv = primary.verification ? JSON.parse(primary.verification) : {};
            const sv = JSON.parse(secondary.verification);
            // Only copy items from secondary that primary doesn't have
            Object.entries(sv).forEach(([k, v]) => { if (!pv[k] || pv[k] === 'not_checked') pv[k] = v; });
            await env.DB.prepare('UPDATE users SET verification = ? WHERE id = ?').bind(JSON.stringify(pv), primary_id).run();
            merged.push('Verification merged');
          } catch(e) {}
        }

        // Log the merge as activity on primary
        await env.DB.prepare('INSERT INTO activity_log (user_id, type, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(primary_id, 'system', 'Account merged: absorbed ' + secondary.email + ' (ID ' + secondary_id + '). ' + merged.join(', '), session.user_id, now()).run();

        // Delete secondary user
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(secondary_id).run();

        // Mark secondary lead as merged
        if (secondary.lead_id) {
          await env.DB.prepare("UPDATE leads SET status = 'merged', updated_at = ? WHERE id = ?").bind(now(), secondary.lead_id).run();
        }

        await writeAuditLog(env.DB, session.user_id, 'users_merged', { primary_id, secondary_id, primary_email: primary.email, secondary_email: secondary.email, merged });
        return json({ success: true, message: 'Merged ' + secondary.email + ' into ' + primary.email, details: merged });
      }

      // Reset user password
      if (path.match(/^\/api\/admin\/users\/\d+\/reset-password$/) && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const userId = path.split('/')[4];
        const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();
        if (!user) return json({ error: 'User not found' }, 404);
        const newPassword = generatePassword();
        const hash = await hashPassword(newPassword);
        await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(hash, now(), userId).run();

        const emailBody = `Hello,\n\nYour password for Blue Sky Cattery portal has been reset by an administrator.\n\nNew Password: ${newPassword}\n\nPlease visit https://portal.blueskycattery.com to log in.\n\nWarm regards,\nBlue Sky Cattery`;
        await sendEmail(user.email, 'Blue Sky Cattery - Password Reset', emailBody, user.email);

        await writeAuditLog(env.DB, session.user_id, 'user_password_reset', { target_user_id: userId, email: user.email });
        return json({ success: true, message: 'Password reset and emailed to ' + user.email, tempPassword: newPassword });
      }

      // =====================
      // SOCIAL MEDIA POSTING
      // =====================

      // Post to Facebook Page
      if (path === '/api/admin/social/facebook' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const data = await parseBody(request);
        const { message, photo_url } = data;
        if (!message) return json({ error: 'Message is required' }, 400);

        // Get Facebook credentials from config
        const fbPageId = await env.DB.prepare("SELECT value FROM config WHERE key = 'fb_page_id'").first();
        const fbToken = await env.DB.prepare("SELECT value FROM config WHERE key = 'fb_page_token'").first();
        if (!fbPageId || !fbToken) return json({ error: 'Facebook not configured. Go to Settings and add fb_page_id and fb_page_token.' }, 400);

        try {
          let result;
          if (photo_url) {
            // Photo post
            const res = await fetch('https://graph.facebook.com/v19.0/' + fbPageId.value + '/photos', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: photo_url, message, access_token: fbToken.value })
            });
            result = await res.json();
          } else {
            // Text post
            const res = await fetch('https://graph.facebook.com/v19.0/' + fbPageId.value + '/feed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message, access_token: fbToken.value })
            });
            result = await res.json();
          }

          if (result.error) return json({ error: 'Facebook error: ' + result.error.message }, 400);

          // Log the post
          await env.DB.prepare('INSERT INTO activity_log (user_id, type, note, details, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(0, 'system', 'Facebook post published', JSON.stringify({ post_id: result.id || result.post_id, message: message.slice(0, 100) }), session.user_id, now()).run();

          await writeAuditLog(env.DB, session.user_id, 'social_post_facebook', { post_id: result.id || result.post_id });
          return json({ success: true, post_id: result.id || result.post_id });
        } catch (err) {
          return json({ error: 'Failed to post: ' + err.message }, 500);
        }
      }

      // Post to Instagram
      if (path === '/api/admin/social/instagram' && method === 'POST') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const data = await parseBody(request);
        const { caption, photo_url } = data;
        if (!caption || !photo_url) return json({ error: 'Caption and photo_url are required for Instagram' }, 400);

        const igUserId = await env.DB.prepare("SELECT value FROM config WHERE key = 'ig_user_id'").first();
        const fbToken = await env.DB.prepare("SELECT value FROM config WHERE key = 'fb_page_token'").first();
        if (!igUserId || !fbToken) return json({ error: 'Instagram not configured. Go to Settings and add ig_user_id.' }, 400);

        try {
          // Step 1: Create media container
          const createRes = await fetch('https://graph.facebook.com/v19.0/' + igUserId.value + '/media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url: photo_url, caption, access_token: fbToken.value })
          });
          const container = await createRes.json();
          if (container.error) return json({ error: 'Instagram error: ' + container.error.message }, 400);

          // Step 2: Publish
          const pubRes = await fetch('https://graph.facebook.com/v19.0/' + igUserId.value + '/media_publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creation_id: container.id, access_token: fbToken.value })
          });
          const result = await pubRes.json();
          if (result.error) return json({ error: 'Instagram publish error: ' + result.error.message }, 400);

          await env.DB.prepare('INSERT INTO activity_log (user_id, type, note, details, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(0, 'system', 'Instagram post published', JSON.stringify({ post_id: result.id, caption: caption.slice(0, 100) }), session.user_id, now()).run();

          await writeAuditLog(env.DB, session.user_id, 'social_post_instagram', { post_id: result.id });
          return json({ success: true, post_id: result.id });
        } catch (err) {
          return json({ error: 'Failed to post: ' + err.message }, 500);
        }
      }

      // Get social media post history
      if (path === '/api/admin/social/history' && method === 'GET') {
        const session = await requireAdmin();
        if (!session) return json({ error: 'Forbidden' }, 403);
        const posts = await env.DB.prepare("SELECT * FROM activity_log WHERE type = 'system' AND (note LIKE '%Facebook%' OR note LIKE '%Instagram%') ORDER BY created_at DESC LIMIT 50").all();
        return json({ posts: posts.results });
      }

      // =====================
      // ADMIN HTML SERVING
      // =====================

      if (path === '/' || path === '' || path === '/admin' || path === '/admin/') {
        return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html' } });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', details: err.message }, 500);
    }
  }
};

// ============================================
// ADMIN PORTAL HTML
// ============================================
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blue Sky Cattery - Admin Portal</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐾</text></svg>">
<meta name="robots" content="noindex, nofollow">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f0eb;color:#3E3229;line-height:1.6}
.container{max-width:1100px;margin:0 auto;padding:0 20px}
header{background:linear-gradient(145deg,#4A3D33,#3E3229);color:#fff;padding:16px 0;box-shadow:0 4px 12px rgba(0,0,0,.15)}
header h1{font-size:1.3rem;display:flex;align-items:center;gap:10px}
header .subtitle{font-size:.8rem;color:#C8B88A}
.top-bar{display:flex;justify-content:space-between;align-items:center}
.btn{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:.85rem;font-weight:600;transition:.2s}
.btn-primary{background:linear-gradient(180deg,#B5613A,#A0522D,#8A4425);color:#fff;box-shadow:0 3px 10px rgba(160,82,45,.3)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 5px 16px rgba(160,82,45,.4)}
.btn-sm{padding:5px 12px;font-size:.78rem}
.btn-success{background:linear-gradient(180deg,#8B9E80,#7A8B6F,#657A5A);color:#fff}
.btn-danger{background:#8B3A3A;color:#fff}
.btn-outline{background:transparent;border:1px solid #D4C5A9;color:#6B5B4B}
.btn-outline:hover{background:#F5EDE0}
.btn-info{background:#87A5B4;color:#fff}
nav.tabs{display:flex;gap:4px;margin:20px 0 0;border-bottom:2px solid #D4C5A9;flex-wrap:wrap}
nav.tabs button{padding:10px 16px;border:none;background:transparent;cursor:pointer;font-weight:600;color:#6B5B4B;border-bottom:3px solid transparent;margin-bottom:-2px;transition:.2s;font-size:.82rem}
nav.tabs button.active{color:#A0522D;border-bottom-color:#A0522D}
.panel{display:none;padding:24px 0}
.panel.active{display:block}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:20px 0}
.stat-card{background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:24px;border-radius:12px;text-align:center;box-shadow:0 6px 20px rgba(62,50,41,.1),inset 0 1px 0 rgba(255,255,255,.6);border:1px solid rgba(212,197,169,.3)}
.stat-card .number{font-size:2rem;font-weight:700;color:#A0522D}
.stat-card .label{font-size:.8rem;color:#6B5B4B;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{text-align:left;padding:10px 14px;font-size:.88rem}
th{background:#3E3229;color:#fff;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.5px}
tr:nth-child(even){background:rgba(245,237,224,.5)}
tr:hover{background:rgba(212,197,169,.3)}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.badge-new{background:#87A5B4;color:#fff}
.badge-approved{background:#7A8B6F;color:#fff}
.badge-submitted{background:#D4AF37;color:#3E3229}
.badge-reviewed{background:#A0522D;color:#fff}
.badge-rejected{background:#8B3A3A;color:#fff}
.badge-active{background:#7A8B6F;color:#fff}
.badge-inactive{background:#999;color:#fff}
.score{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;font-weight:700;font-size:.85rem;color:#fff}
.score-high{background:linear-gradient(145deg,#7A8B6F,#657A5A)}
.score-mid{background:linear-gradient(145deg,#D4AF37,#B8960C)}
.score-low{background:linear-gradient(145deg,#A0522D,#8B3A3A)}
.modal-bg{position:fixed;inset:0;background:rgba(62,50,41,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal{background:#FAF6F0;border-radius:16px;max-width:700px;width:100%;max-height:85vh;overflow-y:auto;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.modal h2{font-size:1.3rem;margin-bottom:16px}
.modal .field{margin-bottom:12px}
.modal .field label{font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;color:#6B5B4B;display:block;margin-bottom:2px}
.modal .field .value{font-size:.92rem;color:#3E3229;padding:8px 12px;background:#F5EDE0;border-radius:6px}
.modal input,.modal textarea,.modal select{width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.9rem;font-family:inherit}
.modal .actions{display:flex;gap:10px;margin-top:20px;justify-content:flex-end}
.score-detail{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.score-item{display:flex;justify-content:space-between;padding:6px 10px;background:#F5EDE0;border-radius:4px;font-size:.82rem}
.login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3E3229,#6B5B4B)}
.login-box{background:#FAF6F0;padding:40px;border-radius:16px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.login-box h1{font-size:1.5rem;margin-bottom:4px;color:#3E3229}
.login-box .sub{color:#6B5B4B;margin-bottom:24px;font-size:.9rem}
.login-box input{width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:12px}
.login-box input:focus{outline:none;border-color:#A0522D}
.error{color:#8B3A3A;font-size:.85rem;margin-bottom:12px}
.hidden{display:none!important}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-grid .field{margin-bottom:0}
.config-form .field{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:8px}
.config-form .field label{min-width:200px;font-size:.82rem;font-weight:600;color:#3E3229}
.config-form .field input{flex:1;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.9rem}
.toggle{position:relative;display:inline-block;width:44px;height:24px}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:.3s}
.toggle .slider:before{content:"";position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}
.toggle input:checked+.slider{background:#7A8B6F}
.toggle input:checked+.slider:before{transform:translateX(20px)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
@media(max-width:768px){
.stats-grid{grid-template-columns:1fr 1fr}
table{font-size:.75rem;display:block;overflow-x:auto;white-space:nowrap}
th,td{padding:6px 8px}
.form-grid{grid-template-columns:1fr}
nav.tabs{overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch}
nav.tabs button{padding:8px 10px;font-size:.72rem;white-space:nowrap;flex-shrink:0}
.top-bar{flex-direction:column;gap:8px;text-align:center}
.top-bar h1{font-size:1.1rem}
.modal{padding:20px 16px;max-height:95vh}
.modal h2{font-size:1.1rem}
.field .value{font-size:.82rem;word-break:break-word}
.score-detail{grid-template-columns:1fr}
.actions{flex-wrap:wrap}
.actions button,.actions a{flex:1 1 auto;min-width:0;text-align:center}
.btn-sm{padding:4px 8px;font-size:.7rem}
}
</style>
</head>
<body>
<div id="app"></div>
<script>
const API = window.location.origin + '/api';
let authToken = localStorage.getItem('bsc_admin_token');
let currentTab = 'todo';

// Client-side image resizer - optimizes photos before upload
function resizeImage(file, maxWidth, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl.split(',')[1]); // return base64 without prefix
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function reassignPhoto(photoId, callback) {
  const [catsRes, littersRes] = await Promise.all([api('/admin/cats'), api('/admin/litters')]);
  const cats = catsRes.cats || [];
  const allKittens = [];
  (littersRes.litters || []).forEach(l => {
    (l.kittens || []).forEach(k => { allKittens.push({ id: k.id, name: k.name || 'Kitten #' + k.number, litter: l.litter_code }); });
  });

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.maxWidth = '400px';
  let opts = '<option value="">Select...</option><optgroup label="Cats">';
  cats.forEach(c => { opts += '<option value="cat-' + c.id + '">' + c.name + ' (' + c.role + ')</option>'; });
  opts += '</optgroup><optgroup label="Kittens">';
  allKittens.forEach(k => { opts += '<option value="kitten-' + k.id + '">' + k.name + ' (' + k.litter + ')</option>'; });
  opts += '</optgroup>';
  modal.innerHTML = '<h2>Reassign Photo</h2><div class="field"><label>Move to:</label><select id="reassignTarget" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px">' + opts + '</select></div><div class="actions"><button class="btn btn-outline" id="reassignCancel">Cancel</button><button class="btn btn-primary" id="reassignSave">Move Photo</button></div>';
  bg.appendChild(modal);
  document.body.appendChild(bg);
  document.getElementById('reassignCancel').onclick = () => bg.remove();
  document.getElementById('reassignSave').onclick = async () => {
    const val = document.getElementById('reassignTarget').value;
    if (!val) return;
    const [entityType, entityId] = val.split('-');
    const res = await api('/admin/photos/' + photoId + '/assign', { method: 'PUT', body: JSON.stringify({ entity_type: entityType, entity_id: parseInt(entityId) }) });
    bg.remove();
    if (res.success && callback) callback();
  };
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(API + path, { ...opts, headers });
  return res.json();
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'onclick' || k === 'onchange' || k === 'onsubmit' || k === 'oninput') e[k] = v;
    else if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  });
  children.flat().forEach(c => { if (c) e.append(typeof c === 'string' ? c : c); });
  return e;
}

function badge(status) {
  const cls = { new:'badge-new', approved:'badge-approved', submitted:'badge-submitted', reviewed:'badge-reviewed', rejected:'badge-rejected', active:'badge-active', inactive:'badge-inactive' };
  return '<span class="badge '+(cls[status]||'badge-new')+'">'+(status||'new')+'</span>';
}

function scoreEl(score) {
  const cls = score >= 70 ? 'score-high' : score >= 45 ? 'score-mid' : 'score-low';
  return '<span class="score '+cls+'">'+score+'</span>';
}

function timeAgo(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff/60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs/24) + 'd ago';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ---- Login ----

async function renderLogin() {
  // Check for reset token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('reset');
  if (resetToken) return renderResetPassword(resetToken);

  const app = document.getElementById('app');
  app.innerHTML = '';
  app.innerHTML = '<div class="login-page"><div class="login-box">' +
    '<h1>Admin Portal</h1><div class="sub">Blue Sky Cattery</div>' +
    '<div id="loginError" class="error hidden"></div>' +
    '<form id="loginForm">' +
    '<input type="email" id="loginEmail" placeholder="Email" required>' +
    '<input type="password" id="loginPass" placeholder="Password" required>' +
    '<button type="submit" class="btn btn-primary" style="width:100%">Sign In</button>' +
    '</form>' +
    '<div style="text-align:center;margin-top:12px"><a href="#" id="forgotLink" style="color:#A0522D;font-size:.85rem">Forgot your password?</a></div>' +
    '<div id="forgotForm" style="display:none;margin-top:16px">' +
    '<p style="font-size:.85rem;color:#6B5B4B;margin-bottom:8px">Enter your admin email to receive a reset link.</p>' +
    '<input type="email" id="forgotEmail" placeholder="Admin email" style="width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:8px">' +
    '<button class="btn btn-primary" id="forgotBtn" style="width:100%">Send Reset Link</button>' +
    '</div></div></div>';

  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPass').value;
    const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    if (res.success) {
      authToken = res.token;
      localStorage.setItem('bsc_admin_token', res.token);
      window.history.replaceState({}, '', '/');
      renderApp();
    } else {
      document.getElementById('loginError').textContent = res.error || 'Login failed';
      document.getElementById('loginError').classList.remove('hidden');
    }
  };

  document.getElementById('forgotLink').onclick = (e) => {
    e.preventDefault();
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('forgotForm').style.display = 'block';
    document.getElementById('forgotLink').style.display = 'none';
  };

  document.getElementById('forgotBtn').onclick = async () => {
    const email = document.getElementById('forgotEmail').value;
    if (!email) return;
    const btn = document.getElementById('forgotBtn');
    btn.disabled = true; btn.textContent = 'Sending...';
    await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    document.getElementById('forgotForm').innerHTML = '<p style="color:#7A8B6F;font-size:.9rem;text-align:center;padding:12px">If an admin account exists with that email, a reset link has been sent. Check your inbox.</p>';
  };
}

function renderResetPassword(token) {
  document.getElementById('app').innerHTML = '<div class="login-page"><div class="login-box">' +
    '<h1>Reset Password</h1><div class="sub">Blue Sky Cattery Admin</div>' +
    '<div id="resetError" class="error hidden"></div>' +
    '<div id="resetSuccess" style="display:none;color:#7A8B6F;text-align:center;padding:16px"></div>' +
    '<form id="resetForm">' +
    '<input type="password" id="newPass" placeholder="New password (min 8 characters)" required minlength="8">' +
    '<input type="password" id="confirmPass" placeholder="Confirm new password" required minlength="8">' +
    '<button type="submit" class="btn btn-primary" style="width:100%">Set New Password</button>' +
    '</form></div></div>';

  document.getElementById('resetForm').onsubmit = async (e) => {
    e.preventDefault();
    const pass = document.getElementById('newPass').value;
    const confirm = document.getElementById('confirmPass').value;
    if (pass !== confirm) {
      document.getElementById('resetError').textContent = 'Passwords do not match';
      document.getElementById('resetError').classList.remove('hidden');
      return;
    }
    const res = await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: pass }) });
    if (res.success) {
      document.getElementById('resetForm').style.display = 'none';
      document.getElementById('resetSuccess').style.display = 'block';
      document.getElementById('resetSuccess').innerHTML = 'Password reset! <a href="/" style="color:#A0522D;font-weight:600">Click here to log in</a>';
      window.history.replaceState({}, '', '/');
    } else {
      document.getElementById('resetError').textContent = res.error || 'Reset failed';
      document.getElementById('resetError').classList.remove('hidden');
    }
  };
}

// ---- Main App Shell ----

async function renderApp() {
  const me = await api('/auth/me');
  if (!me.user || me.user.role !== 'admin') { authToken = null; localStorage.removeItem('bsc_admin_token'); return renderLogin(); }

  const app = document.getElementById('app');
  app.innerHTML = '';

  // Fetch notification count
  const notif = await api('/admin/notifications').catch(() => ({ total: 0 }));
  const badgeCount = notif.total || 0;

  const header = el('header', {},
    el('div', { class: 'container top-bar' },
      el('div', { style: 'display:flex;align-items:center;gap:12px' },
        el('div', {},
          el('h1', {}, 'Blue Sky Cattery Admin'),
          el('div', { class: 'subtitle' }, me.user.email)
        ),
        badgeCount > 0 ? el('div', { style: 'background:#A0522D;color:#fff;border-radius:20px;padding:4px 12px;font-size:.78rem;font-weight:700;cursor:pointer;animation:pulse 2s infinite', onclick: () => { currentTab = 'leads'; renderApp(); }, html: badgeCount + ' new' }) : null
      ),
      el('div', { style: 'display:flex;gap:8px;align-items:center' },
        el('a', { href: 'https://blueskycattery.com', style: 'color:#C8B88A;font-size:.8rem;text-decoration:none', html: 'View Site &rarr;' }),
        el('button', { class: 'btn btn-outline', style: 'color:#fff;border-color:rgba(255,255,255,.3)', onclick: async () => { await api('/auth/logout', { method:'POST' }); authToken = null; localStorage.removeItem('bsc_admin_token'); renderLogin(); }}, 'Logout')
      )
    )
  );
  app.appendChild(header);

  const tabs = ['todo','dashboard','leads','applications','kittens','cats','social','settings','emails','users','audit','help'];
  const tabLabels = { todo:'To Do', dashboard:'Dashboard', leads:'Leads', applications:'Applications', kittens:'Kittens', cats:'Cats', social:'Social', settings:'Settings', emails:'Emails', users:'Users', audit:'Audit Log', help:'Help' };

  const nav = el('nav', { class: 'container tabs' });
  tabs.forEach(t => {
    nav.appendChild(el('button', { class: currentTab === t ? 'active' : '', onclick: () => { currentTab = t; renderApp(); }}, tabLabels[t]));
  });
  app.appendChild(nav);

  const content = el('div', { class: 'container' });
  app.appendChild(content);

  if (currentTab === 'todo') await renderTodo(content);
  else if (currentTab === 'dashboard') await renderDashboard(content);
  else if (currentTab === 'leads') await renderLeads(content);
  else if (currentTab === 'applications') await renderApplications(content);
  else if (currentTab === 'kittens') await renderKittens(content);
  else if (currentTab === 'cats') await renderCats(content);
  else if (currentTab === 'social') await renderSocial(content);
  else if (currentTab === 'settings') await renderSettings(content);
  else if (currentTab === 'emails') await renderEmails(content);
  else if (currentTab === 'users') await renderUsers(content);
  else if (currentTab === 'audit') await renderAudit(content);
  else if (currentTab === 'help') renderHelp(content);
}

// ---- Dashboard ----

async function renderTodo(container) {
  const data = await api('/admin/todo');
  const panel = el('div', { class: 'panel active' });
  let html = '<h2 style="margin:20px 0 4px">Action Center</h2>';
  html += '<p style="color:#6B5B4B;margin-bottom:20px;font-size:.88rem">Everything that needs your attention, in one place.</p>';

  // Count total actions
  const totalActions = (data.newLeads||[]).length + (data.pendingApps||[]).length + (data.recentMessages||[]).length + (data.pendingKittens||[]).length + (data.unassignedPhotos||[]).length + (data.redFlagUsers||[]).length;

  if (totalActions === 0 && (data.upcomingEmails||[]).length === 0) {
    html += '<div style="text-align:center;padding:40px;color:#7A8B6F"><div style="font-size:2.5rem;margin-bottom:12px">&#10003;</div><h3>All caught up!</h3><p style="color:#6B5B4B">No pending actions right now.</p></div>';
  }

  // New Leads
  if ((data.newLeads||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#87A5B4;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.newLeads.length + '</div><h3 style="margin:0;font-size:1rem">New Leads to Review</h3></div>';
    data.newLeads.forEach(l => {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:6px">';
      html += '<div><strong>' + esc(l.name) + '</strong><br><span style="font-size:.78rem;color:#6B5B4B">' + esc(l.email) + ' &mdash; ' + esc(l.source) + (l.user_id ? ' &mdash; <span style="color:#7A8B6F;font-weight:600">has account</span>' : '') + ' &mdash; ' + timeAgo(l.created_at) + '</span></div>';
      html += '<div style="display:flex;gap:6px">';
      html += '<button class="btn btn-outline btn-sm" onclick="showLeadModal(' + l.id + ')">View</button>';
      html += '<button class="btn btn-sm" data-todo-dismiss-lead="' + l.id + '" style="background:#87A5B4;color:#fff;font-size:.72rem">Dismiss</button>';
      html += '</div></div>';
    });
    html += '</div>';
  }

  // Pending Applications
  if ((data.pendingApps||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#D4AF37;color:#3E3229;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.pendingApps.length + '</div><h3 style="margin:0;font-size:1rem">Applications Pending Review</h3></div>';
    data.pendingApps.forEach(a => {
      const scoreColor = a.score >= 80 ? '#7A8B6F' : a.score >= 65 ? '#D4AF37' : a.score >= 45 ? '#A0522D' : '#8B3A3A';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:6px">';
      html += '<div style="display:flex;align-items:center;gap:10px"><span style="background:' + scoreColor + ';color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + a.score + '</span>';
      html += '<div><strong>' + esc(a.full_name||'N/A') + '</strong><br><span style="font-size:.78rem;color:#6B5B4B">' + esc(a.purpose||'pet') + ' &mdash; ' + timeAgo(a.created_at) + '</span></div></div>';
      html += '<button class="btn btn-outline btn-sm" onclick="showAppModal(' + a.id + ')">Review</button>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Unanswered Messages
  if ((data.recentMessages||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#A0522D;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.recentMessages.length + '</div><h3 style="margin:0;font-size:1rem">Unanswered Messages</h3></div>';
    data.recentMessages.forEach(m => {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:6px">';
      html += '<div><strong>' + esc(m.name) + '</strong> &mdash; ' + esc(m.subject||'Message') + '<br><span style="font-size:.78rem;color:#6B5B4B">' + timeAgo(m.created_at) + '</span></div>';
      html += '<div style="display:flex;gap:6px">';
      html += '<button class="btn btn-outline btn-sm" onclick="showLeadModal(' + m.lead_id + ')">Reply</button>';
      html += '<button class="btn btn-sm" data-todo-dismiss-msg="' + m.id + '" style="background:#8B3A3A;color:#fff;font-size:.72rem" title="Dismiss">&#10005; Dismiss</button>';
      html += '</div></div>';
    });
    html += '</div>';
  }

  // Pending Deposits
  if ((data.pendingKittens||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#87A5B4;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.pendingKittens.length + '</div><h3 style="margin:0;font-size:1rem">Awaiting Deposit</h3></div>';
    data.pendingKittens.forEach(k => {
      html += '<div style="padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:6px">';
      html += '<strong>' + esc(k.name||'Kitten #'+k.number) + '</strong> (' + esc(k.litter_code) + ') &mdash; Reserved by: ' + esc(k.reserved_by||'Unknown');
      html += '</div>';
    });
    html += '</div>';
  }

  // Red Flag Users
  if ((data.redFlagUsers||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#8B3A3A;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.redFlagUsers.length + '</div><h3 style="margin:0;font-size:1rem">Verification Red Flags</h3></div>';
    html += '<p style="font-size:.82rem;color:#6B5B4B;margin-bottom:8px">These users have failed one or more verification checks and need attention.</p>';
    data.redFlagUsers.forEach(u => {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(139,58,58,.04);border:1px solid rgba(139,58,58,.15);border-radius:8px;margin-bottom:6px">';
      html += '<div><strong>' + esc(u.name || u.email) + '</strong>';
      html += '<br><span style="font-size:.78rem;color:#8B3A3A">Failed: ' + u.fails.join(', ') + '</span></div>';
      html += '<button class="btn btn-outline btn-sm" data-redflag-user="' + u.id + '">Review</button>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Unassigned Photos
  if ((data.unassignedPhotos||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#C8849B;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.unassignedPhotos.length + '</div><h3 style="margin:0;font-size:1rem">Unassigned Photos</h3></div>';
    html += '<p style="font-size:.82rem;color:#6B5B4B;margin-bottom:10px">These photos were emailed in but could not be matched to a cat or kitten. Assign or delete them below.</p>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:12px">';
    data.unassignedPhotos.forEach(p => {
      html += '<div style="width:160px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;overflow:hidden" data-unassigned-card="' + p.id + '">';
      html += '<img src="' + esc(p.url) + '" style="width:100%;height:120px;object-fit:cover">';
      html += '<div style="padding:8px">';
      html += '<div style="font-size:.75rem;color:#6B5B4B;margin-bottom:6px;word-break:break-all">' + esc(p.filename) + '</div>';
      html += '<select data-assign-select="' + p.id + '" style="width:100%;padding:4px 6px;border:1px solid #D4C5A9;border-radius:4px;font-size:.78rem;margin-bottom:6px"><option value="">Assign to...</option></select>';
      html += '<div style="display:flex;gap:4px">';
      html += '<button class="btn btn-sm btn-success" data-assign-btn="' + p.id + '" style="flex:1;font-size:.72rem" disabled>Assign</button>';
      html += '<button class="btn btn-sm btn-danger" data-assign-del="' + p.id + '" style="font-size:.72rem">Del</button>';
      html += '</div></div></div>';
    });
    html += '</div></div>';
  }

  // Upcoming Automated Emails
  if ((data.upcomingEmails||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#7A8B6F;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700">&#9993;</div><h3 style="margin:0;font-size:1rem">Upcoming Automated Emails (next 30 days)</h3></div>';
    html += '<table><thead><tr><th>Email</th><th>Kitten</th><th>Recipient</th><th>Sends</th></tr></thead><tbody>';
    data.upcomingEmails.forEach(e => {
      const urgency = e.days_until <= 0 ? 'color:#8B3A3A;font-weight:700' : e.days_until <= 3 ? 'color:#D4AF37;font-weight:600' : 'color:#6B5B4B';
      const label = e.days_until <= 0 ? 'Today!' : e.days_until === 1 ? 'Tomorrow' : 'In ' + e.days_until + ' days';
      html += '<tr><td>' + esc(e.email_name) + '</td><td>' + esc(e.kitten) + '</td><td style="font-size:.82rem">' + esc(e.recipient||'—') + '</td><td style="' + urgency + '">' + label + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '</div>';
  }

  panel.innerHTML = html;
  container.appendChild(panel);

  // Dismiss lead handlers
  panel.querySelectorAll('[data-todo-dismiss-lead]').forEach(btn => {
    btn.onclick = async () => {
      const leadId = btn.getAttribute('data-todo-dismiss-lead');
      btn.disabled = true; btn.textContent = 'Done';
      await api('/admin/leads/' + leadId, { method: 'PUT', body: JSON.stringify({ status: 'reviewed' }) });
      btn.closest('div[style*="border-radius:8px"]').remove();
    };
  });

  // Red flag review handlers
  panel.querySelectorAll('[data-redflag-user]').forEach(btn => {
    btn.onclick = () => {
      const userId = btn.getAttribute('data-redflag-user');
      const user = (data.redFlagUsers||[]).find(u => u.id == userId);
      if (user) showUserEditModal({ id: user.id, email: user.email, lead_name: user.name, role: 'applicant', status: 'active' });
    };
  });

  // Populate assign dropdowns for unassigned photos
  if ((data.unassignedPhotos||[]).length > 0) {
    (async () => {
      const [catsRes, littersRes] = await Promise.all([api('/admin/cats'), api('/admin/litters')]);
      const cats = catsRes.cats || [];
      const allKittens = [];
      (littersRes.litters || []).forEach(l => {
        (l.kittens || []).forEach(k => { allKittens.push({ id: k.id, name: k.name || 'Kitten #' + k.number, litter: l.litter_code }); });
      });

      panel.querySelectorAll('[data-assign-select]').forEach(sel => {
        let opts = '<option value="">Assign to...</option>';
        opts += '<optgroup label="Cats">';
        cats.forEach(c => { opts += '<option value="cat-' + c.id + '">' + esc(c.name) + ' (' + c.role + ')</option>'; });
        opts += '</optgroup><optgroup label="Kittens">';
        allKittens.forEach(k => { opts += '<option value="kitten-' + k.id + '">' + esc(k.name) + ' (' + k.litter + ')</option>'; });
        opts += '</optgroup>';
        sel.innerHTML = opts;

        sel.onchange = () => {
          const assignBtn = panel.querySelector('[data-assign-btn="' + sel.getAttribute('data-assign-select') + '"]');
          if (assignBtn) assignBtn.disabled = !sel.value;
        };
      });

      panel.querySelectorAll('[data-assign-btn]').forEach(btn => {
        btn.onclick = async () => {
          const photoId = btn.getAttribute('data-assign-btn');
          const sel = panel.querySelector('[data-assign-select="' + photoId + '"]');
          if (!sel || !sel.value) return;
          const [entityType, entityId] = sel.value.split('-');
          btn.disabled = true; btn.textContent = '...';
          const res = await api('/admin/photos/' + photoId + '/assign', { method: 'PUT', body: JSON.stringify({ entity_type: entityType, entity_id: parseInt(entityId) }) });
          if (res.success) {
            const card = panel.querySelector('[data-unassigned-card="' + photoId + '"]');
            if (card) card.remove();
          } else {
            alert(res.error || 'Failed');
            btn.disabled = false; btn.textContent = 'Assign';
          }
        };
      });

      panel.querySelectorAll('[data-assign-del]').forEach(btn => {
        btn.onclick = async () => {
          if (!confirm('Delete this photo permanently?')) return;
          const photoId = btn.getAttribute('data-assign-del');
          await api('/admin/photos/' + photoId, { method: 'DELETE' });
          const card = panel.querySelector('[data-unassigned-card="' + photoId + '"]');
          if (card) card.remove();
        };
      });
    })();
  }

  // Attach dismiss handlers for messages
  panel.querySelectorAll('[data-todo-dismiss-msg]').forEach(btn => {
    btn.onclick = async () => {
      const msgId = btn.getAttribute('data-todo-dismiss-msg');
      if (!confirm('Dismiss this message? It will be deleted.')) return;
      btn.disabled = true; btn.textContent = 'Deleting...';
      await api('/admin/messages/' + msgId, { method: 'DELETE' });
      btn.closest('div[style*="border-radius:8px"]').remove();
      // Update counter
      const badge = panel.querySelector('div[style*="background:#A0522D"][style*="border-radius:50%"]');
      if (badge) {
        const count = parseInt(badge.textContent) - 1;
        if (count <= 0) { badge.closest('div[style*="margin-bottom:24px"]').remove(); }
        else { badge.textContent = count; }
      }
    };
  });
}

async function renderDashboard(container) {
  const data = await api('/admin/stats');
  const stats = data.stats || {};
  const funnel = data.funnel || {};
  const scoreDist = data.scoreDistribution || {};
  const sources = data.leadSources || [];
  const purposes = data.purposes || [];
  const recentLeads = data.recentLeads || [];
  const recentApps = data.recentApps || [];

  const panel = el('div', { class: 'panel active' });
  let html = '<h2 style="margin:20px 0 4px">Dashboard</h2>';

  // --- Top Stats ---
  html += '<div class="stats-grid">';
  html += '<div class="stat-card"><div class="number">' + stats.totalLeads + '</div><div class="label">Total Leads</div></div>';
  html += '<div class="stat-card"><div class="number">' + stats.newLeads + '</div><div class="label">New Leads</div></div>';
  html += '<div class="stat-card"><div class="number">' + stats.totalApplications + '</div><div class="label">Applications</div></div>';
  html += '<div class="stat-card"><div class="number">' + stats.pendingApplications + '</div><div class="label">Pending Review</div></div>';
  html += '<div class="stat-card"><div class="number">' + stats.averageScore + '</div><div class="label">Avg Score</div></div>';
  html += '<div class="stat-card"><div class="number" style="color:#7A8B6F">' + stats.availableKittens + '</div><div class="label">Available</div></div>';
  html += '<div class="stat-card"><div class="number" style="color:#D4AF37">' + stats.reservedKittens + '</div><div class="label">Reserved</div></div>';
  html += '<div class="stat-card"><div class="number" style="color:#8B3A3A">' + stats.soldKittens + '</div><div class="label">Sold</div></div>';
  html += '</div>';

  // --- Conversion Funnel ---
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:24px 0">';

  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:24px;border-radius:12px;border:1px solid rgba(212,197,169,.3);box-shadow:0 6px 20px rgba(62,50,41,.08)">';
  html += '<h3 style="margin:0 0 16px;font-size:1rem;color:#A0522D">Conversion Funnel</h3>';
  const funnelSteps = [
    { label: 'Leads', value: funnel.leads || 0, color: '#87A5B4' },
    { label: 'Approved to Apply', value: funnel.approved || 0, color: '#7A8B6F' },
    { label: 'Applications Submitted', value: funnel.applied || 0, color: '#D4AF37' },
    { label: 'Accepted', value: funnel.accepted || 0, color: '#A0522D' },
    { label: 'Kittens Sold', value: funnel.sold || 0, color: '#3E3229' }
  ];
  const maxFunnel = Math.max(1, funnelSteps[0].value);
  funnelSteps.forEach((step, i) => {
    const pct = Math.max(8, Math.round((step.value / maxFunnel) * 100));
    const convRate = i > 0 && funnelSteps[i-1].value > 0 ? Math.round((step.value / funnelSteps[i-1].value) * 100) : null;
    html += '<div style="margin-bottom:10px">';
    html += '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:3px"><span style="color:#3E3229;font-weight:600">' + step.label + '</span><span style="color:#6B5B4B">' + step.value + (convRate !== null ? ' <span style=\\"font-size:.72rem;color:#A0522D\\">(' + convRate + '%)</span>' : '') + '</span></div>';
    html += '<div style="background:#e8e2d8;border-radius:4px;height:24px;overflow:hidden"><div style="background:' + step.color + ';height:24px;border-radius:4px;width:' + pct + '%;transition:width .5s ease;display:flex;align-items:center;justify-content:center"><span style="color:#fff;font-size:.7rem;font-weight:700">' + step.value + '</span></div></div>';
    html += '</div>';
  });
  html += '</div>';

  // --- Score Distribution ---
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:24px;border-radius:12px;border:1px solid rgba(212,197,169,.3);box-shadow:0 6px 20px rgba(62,50,41,.08)">';
  html += '<h3 style="margin:0 0 16px;font-size:1rem;color:#A0522D">Application Score Distribution</h3>';
  const totalApps = (scoreDist.excellent || 0) + (scoreDist.good || 0) + (scoreDist.fair || 0) + (scoreDist.needsReview || 0);
  const scoreItems = [
    { label: 'Excellent (80+)', value: scoreDist.excellent || 0, color: '#7A8B6F' },
    { label: 'Good (65-79)', value: scoreDist.good || 0, color: '#87A5B4' },
    { label: 'Fair (45-64)', value: scoreDist.fair || 0, color: '#D4AF37' },
    { label: 'Needs Review (<45)', value: scoreDist.needsReview || 0, color: '#8B3A3A' }
  ];
  if (totalApps > 0) {
    html += '<div style="display:flex;height:32px;border-radius:6px;overflow:hidden;margin-bottom:16px">';
    scoreItems.forEach(s => {
      const w = Math.round((s.value / totalApps) * 100);
      if (w > 0) html += '<div style="background:' + s.color + ';width:' + w + '%;display:flex;align-items:center;justify-content:center"><span style="color:#fff;font-size:.7rem;font-weight:700">' + s.value + '</span></div>';
    });
    html += '</div>';
  }
  scoreItems.forEach(s => {
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="width:14px;height:14px;border-radius:3px;background:' + s.color + '"></div><span style="font-size:.85rem;color:#3E3229">' + s.label + ': <strong>' + s.value + '</strong></span></div>';
  });
  if (totalApps === 0) html += '<p style="color:#6B5B4B;font-size:.85rem;text-align:center;padding:20px">No applications yet</p>';
  html += '</div>';
  html += '</div>';

  // --- Sources & Purpose row ---
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin:0 0 24px">';

  // Lead Sources
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:20px;border-radius:12px;border:1px solid rgba(212,197,169,.3)">';
  html += '<h3 style="margin:0 0 12px;font-size:.9rem;color:#A0522D">Lead Sources</h3>';
  if (sources.length > 0) {
    sources.forEach(s => {
      html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span style="color:#3E3229;text-transform:capitalize">' + (s.source || 'unknown') + '</span><strong>' + s.count + '</strong></div>';
    });
  } else {
    html += '<p style="color:#6B5B4B;font-size:.85rem">No data yet</p>';
  }
  html += '</div>';

  // Application Purpose
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:20px;border-radius:12px;border:1px solid rgba(212,197,169,.3)">';
  html += '<h3 style="margin:0 0 12px;font-size:.9rem;color:#A0522D">Application Purpose</h3>';
  if (purposes.length > 0) {
    purposes.forEach(p => {
      html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span style="color:#3E3229;text-transform:capitalize">' + (p.purpose || 'pet') + '</span><strong>' + p.count + '</strong></div>';
    });
  } else {
    html += '<p style="color:#6B5B4B;font-size:.85rem">No data yet</p>';
  }
  html += '</div>';

  // Quick Stats
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:20px;border-radius:12px;border:1px solid rgba(212,197,169,.3)">';
  html += '<h3 style="margin:0 0 12px;font-size:.9rem;color:#A0522D">Quick Stats</h3>';
  html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span>Waitlisted</span><strong>' + (stats.waitlistApplications || 0) + '</strong></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span>Rejected</span><strong>' + (stats.rejectedApplications || 0) + '</strong></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span>Emails Sent</span><strong>' + (stats.emailsSent || 0) + '</strong></div>';
  html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span>Avg Score</span><strong>' + (stats.averageScore || 0) + '/100</strong></div>';
  html += '</div>';
  html += '</div>';

  // --- Recent Activity ---
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">';

  // Recent Leads
  html += '<div>';
  html += '<h3 style="margin:0 0 8px;font-size:1rem;color:#6B5B4B">Recent Leads</h3>';
  if (recentLeads.length > 0) {
    html += '<table><thead><tr><th>Name</th><th>Source</th><th>Status</th><th>When</th></tr></thead><tbody>';
    recentLeads.slice(0, 8).forEach(l => {
      html += '<tr><td><strong>' + esc(l.name) + '</strong><br><span style="font-size:.75rem;color:#6B5B4B">' + esc(l.email) + '</span></td><td>' + esc(l.source) + '</td><td>' + badge(l.status) + '</td><td>' + timeAgo(l.created_at) + '</td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p style="color:#6B5B4B;font-size:.85rem;padding:12px">No leads yet</p>';
  }
  html += '</div>';

  // Recent Applications
  html += '<div>';
  html += '<h3 style="margin:0 0 8px;font-size:1rem;color:#6B5B4B">Recent Applications</h3>';
  if (recentApps.length > 0) {
    html += '<table><thead><tr><th>Name</th><th>Score</th><th>Purpose</th><th>Status</th></tr></thead><tbody>';
    recentApps.slice(0, 8).forEach(a => {
      html += '<tr><td><strong>' + esc(a.full_name || 'N/A') + '</strong></td><td>' + scoreEl(a.score) + '</td><td style="text-transform:capitalize">' + (a.purpose || 'pet') + '</td><td>' + badge(a.status) + '</td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p style="color:#6B5B4B;font-size:.85rem;padding:12px">No applications yet</p>';
  }
  html += '</div>';
  html += '</div>';

  panel.innerHTML = html;
  container.appendChild(panel);
}

// ---- Leads ----

let leadSearch = '';
let leadStatusFilter = '';

async function renderLeads(container) {
  const params = new URLSearchParams();
  if (leadSearch) params.set('search', leadSearch);
  if (leadStatusFilter) params.set('status', leadStatusFilter);
  const { leads } = await api('/admin/leads?' + params.toString());
  const panel = el('div', { class: 'panel active' });

  // Header with search and export
  let toolbar = '<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 16px;flex-wrap:wrap;gap:12px">';
  toolbar += '<h2 style="margin:0">Leads & Contacts</h2>';
  toolbar += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  toolbar += '<input type="text" id="leadSearchInput" placeholder="Search name, email, phone..." value="' + esc(leadSearch) + '" style="padding:8px 14px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem;width:220px">';
  toolbar += '<select id="leadStatusFilter" style="padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem"><option value="">All Status</option><option value="new"' + (leadStatusFilter==='new'?' selected':'') + '>New</option><option value="approved"' + (leadStatusFilter==='approved'?' selected':'') + '>Approved</option><option value="contacted"' + (leadStatusFilter==='contacted'?' selected':'') + '>Contacted</option></select>';
  toolbar += '<button class="btn btn-sm btn-outline" id="leadSearchBtn">Search</button>';
  toolbar += '<a href="' + API + '/admin/leads/export" class="btn btn-sm btn-outline" style="text-decoration:none;color:#6B5B4B" target="_blank">Export CSV</a>';
  toolbar += '</div></div>';
  panel.innerHTML = toolbar;

  // Results count
  panel.innerHTML += '<div style="font-size:.82rem;color:#6B5B4B;margin-bottom:8px">' + (leads||[]).length + ' lead(s) found</div>';

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Preferences</th><th>Status</th><th>When</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (leads || []).forEach(lead => {
    const tr = el('tr');
    let prefs = [];
    if (lead.sex_preference && lead.sex_preference !== 'no_preference') prefs.push(lead.sex_preference);
    if (lead.color_preference && lead.color_preference !== 'no_preference') prefs.push(lead.color_preference);
    if (lead.temperament_preference && lead.temperament_preference !== 'no_preference') prefs.push(lead.temperament_preference.replace(/_/g,' '));
    if (lead.eye_color_preference && lead.eye_color_preference !== 'no_preference') prefs.push(lead.eye_color_preference + ' eyes');
    const prefHtml = prefs.length > 0 ? prefs.map(p => '<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:.7rem;background:#F5EDE0;color:#6B5B4B;margin:1px">' + esc(p) + '</span>').join('') : '<span style="color:#ccc;font-size:.78rem">—</span>';
    tr.innerHTML = '<td><strong>'+esc(lead.name)+'</strong></td><td>'+esc(lead.email)+'</td><td>'+esc(lead.phone||'—')+'</td><td>'+esc(lead.source)+'</td><td style="max-width:180px">'+prefHtml+'</td><td>'+badge(lead.status)+'</td><td>'+timeAgo(lead.created_at)+'</td>';
    const actionTd = el('td', { style: 'white-space:nowrap' });
    actionTd.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showLeadModal(lead.id) }, 'View'));
    if (lead.status === 'new') {
      if (lead.user_id) {
        // Account already exists (self-registered) — show dismiss instead of approve
        actionTd.appendChild(el('button', { class: 'btn btn-sm', style: 'margin-left:4px;background:#87A5B4;color:#fff', onclick: async () => {
          await api('/admin/leads/' + lead.id, { method: 'PUT', body: JSON.stringify({ status: 'reviewed' }) });
          renderApp();
        }}, 'Dismiss'));
      } else {
        // No account — show approve
        actionTd.appendChild(el('button', { class: 'btn btn-success btn-sm', style: 'margin-left:4px', onclick: async () => {
          if (confirm('Approve ' + lead.name + '? This will create their account and send a welcome email.')) {
            const res = await api('/admin/approve', { method: 'POST', body: JSON.stringify({ lead_id: lead.id }) });
            if (res.success) { showApprovalModal(lead.name, lead.email, res.tempPassword); }
            else alert(res.error || 'Failed');
          }
        }}, 'Approve'));
      }
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (!leads || leads.length === 0) panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No leads match your search.</p>';

  container.appendChild(panel);

  // Attach search handlers
  document.getElementById('leadSearchBtn').onclick = () => {
    leadSearch = document.getElementById('leadSearchInput').value;
    leadStatusFilter = document.getElementById('leadStatusFilter').value;
    container.innerHTML = '';
    renderLeads(container);
  };
  document.getElementById('leadSearchInput').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('leadSearchBtn').click(); };
  document.getElementById('leadStatusFilter').onchange = () => { document.getElementById('leadSearchBtn').click(); };
}

async function showLeadModal(leadId) {
  const { lead, messages } = await api('/admin/leads/' + leadId);
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });

  let html = '<h2>' + esc(lead.name) + '</h2>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  html += '<div class="field"><label>Email</label><div class="value">' + esc(lead.email) + '</div></div>';
  html += '<div class="field"><label>Phone</label><div class="value">' + esc(lead.phone || 'N/A') + '</div></div>';
  html += '<div class="field"><label>Source</label><div class="value">' + esc(lead.source) + '</div></div>';
  html += '<div class="field"><label>Status</label><div class="value">' + badge(lead.status) + '</div></div>';
  html += '</div>';
  html += '<div class="field"><label>Created</label><div class="value">' + esc(lead.created_at) + '</div></div>';

  // Message history
  html += '<h3 style="margin:20px 0 8px">Conversation</h3>';
  (messages || []).forEach(msg => {
    const isOutbound = msg.direction === 'outbound';
    const bgColor = isOutbound ? 'rgba(122,139,111,.08)' : '#F5EDE0';
    const borderColor = isOutbound ? 'rgba(122,139,111,.2)' : 'transparent';
    const dirLabel = isOutbound ? '<span style="color:#7A8B6F;font-weight:700">SENT</span>' : '<span style="color:#87A5B4;font-weight:700">RECEIVED</span>';
    html += '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';padding:12px;border-radius:8px;margin-bottom:8px;font-size:.88rem;position:relative">';
    html += '<div style="font-size:.75rem;color:#6B5B4B;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">' + dirLabel + ' <div style="display:flex;align-items:center;gap:8px"><span>' + esc(msg.created_at) + '</span><button class="btn btn-sm" data-msg-del="' + msg.id + '" style="padding:2px 8px;font-size:.7rem;color:#8B3A3A;background:transparent;border:1px solid #8B3A3A" title="Delete message">&#10005;</button></div></div>';
    html += '<div style="font-size:.8rem;font-weight:600;margin-bottom:4px">' + esc(msg.subject || '') + '</div>';
    html += '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">' + esc(msg.body || '') + '</pre></div>';
  });

  // Send message form with templates
  html += '<h3 style="margin:20px 0 8px">Send Message</h3>';
  html += '<div class="field"><label>Quick Template</label><select id="msgTemplate" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem;margin-bottom:8px">';
  html += '<option value="">Write from scratch...</option>';
  html += '<option value="welcome">Welcome &amp; Portal Access</option>';
  html += '<option value="followup">Follow-Up / Checking In</option>';
  html += '<option value="application_reminder">Application Reminder</option>';
  html += '<option value="approved">Application Approved</option>';
  html += '<option value="waitlist">Waitlisted - No Kittens Available</option>';
  html += '<option value="kitten_available">Kitten Available for You</option>';
  html += '<option value="deposit_reminder">Deposit Reminder</option>';
  html += '<option value="thankyou">Thank You</option>';
  html += '</select></div>';
  html += '<div class="field"><label>Subject</label><input type="text" id="msgSubject" value="Blue Sky Cattery" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px"></div>';
  html += '<div class="field"><label>Message</label><textarea id="msgBody" rows="6" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px" placeholder="Type your message to ' + esc(lead.name) + '..."></textarea></div>';

  html += '<div class="actions">';
  html += '<button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Close</button>';
  html += '<button class="btn btn-primary" id="sendMsgBtn">Send Email</button>';
  html += '</div>';

  modal.innerHTML = html;
  bg.appendChild(modal);
  document.body.appendChild(bg);

  // Email template handler
  const _N = String.fromCharCode(10);
  const _tpl = {
    welcome: { s: 'Welcome to Blue Sky Cattery!', b: 'Dear ' + lead.name + ',' + _N + _N + 'Thank you for your interest in Blue Sky Cattery! We are so glad you found us.' + _N + _N + 'We specialize in CFA-registered Oriental Shorthairs, raised underfoot in our home in Northwest Missouri. Every kitten gets individual attention, love, and the best start to life.' + _N + _N + 'To take the next step, please visit our Application Portal:' + _N + 'https://portal.blueskycattery.com' + _N + _N + 'There you can create an account, fill out our adoption application, view available kittens, and join our waitlist for upcoming litters.' + _N + _N + 'If you have any questions at all, just reply to this email. We love talking about our cats!' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    followup: { s: 'Checking In - Blue Sky Cattery', b: 'Hi ' + lead.name + ',' + _N + _N + 'I wanted to follow up and see if you had any questions about our kittens or the adoption process. We are always happy to chat!' + _N + _N + 'If you have not had a chance to visit our portal yet, you can do so at:' + _N + 'https://portal.blueskycattery.com' + _N + _N + 'Feel free to reply to this email anytime.' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    application_reminder: { s: 'Your Application is Waiting - Blue Sky Cattery', b: 'Hi ' + lead.name + ',' + _N + _N + 'I noticed you started the adoption process but have not completed your application yet. No rush at all! Just wanted to let you know your progress is saved and you can pick up right where you left off.' + _N + _N + 'Log in here: https://portal.blueskycattery.com' + _N + _N + 'Our kittens go to approved families on a first-come basis, so completing your application sooner gives you the best selection.' + _N + _N + 'Let me know if you have any questions!' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    approved: { s: 'Great News! Your Application is Approved - Blue Sky Cattery', b: 'Dear ' + lead.name + ',' + _N + _N + 'Wonderful news! After reviewing your application, we are happy to approve you as an adopter with Blue Sky Cattery.' + _N + _N + 'Next steps:' + _N + '1. Log into the portal: https://portal.blueskycattery.com' + _N + '2. Review available kittens and let us know your preference' + _N + '3. A $500 non-refundable deposit secures your kitten' + _N + _N + 'We will be in touch to schedule a video visit so you can meet your potential new family member!' + _N + _N + 'Congratulations and welcome to the Blue Sky family!' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    waitlist: { s: 'Waitlist Update - Blue Sky Cattery', b: 'Hi ' + lead.name + ',' + _N + _N + 'Thank you for your application! We do not currently have kittens available that match your preferences, but we have added you to our priority waitlist.' + _N + _N + 'You will be among the first to know when new kittens arrive. We typically have 1-2 litters per year, and waitlist members get first choice.' + _N + _N + 'In the meantime, feel free to follow us on social media for updates and adorable kitten photos!' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    kitten_available: { s: 'A Kitten is Available for You! - Blue Sky Cattery', b: 'Hi ' + lead.name + ',' + _N + _N + 'Exciting news! We have a kitten that we think would be a wonderful match for you.' + _N + _N + 'Please log into the portal to view details and photos:' + _N + 'https://portal.blueskycattery.com' + _N + _N + 'If you are interested, please let me know as soon as possible. A $500 non-refundable deposit will secure your kitten. Our kittens find homes quickly!' + _N + _N + 'I would also love to set up a video visit so you can see the kitten live.' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    deposit_reminder: { s: 'Deposit Reminder - Blue Sky Cattery', b: 'Hi ' + lead.name + ',' + _N + _N + 'This is a friendly reminder that a $500 non-refundable deposit is needed to secure your kitten reservation. The deposit will be applied toward the total adoption fee.' + _N + _N + 'We accept: Venmo, Zelle, PayPal, check, or cash.' + _N + _N + 'Please let me know once you have sent the deposit or if you have any questions about payment.' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' },
    thankyou: { s: 'Thank You! - Blue Sky Cattery', b: 'Dear ' + lead.name + ',' + _N + _N + 'Thank you so much for reaching out to Blue Sky Cattery. We truly appreciate your interest in our cats and our program.' + _N + _N + 'Whether you are looking for a kitten now or in the future, we are always here to answer questions and help you find the perfect companion.' + _N + _N + 'Do not hesitate to reach out anytime!' + _N + _N + 'Warm regards,' + _N + 'Deanna' + _N + 'Blue Sky Cattery' }
  };
  document.getElementById('msgTemplate').onchange = () => {
    const t = _tpl[document.getElementById('msgTemplate').value];
    if (t) { document.getElementById('msgSubject').value = t.s; document.getElementById('msgBody').value = t.b; }
  };

  document.getElementById('sendMsgBtn').onclick = async () => {
    const subject = document.getElementById('msgSubject').value;
    const body = document.getElementById('msgBody').value;
    if (!body.trim()) { alert('Please enter a message'); return; }
    const btn = document.getElementById('sendMsgBtn');
    btn.disabled = true; btn.textContent = 'Sending...';
    const res = await api('/admin/send-message', { method: 'POST', body: JSON.stringify({ lead_id: leadId, subject, body }) });
    if (res.success) {
      bg.remove();
      showLeadModal(leadId); // Refresh to show sent message
    } else {
      alert('Failed: ' + (res.error || 'Unknown error'));
      btn.disabled = false; btn.textContent = 'Send Email';
    }
  };

  // Attach delete handlers to message buttons
  bg.querySelectorAll('[data-msg-del]').forEach(btn => {
    btn.onclick = async () => {
      const msgId = btn.getAttribute('data-msg-del');
      if (!confirm('Delete this message?')) return;
      btn.disabled = true;
      const res = await api('/admin/messages/' + msgId, { method: 'DELETE' });
      if (res.success) {
        bg.remove();
        showLeadModal(leadId); // Refresh
      } else {
        alert('Failed to delete');
        btn.disabled = false;
      }
    };
  });
}

function showApprovalModal(name, email, password) {
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) { bg.remove(); renderApp(); }}});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2 style="color:#7A8B6F">Approved & Welcome Email Sent!</h2>' +
    '<p style="margin:12px 0">An applicant account has been created for <strong>' + esc(name) + '</strong> and a welcome email with login credentials has been sent automatically.</p>' +
    '<div class="field"><label>Email</label><div class="value">' + esc(email) + '</div></div>' +
    '<div class="field"><label>Temporary Password</label><div class="value" style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#A0522D;letter-spacing:1px">' + esc(password) + '</div></div>' +
    '<div class="field"><label>Portal URL</label><div class="value">https://portal.blueskycattery.com</div></div>' +
    '<p style="margin-top:16px;font-size:.85rem;color:#6B5B4B">The applicant received an email with these credentials and a link to the application portal.</p>' +
    '<div class="actions"><button class="btn btn-primary" onclick="this.closest(&#39;.modal-bg&#39;).remove();renderApp();">Close</button></div>';
  bg.appendChild(modal);
  document.body.appendChild(bg);
}

// ---- Applications ----

async function renderApplications(container) {
  const [appsRes, candsRes] = await Promise.all([api('/admin/applications'), api('/admin/candidates')]);
  const applications = appsRes.applications || [];
  const candidates = candsRes.candidates || {};
  const panel = el('div', { class: 'panel active' });

  // Top Candidates per Kitten
  if (Object.keys(candidates).length > 0) {
    let candsHtml = '<h2 style="margin:20px 0 12px">Top Candidates by Kitten</h2>';
    Object.entries(candidates).forEach(([kittenName, apps]) => {
      candsHtml += '<div style="margin-bottom:20px;padding:16px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px">';
      candsHtml += '<h4 style="margin-bottom:8px;color:#A0522D">' + esc(kittenName) + ' <span style="font-size:.8rem;font-weight:400;color:#6B5B4B">(' + apps.length + ' applicant' + (apps.length !== 1 ? 's' : '') + ')</span></h4>';
      if (apps.length === 0) {
        candsHtml += '<p style="font-size:.85rem;color:#6B5B4B">No applicants yet</p>';
      } else {
        candsHtml += '<table style="margin:0"><thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Preference</th><th>Purpose</th><th>Status</th></tr></thead><tbody>';
        apps.forEach((a, i) => {
          const prefColor = a.preference === 'Primary' ? '#7A8B6F' : a.preference === 'Backup 1' ? '#D4AF37' : '#87A5B4';
          candsHtml += '<tr><td><strong>' + (i+1) + '</strong></td><td>' + esc(a.full_name||'N/A') + '</td><td>' + scoreEl(a.score) + '</td>';
          candsHtml += '<td><span style="padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;background:' + prefColor + ';color:#fff">' + a.preference + '</span></td>';
          candsHtml += '<td>' + esc(a.purpose || 'Pet') + '</td><td>' + badge(a.status) + '</td></tr>';
        });
        candsHtml += '</tbody></table>';
      }
      candsHtml += '</div>';
    });
    panel.innerHTML = candsHtml;
  }

  // All Applications Table with search
  let appToolbar = '<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 12px;flex-wrap:wrap;gap:12px">';
  appToolbar += '<h2 style="margin:0">All Applications (' + applications.length + ')</h2>';
  appToolbar += '<div style="display:flex;gap:8px;align-items:center">';
  appToolbar += '<input type="text" id="appSearchInput" placeholder="Search name or email..." style="padding:8px 14px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem;width:200px">';
  appToolbar += '<select id="appStatusFilter" style="padding:8px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem"><option value="">All Status</option><option value="submitted">Submitted</option><option value="reviewed">Reviewed</option><option value="approved">Approved</option><option value="waitlist">Waitlist</option><option value="rejected">Rejected</option></select>';
  appToolbar += '<a href="' + API + '/admin/applications/export" class="btn btn-sm btn-outline" style="text-decoration:none;color:#6B5B4B" target="_blank">Export CSV</a>';
  appToolbar += '</div></div>';
  panel.innerHTML += appToolbar;

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Applicant</th><th>Score</th><th>Purpose</th><th>Primary Kitten</th><th>Sex Pref</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (applications || []).forEach(app => {
    const tr = el('tr');
    tr.innerHTML = '<td><strong>' + esc(app.full_name||'N/A') + '</strong><br><span style="font-size:.78rem;color:#6B5B4B">' + esc(app.user_email||app.email||'') + '</span></td>';
    tr.innerHTML += '<td>' + scoreEl(app.score) + '</td>';
    tr.innerHTML += '<td>' + esc(app.purpose || 'Pet') + '</td>';
    tr.innerHTML += '<td>' + esc(app.kitten_primary || '---') + '</td>';
    tr.innerHTML += '<td>' + esc(app.sex_preference || '---') + '</td>';
    tr.innerHTML += '<td>' + badge(app.status) + '</td>';
    tr.innerHTML += '<td>' + timeAgo(app.created_at) + '</td>';
    const actionTd = el('td');
    actionTd.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showAppModal(app.id) }, 'Review'));
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (applications.length === 0) panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No applications yet.</p>';
  container.appendChild(panel);

  // Client-side filter (instant, no API call)
  const appSearch = document.getElementById('appSearchInput');
  const appFilter = document.getElementById('appStatusFilter');
  if (appSearch && tbody) {
    const filterApps = () => {
      const q = (appSearch.value || '').toLowerCase();
      const s = appFilter.value;
      const rows = tbody.querySelectorAll('tr');
      rows.forEach((row, i) => {
        const app = applications[i];
        if (!app) return;
        const matchSearch = !q || (app.full_name||'').toLowerCase().includes(q) || (app.email||'').toLowerCase().includes(q) || (app.user_email||'').toLowerCase().includes(q);
        const matchStatus = !s || app.status === s;
        row.style.display = (matchSearch && matchStatus) ? '' : 'none';
      });
    };
    appSearch.oninput = filterApps;
    appFilter.onchange = filterApps;
  }
}

async function showAppModal(appId) {
  const { application: app } = await api('/admin/applications/' + appId);
  if (!app) return;
  const cats = app.score_breakdown ? JSON.parse(app.score_breakdown) : {};
  const appHighlights = app.highlights ? JSON.parse(app.highlights) : [];
  const appRisks = app.risks ? JSON.parse(app.risks) : [];
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });

  const gradeColor = app.score >= 80 ? '#7A8B6F' : app.score >= 65 ? '#D4AF37' : app.score >= 45 ? '#A0522D' : '#8B3A3A';
  const gradeLabel = app.score >= 80 ? 'Excellent' : app.score >= 65 ? 'Good' : app.score >= 45 ? 'Fair' : 'Needs Review';

  let html = '<h2>Application Review</h2>';

  // Score header
  html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;padding:16px;background:#F5EDE0;border-radius:12px">';
  html += scoreEl(app.score);
  html += '<div><strong style="font-size:1.1rem">' + esc(app.full_name||'N/A') + '</strong><br>';
  html += '<span style="color:' + gradeColor + ';font-weight:700">' + gradeLabel + '</span> &mdash; ' + app.score + '/100<br>';
  html += 'Purpose: <strong>' + esc(app.purpose || 'Pet') + '</strong> | Status: ' + badge(app.status);
  html += '</div></div>';

  // Kitten preferences
  if (app.kitten_primary || app.sex_preference) {
    html += '<div style="padding:12px 16px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:16px">';
    html += '<strong style="font-size:.82rem;text-transform:uppercase;letter-spacing:1px;color:#A0522D">Kitten Preferences</strong><br>';
    if (app.kitten_primary) html += 'Primary: <strong>' + esc(app.kitten_primary) + '</strong> ';
    if (app.kitten_backup1) html += '| Backup 1: ' + esc(app.kitten_backup1) + ' ';
    if (app.kitten_backup2) html += '| Backup 2: ' + esc(app.kitten_backup2) + ' ';
    if (app.sex_preference) html += '| Sex preference: <strong>' + esc(app.sex_preference) + '</strong>';
    html += '</div>';
  }

  // Highlights
  if (appHighlights.length > 0) {
    html += '<div style="padding:12px 16px;background:rgba(122,139,111,.08);border:1px solid rgba(122,139,111,.2);border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#7A8B6F;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Highlights</strong><ul style="margin:6px 0 0 16px;font-size:.88rem">';
    appHighlights.forEach(h => { html += '<li style="color:#5A6B4F">' + esc(h) + '</li>'; });
    html += '</ul></div>';
  }

  // Risks
  if (appRisks.length > 0) {
    html += '<div style="padding:12px 16px;background:rgba(139,58,58,.05);border:1px solid rgba(139,58,58,.15);border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#8B3A3A;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Detected Risks</strong><ul style="margin:6px 0 0 16px;font-size:.88rem">';
    appRisks.forEach(r => { html += '<li style="color:#6E2828">' + esc(r) + '</li>'; });
    html += '</ul></div>';
  }

  // Prior application matches
  if (app.match_flags) {
    html += '<div style="padding:12px 16px;background:rgba(135,165,180,.08);border:1px solid rgba(135,165,180,.25);border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#87A5B4;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Prior Application Matches</strong>';
    html += '<div style="font-size:.88rem;margin-top:6px;color:#3E3229">' + esc(app.match_flags).split(';').join('<br>') + '</div>';
    if (app.previous_app_ids) html += '<div style="font-size:.78rem;color:#6B5B4B;margin-top:4px">Related IDs: ' + esc(app.previous_app_ids) + '</div>';
    html += '</div>';
  }
  if (app.litter_code) {
    html += '<div style="font-size:.85rem;color:#6B5B4B;margin-bottom:12px">Litter: <strong>' + esc(app.litter_code) + '</strong></div>';
  }

  // Category breakdown
  html += '<h3 style="margin:16px 0 8px">Score Breakdown by Category</h3><div class="score-detail">';
  Object.entries(cats).forEach(([key, cat]) => {
    if (typeof cat === 'object' && cat.label) {
      const pct = cat.max > 0 ? Math.round((cat.score / cat.max) * 100) : 0;
      const barColor = cat.score < 0 ? '#8B3A3A' : pct >= 70 ? '#7A8B6F' : pct >= 40 ? '#D4AF37' : '#A0522D';
      html += '<div class="score-item" style="flex-direction:column;align-items:stretch">';
      html += '<div style="display:flex;justify-content:space-between"><span>' + esc(cat.label) + '</span><strong>' + cat.score + '/' + cat.max + '</strong></div>';
      if (cat.max > 0) {
        html += '<div style="background:#e8e2d8;border-radius:3px;height:6px;margin-top:4px"><div style="background:' + barColor + ';height:6px;border-radius:3px;width:' + pct + '%"></div></div>';
      }
      if (cat.flags && cat.flags.length > 0) {
        cat.flags.forEach(f => { html += '<div style="font-size:.78rem;color:#8B3A3A;margin-top:4px">&#9888; ' + esc(f) + '</div>'; });
      }
      if (cat.summary) {
        html += '<div style="font-size:.82rem;color:#3E3229;margin-top:6px;padding:8px;background:#F5EDE0;border-radius:4px">';
        html += '<strong>AI Assessment:</strong> ' + esc(cat.summary) + '<br>';
        if (cat.sincerity) html += '<span style="color:#6B5B4B">Sincerity: ' + cat.sincerity + '/10 | Knowledge: ' + (cat.knowledge||'?') + '/10</span>';
        html += '</div>';
      }
      html += '</div>';
    }
  });
  html += '</div>';

  // Full application details
  const sections = [
    { title: 'Personal', fields: [['Full Name', app.full_name], ['Email', app.email], ['Phone', app.phone], ['City/State', app.city_state], ['Home Address', app.home_address], ['Marital Status', app.marital_status]] },
    { title: 'Partner / Co-Applicant', fields: [['Partner Name', app.partner_name], ['Partner Email', app.partner_email], ['Partner Phone', app.partner_phone]] },
    { title: 'Home', fields: [['Housing', app.housing_type], ['Own/Rent', app.housing_own_rent], ['Landlord Info', app.landlord_info], ['Household', app.household_members], ['Schedule', app.work_schedule], ['Allergies', app.allergies]] },
    { title: 'Pets', fields: [['Current Pets', app.other_pets], ['Pet Source', app.pet_source], ['Pet History', app.pet_history], ['Health History', app.pet_health_history], ['Surrendered?', app.surrender_history], ['Surrender Details', app.surrender_details]] },
    { title: 'Knowledge', fields: [['Experience', app.cat_experience], ['Why Oriental', app.why_oriental], ['Vocal Comfort', app.vocal_comfort], ['Adjustment Plan', app.adjustment_plan], ['Rehome Circumstances', app.rehome_circumstances]] },
    { title: 'Readiness', fields: [['Enrichment Plan', app.enrichment_plan], ['Indoor Only', app.indoor_only], ['Spay/Neuter', app.spay_neuter_opinion], ['Financial', app.financial_readiness]] },
    { title: 'Vet & Other', fields: [['Vet Name', app.vet_name], ['Vet Phone', app.vet_phone], ['How Found Us', app.how_found_us], ['Timeline', app.timeline], ['Notes', app.additional_notes]] },
    { title: 'Verification', fields: [['Cat Count', app.verify_cat_count], ['Home Description', app.verify_home_description]] }
  ];

  sections.forEach(sec => {
    const hasData = sec.fields.some(([,v]) => v);
    if (!hasData) return;
    html += '<h3 style="margin:16px 0 8px;font-size:.95rem;color:#A0522D">' + sec.title + '</h3>';
    sec.fields.forEach(([label, val]) => {
      if (val) html += '<div class="field"><label>' + label + '</label><div class="value">' + esc(val) + '</div></div>';
    });
  });

  // Admin review
  html += '<h3 style="margin:16px 0 8px">Admin Decision</h3>';
  html += '<div class="field"><label>Status</label><select id="appStatus"><option value="submitted"' + (app.status==='submitted'?' selected':'') + '>Submitted</option><option value="reviewed"' + (app.status==='reviewed'?' selected':'') + '>Reviewed</option><option value="approved"' + (app.status==='approved'?' selected':'') + '>Approved</option><option value="waitlist"' + (app.status==='waitlist'?' selected':'') + '>Waitlist</option><option value="rejected"' + (app.status==='rejected'?' selected':'') + '>Rejected</option></select></div>';
  html += '<div class="field"><label>Admin Notes</label><textarea id="appNotes" rows="3">' + esc(app.admin_notes || '') + '</textarea></div>';
  html += '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-outline" id="reanalyzeBtn" style="color:#87A5B4;border-color:#87A5B4">Re-analyze with AI</button><button class="btn btn-primary" id="saveAppBtn">Save Review</button></div>';

  modal.innerHTML = html;
  bg.appendChild(modal);
  document.body.appendChild(bg);

  document.getElementById('saveAppBtn').onclick = async () => {
    const status = document.getElementById('appStatus').value;
    const notes = document.getElementById('appNotes').value;
    await api('/admin/applications/' + appId, { method: 'PUT', body: JSON.stringify({ status, admin_notes: notes }) });
    bg.remove();
    renderApp();
  };

  document.getElementById('reanalyzeBtn').onclick = async () => {
    const btn = document.getElementById('reanalyzeBtn');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    const res = await api('/admin/applications/' + appId + '/reanalyze', { method: 'POST' });
    if (res.success) {
      alert('AI analysis complete. New score: ' + res.score + ' (' + res.grade + ')');
      bg.remove();
      showAppModal(appId);
    } else {
      alert('AI analysis failed: ' + (res.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = 'Re-analyze with AI';
    }
  };
}

// ---- Kittens ----

async function renderKittens(container) {
  const { litters } = await api('/admin/litters');
  const panel = el('div', { class: 'panel active' });

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 12px"><h2>Litters & Kittens</h2>';
  html += '<button class="btn btn-primary btn-sm" id="addLitterBtn">+ New Litter</button></div>';
  panel.innerHTML = html;

  if (!litters || litters.length === 0) {
    panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No litters yet.</p>';
  }

  (litters || []).forEach(litter => {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom:32px';

    let litterHtml = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    litterHtml += '<div><h3 style="font-size:1.15rem;margin:0">Litter ' + esc(litter.litter_code) + '</h3>';
    litterHtml += '<span style="font-size:.82rem;color:#6B5B4B">' + esc(litter.sire_name) + ' x ' + esc(litter.dam_name) + ' | Born: ' + esc(litter.born_date || 'TBD') + ' | Go-Home: ' + esc(litter.go_home_date || 'TBD') + '</span></div>';
    litterHtml += '<div style="display:flex;gap:6px;align-items:center"><span class="badge badge-' + (litter.status === 'active' ? 'approved' : 'new') + '">' + esc(litter.status) + '</span>';
    litterHtml += '<button class="btn btn-sm btn-primary" data-announce="' + litter.id + '" data-type="announcement">Announce Litter</button>';
    litterHtml += '<button class="btn btn-sm btn-outline" data-announce="' + litter.id + '" data-type="photos">Send Photos Email</button>';
    litterHtml += '</div></div>';

    const statusColors = { available: '#7A8B6F', reserved: '#D4AF37', pending: '#87A5B4', sold: '#8B3A3A' };

    litterHtml += '<table><thead><tr><th>#</th><th>Name</th><th>Color</th><th>Sex</th><th>Status</th><th>Reserved By</th><th>Deposit</th><th>Price</th><th>Actions</th></tr></thead><tbody>';
    (litter.kittens || []).forEach(k => {
      const statusColor = statusColors[k.status] || '#6B5B4B';
      const depositIndicator = k.deposit_received_date ? '<span title="Deposit received ' + esc(k.deposit_received_date) + ' via ' + esc(k.deposit_method || '?') + '" style="color:#7A8B6F;font-weight:700;font-size:1.1rem">&#10003;</span>' : (k.status === 'pending' ? '<span title="Deposit pending" style="color:#D4AF37;font-weight:700;font-size:1.1rem">&#9679;</span>' : '<span style="color:#ccc">---</span>');
      litterHtml += '<tr>';
      litterHtml += '<td><strong>' + k.number + '</strong></td>';
      litterHtml += '<td>' + esc(k.name || 'Kitten #' + k.number) + '</td>';
      litterHtml += '<td>' + esc(k.color || 'TBD') + '</td>';
      litterHtml += '<td>' + esc(k.sex || 'TBD') + '</td>';
      litterHtml += '<td><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:' + statusColor + ';color:#fff">' + esc(k.status) + '</span></td>';
      litterHtml += '<td>' + esc(k.reserved_by || '---') + '</td>';
      litterHtml += '<td style="text-align:center">' + depositIndicator + '</td>';
      litterHtml += '<td>$' + (k.price || 1800) + '</td>';
      litterHtml += '<td><button class="btn btn-outline btn-sm" data-kitten-id="' + k.id + '">Edit</button></td>';
      litterHtml += '</tr>';
    });
    litterHtml += '</tbody></table>';

    section.innerHTML = litterHtml;

    section.querySelectorAll('[data-kitten-id]').forEach(btn => {
      btn.onclick = () => showKittenEditModal(btn.getAttribute('data-kitten-id'), litter.kittens.find(k => k.id == btn.getAttribute('data-kitten-id')));
    });

    // Announce buttons
    section.querySelectorAll('[data-announce]').forEach(btn => {
      btn.onclick = async () => {
        const litterId = btn.getAttribute('data-announce');
        const type = btn.getAttribute('data-type');
        const label = type === 'photos' ? 'Send kitten photos email' : 'Send new litter announcement';
        const msg = prompt(label + ' to all interested leads & waitlist applicants.\\n\\nOptional custom message (or leave blank for default):');
        if (msg === null) return; // cancelled
        btn.disabled = true; btn.textContent = 'Sending...';
        const res = await api('/admin/announce-litter', { method: 'POST', body: JSON.stringify({ litter_id: parseInt(litterId), template_type: type, custom_message: msg || '' }) });
        if (res.success) {
          alert('Sent to ' + res.sent + ' recipients! (' + res.failed + ' failed)');
          btn.textContent = 'Sent!';
        } else {
          alert('Error: ' + (res.error || 'Unknown'));
          btn.disabled = false; btn.textContent = type === 'photos' ? 'Send Photos Email' : 'Announce Litter';
        }
      };
    });

    panel.appendChild(section);
  });

  container.appendChild(panel);

  // Add litter button handler
  const addLitterBtn = panel.querySelector('#addLitterBtn');
  if (addLitterBtn) {
    addLitterBtn.onclick = () => showAddLitterModal();
  }
}

function showAddLitterModal() {
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2>New Litter</h2>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Year</label><input type="number" id="nlYear" value="2026"></div>' +
    '<div class="field"><label>Dam (Queen) Name</label><input type="text" id="nlDam" placeholder="e.g. Luna"></div>' +
    '<div class="field"><label>Sire (King) Name</label><input type="text" id="nlSire" placeholder="e.g. Apollo"></div>' +
    '<div class="field"><label>Total Kittens</label><input type="number" id="nlCount" value="4"></div>' +
    '<div class="field"><label>Born Date</label><input type="date" id="nlBorn"></div>' +
    '<div class="field"><label>Go-Home Date</label><input type="date" id="nlGoHome"></div>' +
    '</div>' +
    '<div class="field" style="margin-top:12px"><label>Notes</label><textarea id="nlNotes" rows="2"></textarea></div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveLitterBtn">Create Litter</button></div>';
  bg.appendChild(modal);
  document.body.appendChild(bg);

  document.getElementById('saveLitterBtn').onclick = async () => {
    const data = {
      year: parseInt(document.getElementById('nlYear').value),
      dam_name: document.getElementById('nlDam').value,
      sire_name: document.getElementById('nlSire').value,
      total_kittens: parseInt(document.getElementById('nlCount').value),
      born_date: document.getElementById('nlBorn').value || null,
      go_home_date: document.getElementById('nlGoHome').value || null,
      notes: document.getElementById('nlNotes').value
    };
    if (!data.dam_name || !data.sire_name) { alert('Dam and Sire names are required.'); return; }
    const res = await api('/admin/litters', { method: 'POST', body: JSON.stringify(data) });
    if (res.success) { bg.remove(); renderApp(); }
    else alert(res.error || 'Failed');
  };
}

async function showKittenEditModal(kittenId, kitten) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };

  const modal = document.createElement('div');
  modal.className = 'modal';

  // Fetch existing photos and checklist
  const { photos } = await api('/admin/photos/kitten/' + kittenId);
  let goHomeChecklist = {};
  if (kitten.status === 'reserved' || kitten.status === 'sold') {
    const clRes = await api('/admin/kittens/' + kittenId + '/checklist');
    goHomeChecklist = clRes.checklist || {};
  }

  let photoHtml = '<div class="field"><label>Photos</label>';
  photoHtml += '<div id="ekPhotoGrid" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
  (photos || []).forEach(p => {
    photoHtml += '<div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;border:' + (p.sort_order === 0 ? '3px solid #A0522D' : '1px solid #D4C5A9') + '">';
    photoHtml += '<img src="' + esc(p.url) + '" style="width:100%;height:100%;object-fit:cover">';
    photoHtml += '<div style="position:absolute;top:2px;right:2px;display:flex;gap:2px">';
    if (p.sort_order !== 0) photoHtml += '<button data-photo-primary="' + p.id + '" style="background:#D4AF37;color:#fff;border:none;border-radius:3px;font-size:.6rem;cursor:pointer;padding:1px 4px" title="Set as primary">&#9733;</button>';
    photoHtml += '<button data-photo-del="' + p.id + '" style="background:#8B3A3A;color:#fff;border:none;border-radius:3px;font-size:.6rem;cursor:pointer;padding:1px 4px" title="Delete">&#10005;</button>';
    photoHtml += '<button data-photo-reassign="' + p.id + '" style="background:#87A5B4;color:#fff;border:none;border-radius:3px;font-size:.6rem;cursor:pointer;padding:1px 4px" title="Reassign">&#8644;</button>';
    photoHtml += '</div></div>';
  });
  photoHtml += '</div>';
  photoHtml += '<input type="file" id="ekPhotoUpload" accept="image/*" multiple style="font-size:.82rem">';
  photoHtml += '<div id="ekUploadStatus" style="font-size:.78rem;color:#6B5B4B;margin-top:4px"></div>';
  photoHtml += '<div style="margin-top:8px;padding:10px;background:#F5EDE0;border-radius:6px;font-size:.75rem;color:#6B5B4B">';
  photoHtml += '<strong>Upload options:</strong><br>';
  photoHtml += '&#8226; <strong>Here:</strong> Click the file picker above to upload from your device. Photos are auto-optimized for web.<br>';
  photoHtml += '&#8226; <strong>By email:</strong> Send photos to <strong>kittens@blueskycattery.com</strong> from an admin email. Name files after the kitten &mdash; e.g. <strong>' + esc(kitten.name || 'Kitten') + '1.jpg</strong>, <strong>' + esc(kitten.name || 'Kitten') + '2.jpg</strong>. They will be matched and added automatically. Unmatched photos go to the Todo page for manual assignment.<br>';
  photoHtml += '&#8226; <strong>Buttons:</strong> &#9733; = set as primary photo &bull; &#8644; = reassign to different cat/kitten &bull; &#10005; = delete</div>';
  photoHtml += '</div>';

  modal.innerHTML = '<h2>Edit Kitten #' + kitten.number + '</h2>' +
    '<div class="field"><label>Name</label><input type="text" id="ekName" value="' + esc(kitten.name || '') + '"></div>' +
    '<div class="field"><label>Color</label><input type="text" id="ekColor" value="' + esc(kitten.color || '') + '"></div>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Sex</label><select id="ekSex"><option value="">TBD</option><option value="male"' + (kitten.sex === 'male' ? ' selected' : '') + '>Male</option><option value="female"' + (kitten.sex === 'female' ? ' selected' : '') + '>Female</option></select></div>' +
    '<div class="field"><label>Price ($)</label><input type="number" id="ekPrice" value="' + (kitten.price || 1800) + '"></div></div>' +
    '<div class="field"><label>Status</label><select id="ekStatus">' +
    '<option value="available"' + (kitten.status === 'available' ? ' selected' : '') + '>Available</option>' +
    '<option value="pending"' + (kitten.status === 'pending' ? ' selected' : '') + '>Reserved - Pending Deposit</option>' +
    '<option value="reserved"' + (kitten.status === 'reserved' ? ' selected' : '') + '>Reserved - Deposit Received</option>' +
    '<option value="sold"' + (kitten.status === 'sold' ? ' selected' : '') + '>Sold</option>' +
    '</select></div>' +
    '<div class="field"><label>Reserved By (name or email)</label><input type="text" id="ekReservedBy" value="' + esc(kitten.reserved_by || '') + '"></div>' +
    photoHtml +
    '<div style="border-top:1px solid #D4C5A9;margin:16px 0 12px;padding-top:12px"><h3 style="font-size:.95rem;margin:0 0 10px;color:#A0522D">Payment & Deposit</h3></div>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Deposit Amount ($)</label><input type="number" id="ekDepositAmount" step="0.01" value="' + (kitten.deposit_amount || '') + '"></div>' +
    '<div class="field"><label>Deposit Received Date</label><input type="date" id="ekDepositDate" value="' + esc(kitten.deposit_received_date || '') + '"></div></div>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Payment Method</label><select id="ekDepositMethod">' +
    '<option value="">-- Select --</option>' +
    '<option value="Cash"' + (kitten.deposit_method === 'Cash' ? ' selected' : '') + '>Cash</option>' +
    '<option value="Check"' + (kitten.deposit_method === 'Check' ? ' selected' : '') + '>Check</option>' +
    '<option value="Venmo"' + (kitten.deposit_method === 'Venmo' ? ' selected' : '') + '>Venmo</option>' +
    '<option value="Zelle"' + (kitten.deposit_method === 'Zelle' ? ' selected' : '') + '>Zelle</option>' +
    '<option value="PayPal"' + (kitten.deposit_method === 'PayPal' ? ' selected' : '') + '>PayPal</option>' +
    '<option value="Wire"' + (kitten.deposit_method === 'Wire' ? ' selected' : '') + '>Wire</option>' +
    '<option value="Other"' + (kitten.deposit_method === 'Other' ? ' selected' : '') + '>Other</option>' +
    '</select></div>' +
    '<div class="field"><label>Balance Due ($)</label><input type="number" id="ekBalanceDue" step="0.01" value="' + (kitten.balance_due != null ? kitten.balance_due : '') + '"></div></div>' +
    '<div class="field"><label>Payment Notes</label><textarea id="ekPaymentNotes" rows="2" style="font-size:.85rem">' + esc(kitten.payment_notes || '') + '</textarea></div>' +
    '<div class="field"><label>Notes</label><textarea id="ekNotes" rows="2">' + esc(kitten.notes || '') + '</textarea></div>' +
    ((kitten.status === 'reserved' || kitten.status === 'sold') ? (function() {
      var clItems = [
        { key: 'spayed_neutered', label: 'Spay/neuter confirmed' },
        { key: 'vaccinations_current', label: 'Vaccinations current' },
        { key: 'microchipped', label: 'Microchipped' },
        { key: 'vet_health_check', label: 'Vet health check complete' },
        { key: 'adoption_contract_signed', label: 'Adoption contract signed' },
        { key: 'deposit_received_full', label: 'Deposit received in full' },
        { key: 'care_packet_prepared', label: 'Care packet prepared' },
        { key: 'owner_contact_verified', label: 'New owner contact info verified' },
        { key: 'carrier_transport_arranged', label: 'Carrier/transport arranged' }
      ];
      var done = clItems.filter(function(ci) { return goHomeChecklist[ci.key]; }).length;
      var total = clItems.length;
      var pct = Math.round((done / total) * 100);
      var h = '<div style="border-top:1px solid #D4C5A9;margin:16px 0 12px;padding-top:12px">' +
        '<h3 style="font-size:.95rem;margin:0 0 8px;color:#A0522D">Go-Home Readiness</h3>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<span style="font-size:.82rem;font-weight:600;color:#6B5B4B" id="ekChecklistProgress">' + done + '/' + total + ' complete</span>' +
        '<div style="flex:1;height:8px;background:#E8E0D0;border-radius:4px;overflow:hidden">' +
        '<div id="ekChecklistBar" style="height:100%;width:' + pct + '%;background:' + (pct === 100 ? '#7A8B6F' : '#D4AF37') + ';border-radius:4px;transition:width .3s"></div>' +
        '</div></div>';
      clItems.forEach(function(ci) {
        h += '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:.85rem;cursor:pointer">' +
          '<input type="checkbox" data-checklist-key="' + ci.key + '"' + (goHomeChecklist[ci.key] ? ' checked' : '') + ' style="width:16px;height:16px;accent-color:#A0522D">' +
          '<span>' + esc(ci.label) + '</span></label>';
      });
      h += '</div>';
      return h;
    })() : '') +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveKittenBtn">Save Changes</button></div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  // Auto-calculate balance due when deposit or price changes
  const calcBalance = () => {
    const price = parseFloat(document.getElementById('ekPrice').value) || 0;
    const deposit = parseFloat(document.getElementById('ekDepositAmount').value) || 0;
    document.getElementById('ekBalanceDue').value = (price - deposit).toFixed(2);
  };
  document.getElementById('ekDepositAmount').addEventListener('input', calcBalance);
  document.getElementById('ekPrice').addEventListener('input', calcBalance);

  // Photo upload handler
  document.getElementById('ekPhotoUpload').onchange = async (e) => {
    const files = e.target.files;
    if (!files.length) return;
    const status = document.getElementById('ekUploadStatus');
    status.textContent = 'Optimizing & uploading ' + files.length + ' photo(s)...';
    for (const file of files) {
      const resized = await resizeImage(file, 1200, 0.8);
      await api('/admin/photos/upload', { method: 'POST', body: JSON.stringify({
        entity_type: 'kitten', entity_id: kittenId,
        photos: [{ filename: file.name, data: resized }]
      })});
    }
    bg.remove();
    showKittenEditModal(kittenId, kitten); // Refresh
  };

  // Photo delete handlers
  bg.querySelectorAll('[data-photo-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      await api('/admin/photos/' + btn.getAttribute('data-photo-del'), { method: 'DELETE' });
      bg.remove();
      showKittenEditModal(kittenId, kitten);
    };
  });

  // Photo set-primary handlers
  bg.querySelectorAll('[data-photo-primary]').forEach(btn => {
    btn.onclick = async () => {
      await api('/admin/photos/' + btn.getAttribute('data-photo-primary') + '/primary', { method: 'PUT' });
      bg.remove();
      showKittenEditModal(kittenId, kitten);
    };
  });

  bg.querySelectorAll('[data-photo-reassign]').forEach(btn => {
    btn.onclick = () => reassignPhoto(btn.getAttribute('data-photo-reassign'), () => { bg.remove(); showKittenEditModal(kittenId, kitten); });
  });

  // Go-Home Checklist checkbox handlers
  bg.querySelectorAll('[data-checklist-key]').forEach(cb => {
    cb.onchange = async () => {
      const key = cb.getAttribute('data-checklist-key');
      const val = cb.checked;
      await api('/admin/kittens/' + kittenId + '/checklist', {
        method: 'PUT',
        body: JSON.stringify({ checklist: { [key]: val } })
      });
      // Update progress indicator
      const allCbs = bg.querySelectorAll('[data-checklist-key]');
      let doneCount = 0;
      allCbs.forEach(function(c) { if (c.checked) doneCount++; });
      const totalCount = allCbs.length;
      const progEl = document.getElementById('ekChecklistProgress');
      const barEl = document.getElementById('ekChecklistBar');
      if (progEl) progEl.textContent = doneCount + '/' + totalCount + ' complete';
      if (barEl) {
        const newPct = Math.round((doneCount / totalCount) * 100);
        barEl.style.width = newPct + '%';
        barEl.style.background = newPct === 100 ? '#7A8B6F' : '#D4AF37';
      }
    };
  });

  document.getElementById('saveKittenBtn').onclick = async () => {
    await api('/admin/kittens/' + kittenId, { method: 'PUT', body: JSON.stringify({
      name: document.getElementById('ekName').value,
      color: document.getElementById('ekColor').value,
      sex: document.getElementById('ekSex').value,
      price: parseFloat(document.getElementById('ekPrice').value),
      status: document.getElementById('ekStatus').value,
      reserved_by: document.getElementById('ekReservedBy').value,
      deposit_amount: document.getElementById('ekDepositAmount').value ? parseFloat(document.getElementById('ekDepositAmount').value) : null,
      deposit_received_date: document.getElementById('ekDepositDate').value || null,
      deposit_method: document.getElementById('ekDepositMethod').value || null,
      balance_due: document.getElementById('ekBalanceDue').value ? parseFloat(document.getElementById('ekBalanceDue').value) : null,
      payment_notes: document.getElementById('ekPaymentNotes').value || null,
      notes: document.getElementById('ekNotes').value
    })});
    bg.remove();
    renderApp();
  };
}

// ---- Cats (Kings & Queens) ----

async function renderCats(container) {
  const { cats } = await api('/admin/cats');
  const panel = el('div', { class: 'panel active' });

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 12px"><h2>Kings & Queens</h2>';
  html += '<button class="btn btn-primary btn-sm" id="addCatBtn">+ Add Cat</button></div>';

  html += '<table><thead><tr><th>Photo</th><th>Name</th><th>Breed</th><th>Role</th><th>Sex</th><th>Color</th><th>Health</th><th>Status</th><th>Order</th><th>Actions</th></tr></thead><tbody>';
  (cats || []).forEach(cat => {
    html += '<tr>';
    html += '<td>' + (cat.photo_url ? '<img src="' + esc(cat.photo_url) + '" style="width:40px;height:40px;border-radius:6px;object-fit:cover">' : '<div style="width:40px;height:40px;border-radius:6px;background:#D4C5A9;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#6B5B4B">N/A</div>') + '</td>';
    html += '<td><strong>' + esc(cat.name) + '</strong></td>';
    html += '<td>' + esc(cat.breed || '---') + '</td>';
    html += '<td><span style="padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;background:' + (cat.role === 'king' ? '#87A5B4' : '#C8849B') + ';color:#fff;text-transform:uppercase">' + esc(cat.role) + '</span></td>';
    html += '<td>' + esc(cat.sex || '---') + '</td>';
    html += '<td>' + esc(cat.color || '---') + '</td>';
    html += '<td>' + (cat.health_tested ? '<span style="color:#7A8B6F;font-weight:700">Yes</span>' : '<span style="color:#999">No</span>') + '</td>';
    html += '<td>' + badge(cat.status) + '</td>';
    html += '<td>' + (cat.sort_order || 0) + '</td>';
    html += '<td><button class="btn btn-outline btn-sm" data-cat-edit="' + cat.id + '">Edit</button>';
    if (cat.status === 'active') html += ' <button class="btn btn-danger btn-sm" data-cat-del="' + cat.id + '">Remove</button>';
    html += '</td></tr>';
  });
  html += '</tbody></table>';
  if (!cats || cats.length === 0) html += '<p style="color:#6B5B4B;padding:20px;text-align:center">No cats added yet.</p>';

  panel.innerHTML = html;
  container.appendChild(panel);

  // Event handlers
  panel.querySelector('#addCatBtn').onclick = () => showCatModal(null);

  panel.querySelectorAll('[data-cat-edit]').forEach(btn => {
    const catId = btn.getAttribute('data-cat-edit');
    const cat = (cats || []).find(c => c.id == catId);
    btn.onclick = () => showCatModal(cat);
  });

  panel.querySelectorAll('[data-cat-del]').forEach(btn => {
    btn.onclick = async () => {
      const catId = btn.getAttribute('data-cat-del');
      if (confirm('Remove this cat? (sets status to inactive)')) {
        await api('/admin/cats/' + catId, { method: 'DELETE' });
        renderApp();
      }
    };
  });
}

async function showCatModal(cat) {
  const isEdit = !!cat;
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });

  // Fetch existing photos if editing
  let photoHtml = '';
  if (isEdit) {
    const { photos } = await api('/admin/photos/cat/' + cat.id);
    photoHtml = '<div class="field"><label>Photos</label>';
    photoHtml += '<div id="catPhotoGrid" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
    (photos || []).forEach(p => {
      photoHtml += '<div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;border:' + (p.sort_order === 0 ? '3px solid #A0522D' : '1px solid #D4C5A9') + '">';
      photoHtml += '<img src="' + esc(p.url) + '" style="width:100%;height:100%;object-fit:cover">';
      photoHtml += '<div style="position:absolute;top:2px;right:2px;display:flex;gap:2px">';
      if (p.sort_order !== 0) photoHtml += '<button data-photo-primary="' + p.id + '" style="background:#D4AF37;color:#fff;border:none;border-radius:3px;font-size:.6rem;cursor:pointer;padding:1px 4px" title="Set as primary">&#9733;</button>';
      photoHtml += '<button data-photo-del="' + p.id + '" style="background:#8B3A3A;color:#fff;border:none;border-radius:3px;font-size:.6rem;cursor:pointer;padding:1px 4px" title="Delete">&#10005;</button>';
      photoHtml += '</div></div>';
    });
    photoHtml += '</div>';
    photoHtml += '<input type="file" id="catPhotoUpload" accept="image/*" multiple style="font-size:.82rem">';
    photoHtml += '<div id="catUploadStatus" style="font-size:.78rem;color:#6B5B4B;margin-top:4px"></div>';
    photoHtml += '<div style="margin-top:8px;padding:10px;background:#F5EDE0;border-radius:6px;font-size:.75rem;color:#6B5B4B">';
    photoHtml += '<strong>Upload options:</strong><br>';
    photoHtml += '&#8226; <strong>Here:</strong> Click the file picker above to upload from your device. Photos are auto-optimized for web.<br>';
    photoHtml += '&#8226; <strong>By email:</strong> Send photos to <strong>kittens@blueskycattery.com</strong> from an admin email. Name files after the cat &mdash; e.g. <strong>' + esc(cat.name) + '1.jpg</strong>, <strong>' + esc(cat.name) + '2.jpg</strong>. They will be matched and added automatically. Unmatched photos go to the Todo page for manual assignment.<br>';
    photoHtml += '&#8226; <strong>Buttons:</strong> &#9733; = set as primary photo &bull; &#8644; = reassign to different cat/kitten &bull; &#10005; = delete</div>';
    photoHtml += '</div>';
  }

  modal.innerHTML = '<h2>' + (isEdit ? 'Edit Cat' : 'Add Cat') + '</h2>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Name</label><input type="text" id="catName" value="' + esc(cat ? cat.name : '') + '"></div>' +
    '<div class="field"><label>Breed</label><input type="text" id="catBreed" value="' + esc(cat ? cat.breed : 'Oriental Shorthair') + '"></div>' +
    '<div class="field"><label>Role</label><select id="catRole"><option value="queen"' + (cat && cat.role === 'queen' ? ' selected' : '') + '>Queen</option><option value="king"' + (cat && cat.role === 'king' ? ' selected' : '') + '>King</option></select></div>' +
    '<div class="field"><label>Sex</label><select id="catSex"><option value="female"' + (cat && cat.sex === 'female' ? ' selected' : '') + '>Female</option><option value="male"' + (cat && cat.sex === 'male' ? ' selected' : '') + '>Male</option></select></div>' +
    '<div class="field"><label>Color</label><input type="text" id="catColor" value="' + esc(cat ? cat.color : '') + '"></div>' +
    '<div class="field"><label>Registration</label><input type="text" id="catReg" value="' + esc(cat ? cat.registration : '') + '"></div>' +
    (!isEdit ? '<div class="field"><label>Photo URL</label><input type="text" id="catPhoto" value=""></div>' : '') +
    '<div class="field"><label>Sort Order</label><input type="number" id="catSort" value="' + (cat ? cat.sort_order || 0 : 0) + '"></div>' +
    '</div>' +
    photoHtml +
    '<div class="field" style="margin-top:12px"><label>Bio</label><textarea id="catBio" rows="3">' + esc(cat ? cat.bio : '') + '</textarea></div>' +
    '<div style="display:flex;gap:16px;margin-top:12px;align-items:center">' +
    '<label style="display:flex;align-items:center;gap:8px;font-size:.88rem"><input type="checkbox" id="catHealth"' + (cat && cat.health_tested ? ' checked' : '') + '> Health Tested</label>' +
    (isEdit ? '<label style="display:flex;align-items:center;gap:8px;font-size:.88rem">Status: <select id="catStatus"><option value="active"' + (cat.status === 'active' ? ' selected' : '') + '>Active</option><option value="inactive"' + (cat.status === 'inactive' ? ' selected' : '') + '>Inactive</option><option value="retired"' + (cat.status === 'retired' ? ' selected' : '') + '>Retired</option></select></label>' : '') +
    '</div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveCatBtn">' + (isEdit ? 'Save Changes' : 'Add Cat') + '</button></div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  // Photo upload handler (edit mode only)
  if (isEdit) {
    const uploadEl = document.getElementById('catPhotoUpload');
    if (uploadEl) {
      uploadEl.onchange = async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        document.getElementById('catUploadStatus').textContent = 'Optimizing & uploading ' + files.length + ' photo(s)...';
        for (const file of files) {
          const resized = await resizeImage(file, 1200, 0.8);
          await api('/admin/photos/upload', { method: 'POST', body: JSON.stringify({
            entity_type: 'cat', entity_id: cat.id,
            photos: [{ filename: file.name, data: resized }]
          })});
        }
        bg.remove();
        showCatModal(cat);
      };
    }

    bg.querySelectorAll('[data-photo-del]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Delete this photo?')) return;
        await api('/admin/photos/' + btn.getAttribute('data-photo-del'), { method: 'DELETE' });
        bg.remove();
        showCatModal(cat);
      };
    });

    bg.querySelectorAll('[data-photo-primary]').forEach(btn => {
      btn.onclick = async () => {
        await api('/admin/photos/' + btn.getAttribute('data-photo-primary') + '/primary', { method: 'PUT' });
        bg.remove();
        showCatModal(cat);
      };
    });

    bg.querySelectorAll('[data-photo-reassign]').forEach(btn => {
      btn.onclick = () => reassignPhoto(btn.getAttribute('data-photo-reassign'), () => { bg.remove(); showCatModal(cat); });
    });
  }

  document.getElementById('saveCatBtn').onclick = async () => {
    const data = {
      name: document.getElementById('catName').value,
      breed: document.getElementById('catBreed').value,
      role: document.getElementById('catRole').value,
      sex: document.getElementById('catSex').value,
      color: document.getElementById('catColor').value,
      registration: document.getElementById('catReg').value,
      sort_order: parseInt(document.getElementById('catSort').value) || 0,
      bio: document.getElementById('catBio').value,
      health_tested: document.getElementById('catHealth').checked
    };
    const photoUrlEl = document.getElementById('catPhoto');
    if (photoUrlEl) data.photo_url = photoUrlEl.value;
    if (isEdit) {
      const statusEl = document.getElementById('catStatus');
      if (statusEl) data.status = statusEl.value;
      await api('/admin/cats/' + cat.id, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      if (!data.name) { alert('Name is required.'); return; }
      await api('/admin/cats', { method: 'POST', body: JSON.stringify(data) });
    }
    bg.remove();
    renderApp();
  };
}

// ---- Settings ----

// ---- Social Media ----

async function renderSocial(container) {
  const panel = el('div', { class: 'panel active' });
  // Fetch social config
  const fbPageIdRow = await api('/admin/settings').then(r => (r.settings || []).find(s => s.key === 'fb_page_id'));
  const fbTokenRow = await api('/admin/settings').then(r => (r.settings || []).find(s => s.key === 'fb_page_token'));
  const igUserIdRow = await api('/admin/settings').then(r => (r.settings || []).find(s => s.key === 'ig_user_id'));
  const isConfigured = fbPageIdRow && fbPageIdRow.value && fbTokenRow && fbTokenRow.value;

  let html = '<h2 style="margin:20px 0 4px">Social Media</h2>';
  html += '<p style="color:#6B5B4B;margin-bottom:20px;font-size:.88rem">Post to Facebook and Instagram directly from here.</p>';

  // Configuration section
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:16px 20px;border-radius:12px;border:1px solid rgba(212,197,169,.3);margin-bottom:20px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick="document.getElementById(&#39;socialConfig&#39;).style.display=document.getElementById(&#39;socialConfig&#39;).style.display===&#39;none&#39;?&#39;block&#39;:&#39;none&#39;">';
  html += '<strong style="font-size:.9rem;color:#A0522D">Account Settings</strong>';
  html += '<span style="font-size:.82rem;color:' + (isConfigured ? '#7A8B6F' : '#8B3A3A') + '">' + (isConfigured ? '&#10003; Connected' : '&#9888; Not configured') + '</span>';
  html += '</div>';
  html += '<div id="socialConfig" style="display:' + (isConfigured ? 'none' : 'block') + ';margin-top:12px">';
  html += '<div style="padding:10px 14px;background:#F5EDE0;border-radius:6px;margin-bottom:12px;font-size:.82rem;color:#6B5B4B"><strong>Note:</strong> Facebook and Instagram both use the same Page Access Token (Meta owns both). You only need one token for both platforms.</div>';
  html += '<div class="form-grid">';
  html += '<div class="field"><label>Facebook Page ID</label><input type="text" id="cfgFbPageId" value="' + esc(fbPageIdRow ? fbPageIdRow.value : '') + '" placeholder="e.g. 123456789012345"><div style="font-size:.72rem;color:#6B5B4B;margin-top:2px">Found in your Facebook Page settings or URL</div></div>';
  html += '<div class="field"><label>Instagram Business ID</label><input type="text" id="cfgIgUserId" value="' + esc(igUserIdRow ? igUserIdRow.value : '') + '" placeholder="e.g. 17841400000000"><div style="font-size:.72rem;color:#6B5B4B;margin-top:2px">IG must be a Business account linked to your FB Page</div></div>';
  html += '</div>';
  html += '<div class="field"><label>Meta Page Access Token <span style="font-size:.72rem;color:#6B5B4B">(works for both Facebook &amp; Instagram)</span></label><input type="password" id="cfgFbToken" value="' + esc(fbTokenRow ? fbTokenRow.value : '') + '" placeholder="Long-lived page access token from Meta Graph API Explorer" style="font-family:monospace;font-size:.82rem"></div>';
  html += '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">';
  html += '<button class="btn btn-sm btn-primary" id="saveSocialConfig">Save Credentials</button>';
  html += '<button class="btn btn-sm btn-outline" id="testSocialConfig">Test Connection</button>';
  html += '<span id="socialConfigStatus" style="font-size:.82rem"></span>';
  html += '</div>';
  html += '<div style="margin-top:12px;padding:10px;background:#F5EDE0;border-radius:6px;font-size:.78rem;color:#6B5B4B">';
  html += '<strong>How to get these:</strong><br>';
  html += '1. Go to <a href="https://developers.facebook.com" target="_blank" style="color:#A0522D">developers.facebook.com</a> &rarr; Create App (Business type)<br>';
  html += '2. Add "Facebook Login for Business" product<br>';
  html += '3. In <a href="https://developers.facebook.com/tools/explorer/" target="_blank" style="color:#A0522D">Graph API Explorer</a>: select your Page, request permissions: <code>pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish</code><br>';
  html += '4. Generate token &rarr; click "Get Long-Lived Token" &rarr; copy the Page Access Token<br>';
  html += '5. Your Page ID is in your Facebook Page URL or Page settings<br>';
  html += '6. For Instagram: account must be Business type, linked to the Facebook Page. Get IG User ID from Graph API: <code>/me/accounts?fields=instagram_business_account</code>';
  html += '</div></div></div>';

  // Post composer
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">';

  // Content templates
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:20px;border-radius:12px;border:1px solid rgba(212,197,169,.3)">';
  html += '<h3 style="margin:0 0 12px;font-size:1rem;color:#A0522D">Quick Templates</h3>';
  html += '<div style="display:flex;flex-direction:column;gap:6px">';
  html += '<button class="btn btn-outline btn-sm" data-template="breed_education" style="text-align:left">&#128218; Breed Education</button>';
  html += '<button class="btn btn-outline btn-sm" data-template="new_litter" style="text-align:left">&#128049; New Litter Announcement</button>';
  html += '<button class="btn btn-outline btn-sm" data-template="kitten_update" style="text-align:left">&#128248; Kitten Growth Update</button>';
  html += '<button class="btn btn-outline btn-sm" data-template="alumni_story" style="text-align:left">&#128150; Alumni / Happy Home Story</button>';
  html += '<button class="btn btn-outline btn-sm" data-template="event" style="text-align:left">&#128197; Upcoming Event</button>';
  html += '<button class="btn btn-outline btn-sm" data-template="tip" style="text-align:left">&#128161; Cat Care Tip</button>';
  html += '</div></div>';

  // Composer
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:20px;border-radius:12px;border:1px solid rgba(212,197,169,.3)">';
  html += '<h3 style="margin:0 0 12px;font-size:1rem;color:#A0522D">Compose Post</h3>';
  html += '<textarea id="socialMessage" rows="6" placeholder="Write your post here... Use a template or write from scratch." style="width:100%;padding:10px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.88rem;resize:vertical"></textarea>';
  html += '<div style="margin-top:8px"><label style="font-size:.82rem;font-weight:600;color:#3E3229;display:block;margin-bottom:4px">Photo URL (optional for FB, required for IG)</label>';
  html += '<input type="text" id="socialPhoto" placeholder="https://portal.blueskycattery.com/photos/..." style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem"></div>';
  html += '<div style="font-size:.75rem;color:#6B5B4B;margin-top:4px">Tip: Copy a photo URL from the Cats or Kittens page, or use any public image URL.</div>';
  html += '<div style="display:flex;gap:8px;margin-top:12px">';
  html += '<button class="btn btn-primary btn-sm" id="postFacebook" style="flex:1">&#9432; Post to Facebook</button>';
  html += '<button class="btn btn-sm" id="postInstagram" style="flex:1;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);color:#fff;border:none">&#9741; Post to Instagram</button>';
  html += '<button class="btn btn-sm" id="postBoth" style="flex:1;background:#3E3229;color:#fff;border:none">Post to Both</button>';
  html += '</div>';
  html += '<div id="socialStatus" style="margin-top:8px;font-size:.82rem;display:none"></div>';
  html += '</div></div>';

  // Hashtag suggestions
  html += '<div style="margin-bottom:20px;padding:12px 16px;background:#FDF9F3;border-radius:8px;border:1px solid #D4C5A9">';
  html += '<strong style="font-size:.82rem;color:#A0522D">Suggested Hashtags</strong> <span style="font-size:.75rem;color:#6B5B4B">(click to add)</span><br>';
  const hashtags = ['#OrientalShorthair','#OSH','#CatBreeder','#BlueSkyKittens','#MissouriCattery','#CFARegistered','#KittensOfInstagram','#CatLife','#OrientalCat','#SerengentiCat','#CatBreederLife','#NewKittens','#KittenUpdate','#CatLovers','#BlueSkyAlumni'];
  hashtags.forEach(h => {
    html += '<span data-hashtag="' + h + '" style="display:inline-block;padding:2px 8px;margin:3px 2px;border-radius:12px;font-size:.75rem;background:#F5EDE0;color:#6B5B4B;cursor:pointer;border:1px solid #D4C5A9">' + h + '</span>';
  });
  html += '</div>';

  // Post history
  const { posts } = await api('/admin/social/history');
  html += '<h3 style="margin:0 0 8px;font-size:1rem;color:#6B5B4B">Recent Posts</h3>';
  if (posts && posts.length > 0) {
    html += '<table><thead><tr><th>Platform</th><th>Content</th><th>When</th></tr></thead><tbody>';
    posts.forEach(p => {
      const platform = (p.note || '').includes('Facebook') ? 'Facebook' : 'Instagram';
      const pColor = platform === 'Facebook' ? '#4267B2' : '#E4405F';
      let details = '';
      try { details = JSON.parse(p.details || '{}').message || JSON.parse(p.details || '{}').caption || ''; } catch(e) {}
      html += '<tr><td><span style="color:' + pColor + ';font-weight:700;font-size:.82rem">' + platform + '</span></td>';
      html += '<td style="font-size:.82rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(details) + '</td>';
      html += '<td>' + timeAgo(p.created_at) + '</td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p style="color:#6B5B4B;font-size:.85rem;padding:12px;text-align:center">No posts yet. Compose your first one above!</p>';
  }

  // Setup guide
  html += '<div style="margin-top:24px;padding:16px;background:#F5EDE0;border-radius:8px;font-size:.82rem;color:#6B5B4B">';
  html += '<strong style="color:#A0522D">Setup Guide</strong> (one-time)<br>';
  html += '1. Go to <strong>developers.facebook.com</strong> &rarr; Create App &rarr; Business type<br>';
  html += '2. Add "Facebook Login for Business" and "Pages API" products<br>';
  html += '3. In Graph API Explorer: select your Page, request <code>pages_manage_posts</code>, <code>pages_read_engagement</code>, <code>instagram_basic</code>, <code>instagram_content_publish</code><br>';
  html += '4. Generate a long-lived Page Access Token<br>';
  html += '5. In <strong>Settings</strong> tab here, add: <code>fb_page_id</code>, <code>fb_page_token</code>, <code>ig_user_id</code><br>';
  html += '6. For Instagram: your IG account must be a Business account linked to the Facebook Page</div>';

  panel.innerHTML = html;
  container.appendChild(panel);

  // Template click handlers
  const templates = {
    breed_education: 'Did you know? Oriental Shorthairs are one of the most vocal and intelligent cat breeds in the world! With over 300 color combinations and personalities as big as their ears, they are truly one-of-a-kind companions.\\n\\nThey bond deeply with their families, follow you room to room, and will absolutely tell you about their day. If you want a cat that acts more like a dog (but with way more attitude), the Oriental Shorthair is your match.\\n\\n#OrientalShorthair #CatBreeder #BlueSkyKittens #CFARegistered',
    new_litter: 'We are thrilled to announce a new litter has arrived at Blue Sky Cattery! Our beautiful kittens are growing fast and will be ready for their forever homes soon.\\n\\nInterested in adding an Oriental Shorthair to your family? Visit blueskycattery.com to learn more and join our waitlist.\\n\\n#NewKittens #OrientalShorthair #BlueSkyKittens #MissouriCattery #KittensOfInstagram',
    kitten_update: 'Kitten update from Blue Sky Cattery! Our babies are getting bigger every day and their personalities are really starting to shine. Some are little adventurers, some are champion cuddlers, and a couple are already practicing their opinions (loudly).\\n\\nStay tuned for individual updates as they grow!\\n\\n#KittenUpdate #OrientalShorthair #BlueSkyKittens #CatLife',
    alumni_story: 'Happy home update from one of our Blue Sky alumni! There is nothing better than hearing from our kitten families and seeing how well they are doing in their forever homes.\\n\\nThis is why we do what we do. Every kitten deserves a family that loves them as much as we do.\\n\\n#BlueSkyAlumni #OrientalShorthair #HappyHome #CatLovers',
    event: 'Mark your calendars! Blue Sky Cattery will be at [EVENT NAME] on [DATE]. Come say hello, meet some beautiful Oriental Shorthairs, and learn about this amazing breed.\\n\\nWe love meeting fellow cat enthusiasts!\\n\\n#CatShow #OrientalShorthair #BlueSkyKittens #CFARegistered',
    tip: 'Cat Care Tip from Blue Sky Cattery:\\n\\nOriental Shorthairs are social cats that do best with a companion. If you work long hours, consider adopting a pair or adding to your existing fur family. A bored Oriental can get creative and that usually means something you own is getting redecorated.\\n\\nHappy cats = happy homes!\\n\\n#CatCareTips #OrientalShorthair #CatLife #BlueSkyKittens'
  };

  panel.querySelectorAll('[data-template]').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('socialMessage').value = templates[btn.getAttribute('data-template')] || '';
      document.getElementById('socialMessage').focus();
    };
  });

  // Hashtag click handlers
  panel.querySelectorAll('[data-hashtag]').forEach(tag => {
    tag.onclick = () => {
      const msg = document.getElementById('socialMessage');
      msg.value = (msg.value + ' ' + tag.getAttribute('data-hashtag')).trim();
    };
  });

  // Post handlers
  async function postToFacebook() {
    const message = document.getElementById('socialMessage').value.trim();
    const photo_url = document.getElementById('socialPhoto').value.trim();
    if (!message) { alert('Write a message first!'); return; }
    const status = document.getElementById('socialStatus');
    status.style.display = 'block'; status.style.color = '#6B5B4B'; status.textContent = 'Posting to Facebook...';
    const res = await api('/admin/social/facebook', { method: 'POST', body: JSON.stringify({ message, photo_url: photo_url || undefined }) });
    if (res.success) { status.style.color = '#7A8B6F'; status.textContent = 'Posted to Facebook!'; }
    else { status.style.color = '#8B3A3A'; status.textContent = 'Facebook error: ' + (res.error || 'Unknown'); }
    return res.success;
  }

  async function postToInstagram() {
    const caption = document.getElementById('socialMessage').value.trim();
    const photo_url = document.getElementById('socialPhoto').value.trim();
    if (!caption) { alert('Write a caption first!'); return; }
    if (!photo_url) { alert('Instagram requires a photo URL.'); return; }
    const status = document.getElementById('socialStatus');
    status.style.display = 'block'; status.style.color = '#6B5B4B'; status.textContent = 'Posting to Instagram...';
    const res = await api('/admin/social/instagram', { method: 'POST', body: JSON.stringify({ caption, photo_url }) });
    if (res.success) { status.style.color = '#7A8B6F'; status.textContent = 'Posted to Instagram!'; }
    else { status.style.color = '#8B3A3A'; status.textContent = 'Instagram error: ' + (res.error || 'Unknown'); }
    return res.success;
  }

  // Save social config
  document.getElementById('saveSocialConfig').onclick = async () => {
    const settings = {
      fb_page_id: document.getElementById('cfgFbPageId').value.trim(),
      fb_page_token: document.getElementById('cfgFbToken').value.trim(),
      ig_user_id: document.getElementById('cfgIgUserId').value.trim()
    };
    const btn = document.getElementById('saveSocialConfig');
    btn.disabled = true; btn.textContent = 'Saving...';
    await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    document.getElementById('socialConfigStatus').innerHTML = '<span style="color:#7A8B6F">&#10003; Saved!</span>';
    btn.disabled = false; btn.textContent = 'Save Credentials';
  };

  // Test connection
  document.getElementById('testSocialConfig').onclick = async () => {
    const token = document.getElementById('cfgFbToken').value.trim();
    const pageId = document.getElementById('cfgFbPageId').value.trim();
    const status = document.getElementById('socialConfigStatus');
    if (!token || !pageId) { status.innerHTML = '<span style="color:#8B3A3A">Enter Page ID and Token first</span>'; return; }
    status.innerHTML = '<span style="color:#6B5B4B">Testing...</span>';
    try {
      const res = await fetch('https://graph.facebook.com/v19.0/' + pageId + '?fields=name,fan_count&access_token=' + token);
      const data = await res.json();
      if (data.error) { status.innerHTML = '<span style="color:#8B3A3A">&#10005; ' + data.error.message + '</span>'; }
      else { status.innerHTML = '<span style="color:#7A8B6F">&#10003; Connected to: ' + (data.name || pageId) + '</span>'; }
    } catch(e) { status.innerHTML = '<span style="color:#8B3A3A">&#10005; Connection failed</span>'; }
  };

  document.getElementById('postFacebook').onclick = postToFacebook;
  document.getElementById('postInstagram').onclick = postToInstagram;
  document.getElementById('postBoth').onclick = async () => {
    const status = document.getElementById('socialStatus');
    status.style.display = 'block'; status.style.color = '#6B5B4B'; status.textContent = 'Posting to both platforms...';
    const fbOk = await postToFacebook();
    if (fbOk) {
      status.textContent = 'Facebook done. Posting to Instagram...';
      await postToInstagram();
      status.textContent = 'Posted to both platforms!'; status.style.color = '#7A8B6F';
    }
  };
}

async function renderSettings(container) {
  const { settings } = await api('/admin/settings');
  const panel = el('div', { class: 'panel active' });

  let html = '<h2 style="margin:20px 0 12px">Site Settings</h2>';
  html += '<div class="config-form" id="settingsForm">';

  const settingsList = settings || [];
  if (settingsList.length === 0) {
    // Show default config keys with empty values for initial setup
    const defaults = ['site_name', 'admin_email', 'notification_email', 'brevo_list_leads', 'brevo_list_approved', 'deposit_amount', 'kitten_price', 'go_home_weeks', 'application_open', 'welcome_message'];
    defaults.forEach(key => {
      html += '<div class="field"><label>' + esc(key) + '</label><input type="text" data-key="' + esc(key) + '" value=""></div>';
    });
  } else {
    settingsList.forEach(s => {
      html += '<div class="field"><label>' + esc(s.key) + '</label><input type="text" data-key="' + esc(s.key) + '" value="' + esc(s.value || '') + '"></div>';
    });
  }

  html += '</div>';
  html += '<div style="margin-top:12px;display:flex;gap:12px;align-items:center">';
  html += '<div style="display:flex;gap:8px;align-items:center"><input type="text" id="newSettingKey" placeholder="New key" style="padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.88rem;width:160px"><input type="text" id="newSettingVal" placeholder="Value" style="padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.88rem;width:200px"><button class="btn btn-outline btn-sm" id="addSettingBtn">Add</button></div>';
  html += '<div style="flex:1"></div>';
  html += '<button class="btn btn-primary" id="saveSettingsBtn">Save All Settings</button>';
  html += '</div>';

  panel.innerHTML = html;
  container.appendChild(panel);

  document.getElementById('addSettingBtn').onclick = () => {
    const key = document.getElementById('newSettingKey').value.trim();
    const val = document.getElementById('newSettingVal').value;
    if (!key) return;
    const form = document.getElementById('settingsForm');
    form.innerHTML += '<div class="field"><label>' + esc(key) + '</label><input type="text" data-key="' + esc(key) + '" value="' + esc(val) + '"></div>';
    document.getElementById('newSettingKey').value = '';
    document.getElementById('newSettingVal').value = '';
  };

  document.getElementById('saveSettingsBtn').onclick = async () => {
    const inputs = document.querySelectorAll('#settingsForm input[data-key]');
    const settings = {};
    inputs.forEach(inp => { settings[inp.getAttribute('data-key')] = inp.value; });
    const res = await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    if (res.success) alert('Settings saved.');
    else alert(res.error || 'Failed to save.');
  };
}

// ---- Emails ----

async function renderEmails(container) {
  const { schedules } = await api('/admin/email-schedules');
  const panel = el('div', { class: 'panel active' });

  let html = '<h2 style="margin:20px 0 12px">Email Schedules</h2>';

  if (!schedules || schedules.length === 0) {
    html += '<p style="color:#6B5B4B;padding:20px;text-align:center">No email schedules configured. Add templates via the database.</p>';
  } else {
    html += '<table><thead><tr><th>Template</th><th>Subject</th><th>Trigger</th><th>Days After</th><th>Active</th><th>Actions</th></tr></thead><tbody>';
    schedules.forEach(s => {
      html += '<tr>';
      html += '<td><strong>' + esc(s.template_name) + '</strong></td>';
      html += '<td>' + esc(s.subject || '---') + '</td>';
      html += '<td>' + esc(s.trigger_event || '---') + '</td>';
      html += '<td><input type="number" data-sched-days="' + s.id + '" value="' + (s.days_after || 0) + '" style="width:60px;padding:4px 8px;border:1px solid #D4C5A9;border-radius:4px;font-size:.85rem"></td>';
      html += '<td><label class="toggle"><input type="checkbox" data-sched-active="' + s.id + '"' + (s.active ? ' checked' : '') + '><span class="slider"></span></label></td>';
      html += '<td><button class="btn btn-outline btn-sm" data-sched-save="' + s.id + '">Save</button> <button class="btn btn-info btn-sm" data-sched-test="' + s.id + '">Send Test</button></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
  }

  panel.innerHTML = html;
  container.appendChild(panel);

  // Attach handlers
  panel.querySelectorAll('[data-sched-save]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-sched-save');
      const daysInput = panel.querySelector('[data-sched-days="' + id + '"]');
      const activeInput = panel.querySelector('[data-sched-active="' + id + '"]');
      await api('/admin/email-schedules/' + id, { method: 'PUT', body: JSON.stringify({
        days_after: parseInt(daysInput.value) || 0,
        active: activeInput.checked
      })});
      alert('Schedule updated.');
    };
  });

  panel.querySelectorAll('[data-sched-test]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-sched-test');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      const res = await api('/admin/email-schedules/test/' + id, { method: 'POST' });
      alert(res.message || (res.success ? 'Sent!' : 'Failed'));
      btn.disabled = false;
      btn.textContent = 'Send Test';
    };
  });
}

// ---- Users ----

let userSearch = '';

async function renderUsers(container) {
  const params = new URLSearchParams();
  if (userSearch) params.set('search', userSearch);
  const { users } = await api('/admin/users?' + params.toString());
  const panel = el('div', { class: 'panel active' });

  // Search bar
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 16px;flex-wrap:wrap;gap:12px">';
  html += '<h2 style="margin:0">User Management</h2>';
  html += '<div style="display:flex;gap:8px;align-items:center">';
  html += '<input type="text" id="userSearchInput" placeholder="Search name, email, phone..." value="' + esc(userSearch) + '" style="padding:8px 14px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem;width:260px">';
  html += '<button class="btn btn-sm btn-outline" id="userSearchBtn">Search</button>';
  html += '</div></div>';

  html += '<div style="font-size:.82rem;color:#6B5B4B;margin-bottom:8px">' + (users||[]).length + ' user(s)' + (userSearch ? ' matching "' + esc(userSearch) + '"' : '') + '</div>';

  html += '<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Trust</th><th>Role</th><th>Status</th><th>Notes</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
  (users || []).forEach(u => {
    // Quick trust indicator from verification JSON
    let trustBadge = '<span style="padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;background:#87A5B4;color:#fff">Limited</span>';
    try {
      const v = u.verification ? JSON.parse(u.verification) : {};
      const vals = Object.values(v).filter(x => x && x !== 'not_checked');
      if (vals.length > 0) {
        const passes = vals.filter(x => x === 'pass').length;
        const fails = vals.filter(x => x === 'fail').length;
        if (fails > 0) trustBadge = '<span style="padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;background:#8B3A3A;color:#fff">&#9888; Flags</span>';
        else if (passes === vals.length && vals.length >= 4) trustBadge = '<span style="padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;background:#7A8B6F;color:#fff">Trusted</span>';
        else trustBadge = '<span style="padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700;background:#D4AF37;color:#3E3229">' + passes + '/' + vals.length + '</span>';
      }
    } catch(e) {}
    html += '<tr>';
    html += '<td><strong>' + esc(u.lead_name || '---') + '</strong></td>';
    html += '<td>' + esc(u.email) + '</td>';
    html += '<td>' + esc(u.lead_phone || '---') + '</td>';
    html += '<td>' + trustBadge + '</td>';
    html += '<td><span style="padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;background:' + (u.role === 'admin' ? '#A0522D' : '#87A5B4') + ';color:#fff;text-transform:uppercase">' + esc(u.role) + '</span></td>';
    html += '<td>' + badge(u.status) + '</td>';
    html += '<td style="max-width:200px;font-size:.78rem;color:#6B5B4B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(u.admin_notes || '') + '">' + esc(u.admin_notes ? (u.admin_notes.length > 40 ? u.admin_notes.slice(0,40) + '...' : u.admin_notes) : '---') + '</td>';
    html += '<td>' + timeAgo(u.created_at) + '</td>';
    html += '<td style="white-space:nowrap">';
    html += '<button class="btn btn-outline btn-sm" data-user-edit="' + u.id + '">Edit</button> ';
    html += '<button class="btn btn-danger btn-sm" data-user-reset="' + u.id + '">Reset PW</button>';
    html += '</td></tr>';
  });
  html += '</tbody></table>';
  if (!users || users.length === 0) html += '<p style="color:#6B5B4B;padding:20px;text-align:center">No users match your search.</p>';

  panel.innerHTML = html;
  container.appendChild(panel);

  // Search handlers
  document.getElementById('userSearchBtn').onclick = () => {
    userSearch = document.getElementById('userSearchInput').value;
    container.innerHTML = '';
    renderUsers(container);
  };
  document.getElementById('userSearchInput').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('userSearchBtn').click(); };

  // Edit handlers
  panel.querySelectorAll('[data-user-edit]').forEach(btn => {
    const userId = btn.getAttribute('data-user-edit');
    const user = (users || []).find(u => u.id == userId);
    btn.onclick = () => showUserEditModal(user);
  });

  // Reset password handlers
  panel.querySelectorAll('[data-user-reset]').forEach(btn => {
    btn.onclick = async () => {
      const userId = btn.getAttribute('data-user-reset');
      const user = (users || []).find(u => u.id == userId);
      if (!confirm('Reset password for ' + (user ? user.email : 'this user') + '? A new password will be emailed to them.')) return;
      btn.disabled = true;
      btn.textContent = 'Resetting...';
      const res = await api('/admin/users/' + userId + '/reset-password', { method: 'POST' });
      if (res.success) {
        alert('Password reset. New password: ' + res.tempPassword + '\\n\\nEmail sent to: ' + (user ? user.email : ''));
      } else {
        alert(res.error || 'Failed');
      }
      btn.disabled = false;
      btn.textContent = 'Reset PW';
    };
  });
}

async function showUserEditModal(user) {
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });

  // Fetch trust rating and activity log
  const trust = await api('/admin/users/' + user.id + '/trust');
  const activityData = await api('/admin/users/' + user.id + '/activity');

  // Overall rating badge
  const ratingColors = { trusted: '#7A8B6F', moderate: '#D4AF37', caution: '#A0522D', high_risk: '#8B3A3A', limited: '#87A5B4' };
  const ratingLabels = { trusted: 'Trusted', moderate: 'Moderate', caution: 'Caution', high_risk: 'High Risk', limited: 'Limited (App Only)' };
  const rc = ratingColors[trust.overall.rating] || '#6B5B4B';
  const rl = ratingLabels[trust.overall.rating] || trust.overall.rating;

  let html = '<h2>Edit User</h2>';

  // Contact info header
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
  html += '<div class="field"><label>Name</label><div class="value" style="font-weight:700">' + esc(user.lead_name || '---') + '</div></div>';
  html += '<div class="field"><label>Email</label><div class="value">' + esc(user.email) + '</div></div>';
  html += '<div class="field"><label>Phone</label><div class="value">' + esc(user.lead_phone || '---') + '</div></div>';
  html += '<div class="field"><label>Created</label><div class="value">' + esc(user.created_at || '') + '</div></div>';
  html += '</div>';
  if (user.lead_id) html += '<div style="font-size:.78rem;color:#6B5B4B;margin-bottom:12px">Lead ID: ' + user.lead_id + ' &mdash; <a href="#" style="color:#A0522D" onclick="this.closest(&#39;.modal-bg&#39;).remove();showLeadModal(' + user.lead_id + ');return false">View Lead</a></div>';

  // ---- OVERALL TRUST RATING BAR ----
  html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:16px;border-radius:10px;border:1px solid rgba(212,197,169,.3);margin-bottom:16px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong style="font-size:.9rem">Trust Rating</strong>';
  html += '<span style="background:' + rc + ';color:#fff;padding:4px 14px;border-radius:20px;font-size:.78rem;font-weight:700">' + rl + (trust.overall.score !== null ? ' (' + trust.overall.score + ')' : '') + '</span></div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:.78rem">';
  html += '<div style="text-align:center"><div style="color:#6B5B4B">App Score</div><strong style="font-size:1.1rem">' + (trust.overall.appScore !== null ? trust.overall.appScore : '---') + '</strong></div>';
  html += '<div style="text-align:center"><div style="color:#6B5B4B">Verification</div><strong style="font-size:1.1rem;color:' + (trust.verification.score !== null ? (trust.verification.score >= 70 ? '#7A8B6F' : trust.verification.score >= 40 ? '#D4AF37' : '#8B3A3A') : '#87A5B4') + '">' + (trust.verification.score !== null ? trust.verification.score + '%' : 'Not started') + '</strong></div>';
  html += '<div style="text-align:center"><div style="color:#6B5B4B">Identity Risk</div><strong style="font-size:1.1rem;color:' + (trust.identity.risk === 0 ? '#7A8B6F' : trust.identity.risk <= 30 ? '#D4AF37' : '#8B3A3A') + '">' + (trust.identity.risk === 0 ? 'Clean' : trust.identity.risk + '%') + '</strong></div>';
  html += '</div></div>';

  // ---- IDENTITY RISK SECTION ----
  if (trust.identity.duplicates.length > 0 || trust.identity.inconsistencies.length > 0) {
    html += '<div style="background:rgba(139,58,58,.05);border:1px solid rgba(139,58,58,.15);padding:12px;border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#8B3A3A;font-size:.82rem;text-transform:uppercase;letter-spacing:.5px">Identity Flags</strong>';
    if (trust.identity.duplicates.length > 0) {
      html += '<div style="margin-top:8px">';
      trust.identity.duplicates.forEach(d => {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:.82rem;padding:4px 0;color:#3E3229">';
        html += '<span>&#9888; <strong>' + esc(d.type) + ':</strong> ' + esc(d.name) + ' (' + esc(d.email) + ')' + (d.has_account ? ' <span style="color:#8B3A3A;font-weight:700">HAS ACCOUNT</span>' : '') + '</span>';
        if (d.has_account && d.user_id) {
          html += '<button class="btn btn-sm btn-danger" data-merge-secondary="' + d.user_id + '" style="font-size:.7rem;padding:2px 8px">Merge Into This User</button>';
        }
        html += '</div>';
      });
      html += '</div>';
    }
    if (trust.identity.inconsistencies.length > 0) {
      trust.identity.inconsistencies.forEach(i => {
        html += '<div style="font-size:.82rem;padding:4px 0;color:#8B3A3A">&#9888; ' + esc(i) + '</div>';
      });
    }
    html += '</div>';
  }

  // ---- VERIFICATION CHECKLIST ----
  // Get full verification data with details
  let verifyDetails = {};
  try { const ud = await api('/admin/users/' + user.id + '/trust'); verifyDetails = ud.verification || {}; } catch(e) {}
  let fullVerification = {};
  try { const uRow = await api('/admin/users/' + user.id + '/trust'); fullVerification = {}; } catch(e) {}
  // Get raw verification JSON for detail notes
  const rawVerify = trust.verification || {};

  html += '<div style="margin-bottom:12px"><strong style="font-size:.88rem">Verification Checklist</strong> <span style="font-size:.75rem;color:#6B5B4B">(' + trust.verification.checkedCount + '/' + trust.verification.items.length + ' checked)</span></div>';
  trust.verification.items.forEach(item => {
    const val = item.value;
    const selectId = 'verify_' + item.key;
    const detailId = 'verifyDetail_' + item.key;
    const borderColor = val === 'fail' ? 'rgba(139,58,58,.3)' : val === 'concern' ? 'rgba(212,175,55,.3)' : val === 'pass' ? 'rgba(122,139,111,.3)' : '#e8e2d8';
    html += '<div style="margin-bottom:8px;padding:8px 10px;background:#FDF9F3;border-radius:6px;border:1px solid ' + borderColor + '">';
    html += '<div style="display:flex;align-items:center;gap:8px">';
    html += '<select id="' + selectId + '" style="padding:4px 8px;border:1px solid #D4C5A9;border-radius:4px;font-size:.78rem;width:120px">';
    html += '<option value="not_checked"' + (val === 'not_checked' ? ' selected' : '') + '>Not checked</option>';
    html += '<option value="pass"' + (val === 'pass' ? ' selected' : '') + '>&#10003; Pass</option>';
    html += '<option value="concern"' + (val === 'concern' ? ' selected' : '') + '>&#9888; Concern</option>';
    html += '<option value="fail"' + (val === 'fail' ? ' selected' : '') + '>&#10005; Fail</option>';
    html += '</select>';
    html += '<span style="font-size:.85rem;flex:1">' + esc(item.label) + '</span>';
    html += '<span style="font-size:.72rem;color:#6B5B4B">(' + item.weight + ' pts)</span>';
    html += '</div>';
    // Detail field - for recording specifics
    const detailVal = item.detail || '';
    html += '<input type="text" id="' + detailId + '" value="' + esc(detailVal) + '" placeholder="Details: vet name, phone, what was said..." style="width:100%;padding:4px 8px;border:1px solid #e8e2d8;border-radius:4px;font-size:.78rem;margin-top:6px;color:#3E3229">';
    html += '</div>';
  });
  html += '<button class="btn btn-sm btn-info" id="saveVerifyBtn" style="margin-top:6px">Save Verification</button>';

  // Role/Status
  html += '<div class="form-grid" style="margin-top:16px">';
  html += '<div class="field"><label>Role</label><select id="euRole"><option value="applicant"' + (user.role === 'applicant' ? ' selected' : '') + '>Applicant</option><option value="admin"' + (user.role === 'admin' ? ' selected' : '') + '>Admin</option></select></div>';
  html += '<div class="field"><label>Status</label><select id="euStatus"><option value="active"' + (user.status === 'active' ? ' selected' : '') + '>Active</option><option value="suspended"' + (user.status === 'suspended' ? ' selected' : '') + '>Suspended</option><option value="inactive"' + (user.status === 'inactive' ? ' selected' : '') + '>Inactive</option></select></div>';
  html += '</div>';

  // Notes
  html += '<div class="field" style="margin-top:12px"><label>Admin Notes</label><textarea id="euNotes" rows="4" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.88rem" placeholder="Call notes, observations, follow-up reminders...">' + esc(user.admin_notes || '') + '</textarea></div>';

  // ---- ACTIVITY TIMELINE ----
  html += '<div style="margin-top:16px;border-top:1px solid #D4C5A9;padding-top:16px">';
  html += '<strong style="font-size:.9rem">Activity Timeline</strong>';
  // Quick-add bar
  html += '<div style="display:flex;gap:8px;margin-top:10px;margin-bottom:12px">';
  html += '<div style="display:flex;gap:8px;align-items:center">';
  html += '<select id="activityType" style="padding:6px 10px;border:1px solid #D4C5A9;border-radius:6px;font-size:.84rem">';
  html += '<option value="call">&#9742; Call</option>';
  html += '<option value="email">&#9993; Email</option>';
  html += '<option value="note">&#9998; Note</option>';
  html += '<option value="vet_check">&#9877; Vet Check</option>';
  html += '<option value="video_visit">&#9654; Video Visit</option>';
  html += '</select>';
  html += '<button class="btn btn-sm btn-primary" id="addActivityBtn" style="white-space:nowrap">+ Add</button>';
  html += '</div>';
  html += '<textarea id="activityNote" rows="2" placeholder="What happened? e.g. Called, spoke 10 min about kitten care, discussed indoor setup..." style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.85rem;background:#fff;margin-top:6px;resize:vertical"></textarea>';
  html += '</div>';
  // Timeline entries
  html += '<div id="activityTimeline" style="max-height:300px;overflow-y:auto">';
  const typeIcons = { call: '&#9742;', email: '&#9993;', note: '&#9998;', vet_check: '&#9877;', video_visit: '&#9654;', verification: '&#10003;', system: '&#9881;' };
  const typeColors = { call: '#4A90D9', email: '#D4AF37', note: '#7A8B6F', vet_check: '#A0522D', video_visit: '#6B5B4B', verification: '#7A8B6F', system: '#87A5B4' };
  const typeLabels = { call: 'Call', email: 'Email', note: 'Note', vet_check: 'Vet Check', video_visit: 'Video Visit', verification: 'Verification', system: 'System' };
  (activityData.entries || []).forEach(entry => {
    const icon = typeIcons[entry.type] || '&#9679;';
    const color = typeColors[entry.type] || '#6B5B4B';
    const label = typeLabels[entry.type] || entry.type;
    html += '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f0ebe3">';
    html += '<div style="min-width:32px;height:32px;background:' + color + ';color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem">' + icon + '</div>';
    html += '<div style="flex:1">';
    html += '<div style="font-size:.84rem;font-weight:600;color:' + color + '">' + esc(label) + '</div>';
    html += '<div style="font-size:.84rem;color:#3E3229;margin-top:2px">' + esc(entry.note || '') + '</div>';
    html += '<div style="font-size:.72rem;color:#6B5B4B;margin-top:4px">' + timeAgo(entry.created_at) + (entry.created_by_email ? ' &mdash; ' + esc(entry.created_by_email) : '') + '</div>';
    html += '</div></div>';
  });
  if (!activityData.entries || activityData.entries.length === 0) {
    html += '<div style="font-size:.82rem;color:#6B5B4B;padding:12px 0;text-align:center">No activity logged yet</div>';
  }
  html += '</div></div>';

  // ---- COMMUNICATION HISTORY ----
  if (user.lead_id) {
    const msgData = await api('/admin/leads/' + user.lead_id);
    const messages = msgData.messages || [];
    if (messages.length > 0) {
      html += '<div style="margin-top:16px;border-top:1px solid #D4C5A9;padding-top:16px">';
      html += '<strong style="font-size:.9rem">Message History</strong> <span style="font-size:.75rem;color:#6B5B4B">(' + messages.length + ')</span>';
      html += '<div style="max-height:200px;overflow-y:auto;margin-top:10px">';
      messages.forEach(msg => {
        const isOut = msg.direction === 'outbound';
        const bgColor = isOut ? 'rgba(122,139,111,.08)' : '#F5EDE0';
        const dirLabel = isOut ? '<span style="color:#7A8B6F;font-weight:700;font-size:.72rem">SENT</span>' : '<span style="color:#87A5B4;font-weight:700;font-size:.72rem">RECEIVED</span>';
        html += '<div style="background:' + bgColor + ';padding:8px 10px;border-radius:6px;margin-bottom:6px;font-size:.82rem">';
        html += '<div style="display:flex;justify-content:space-between">' + dirLabel + ' <span style="font-size:.72rem;color:#6B5B4B">' + timeAgo(msg.created_at) + '</span></div>';
        if (msg.subject) html += '<div style="font-weight:600;margin-top:2px">' + esc(msg.subject) + '</div>';
        html += '<div style="margin-top:2px;color:#3E3229;white-space:pre-wrap;max-height:60px;overflow:hidden">' + esc((msg.body || '').slice(0, 200)) + '</div>';
        html += '</div>';
      });
      html += '</div>';
      html += '<button class="btn btn-sm btn-outline" style="margin-top:6px" onclick="this.closest(&#39;.modal-bg&#39;).remove();showLeadModal(' + user.lead_id + ')">Open Full Conversation</button>';
      html += '</div>';
    }
  }

  html += '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveUserBtn">Save</button></div>';

  modal.innerHTML = html;
  bg.appendChild(modal);
  document.body.appendChild(bg);

  // Add activity handler
  document.getElementById('addActivityBtn').onclick = async () => {
    const type = document.getElementById('activityType').value;
    const note = document.getElementById('activityNote').value.trim();
    if (!note) { document.getElementById('activityNote').focus(); return; }
    const btn = document.getElementById('addActivityBtn');
    btn.disabled = true; btn.textContent = '...';
    await api('/admin/users/' + user.id + '/activity', { method: 'POST', body: JSON.stringify({ type, note }) });
    bg.remove();
    showUserEditModal(user);
  };

  // Save verification handler
  // Merge button handlers
  bg.querySelectorAll('[data-merge-secondary]').forEach(btn => {
    btn.onclick = async () => {
      const secondaryId = btn.getAttribute('data-merge-secondary');
      if (!confirm('MERGE ACCOUNTS\\n\\nThis will absorb the duplicate account into THIS user (' + user.email + ').\\n\\nAll activity, applications, messages, and notes from the duplicate will be moved here. The duplicate account will be deleted.\\n\\nThis cannot be undone. Continue?')) return;
      btn.disabled = true; btn.textContent = 'Merging...';
      const res = await api('/admin/users/merge', { method: 'POST', body: JSON.stringify({ primary_id: user.id, secondary_id: parseInt(secondaryId) }) });
      if (res.success) {
        alert('Merge complete: ' + res.message + '\\n\\n' + (res.details || []).join(', '));
        bg.remove();
        renderApp();
      } else {
        alert('Merge failed: ' + (res.error || 'Unknown error'));
        btn.disabled = false; btn.textContent = 'Merge Into This User';
      }
    };
  });

  document.getElementById('saveVerifyBtn').onclick = async () => {
    const verification = {};
    trust.verification.items.forEach(item => {
      verification[item.key] = document.getElementById('verify_' + item.key).value;
      const detailEl = document.getElementById('verifyDetail_' + item.key);
      if (detailEl && detailEl.value) verification[item.key + '_detail'] = detailEl.value;
    });
    const btn = document.getElementById('saveVerifyBtn');
    btn.disabled = true; btn.textContent = 'Saving...';
    await api('/admin/users/' + user.id + '/verify', { method: 'PUT', body: JSON.stringify({ verification }) });
    bg.remove();
    showUserEditModal(user);
  };

  document.getElementById('saveUserBtn').onclick = async () => {
    await api('/admin/users/' + user.id, { method: 'PUT', body: JSON.stringify({
      role: document.getElementById('euRole').value,
      status: document.getElementById('euStatus').value,
      admin_notes: document.getElementById('euNotes').value
    })});
    bg.remove();
    renderApp();
  };
}

// ---- Help ----

function renderHelp(container) {
  const panel = el('div', { class: 'panel active' });

  const sections = [
    {
      title: 'To Do / Action Center',
      icon: '&#10003;',
      items: [
        ['What is it?', 'Your home base. Shows everything needing attention: new leads, pending applications, unanswered messages, unassigned photos, verification red flags, pending deposits, and upcoming automated emails.'],
        ['New Leads', 'People who contacted you or submitted a reservation. Click Review to see their details. You can approve them (creates a portal account) or just reply.'],
        ['Pending Applications', 'Applications that have been submitted but not yet reviewed. Click Review to open the full application with AI scoring, risk flags, and your decision tools.'],
        ['Unanswered Messages', 'Inbound messages that you have not replied to yet. Click Reply to open the conversation, or Dismiss to remove it from the list.'],
        ['Unassigned Photos', 'Photos emailed in that could not be matched to a cat or kitten by filename. Use the dropdown to assign them or click Del to remove.'],
        ['Red Flags', 'Users who have failed one or more verification checks (phone disconnected, vet does not exist, etc). Click Review to investigate.'],
      ]
    },
    {
      title: 'Dashboard',
      icon: '&#128202;',
      items: [
        ['What is it?', 'Overview of your cattery stats: total leads, applications, scores, kitten availability, conversion funnel, lead sources, and recent activity.'],
      ]
    },
    {
      title: 'Leads & Contacts',
      icon: '&#128100;',
      items: [
        ['What is it?', 'Everyone who has contacted Blue Sky Cattery through any channel: contact form, reservation form, self-registration, newsletter signup, or waitlist.'],
        ['Search', 'Type any name, email, phone number, or preference (e.g. "blue" or "velcro") to filter the list.'],
        ['Approve a Lead', 'Click Approve to create a portal account for the lead. They will receive a welcome email with login credentials to fill out the full adoption application.'],
        ['View / Reply', 'Click View to see the full lead profile, message history, and send an email directly from the admin portal.'],
        ['Preferences', 'Waitlist signups can indicate their preferred sex, color, eye color, and personality type. These show as tags in the Preferences column.'],
        ['Export', 'Click Export CSV to download all leads as a spreadsheet.'],
      ]
    },
    {
      title: 'Applications',
      icon: '&#128203;',
      items: [
        ['What is it?', 'All adoption applications submitted through the portal. Applications are auto-scored by our AI grading system.'],
        ['AI Scoring', 'Each application is scored 0-100 across categories: home environment, pet experience, breed knowledge, readiness, and more. The AI also flags risks and highlights strengths.'],
        ['Top Candidates', 'Shows the highest-scored applicants per kitten so you can see who is the best match.'],
        ['Review an Application', 'Click Review to see the full application, score breakdown, AI analysis, risk flags, and make your decision (approve, waitlist, or reject).'],
        ['Re-analyze with AI', 'If you want a fresh AI analysis (e.g., after the applicant updated their profile), click Re-analyze in the review modal.'],
      ]
    },
    {
      title: 'Kittens & Litters',
      icon: '&#128049;',
      items: [
        ['What is it?', 'Manage your litters and individual kittens. Track status, pricing, reservations, deposits, and go-home readiness.'],
        ['Add a Litter', 'Click + New Litter. Enter the sire, dam, born date, go-home date, and number of kittens. Kittens are auto-created.'],
        ['Edit a Kitten', 'Click Edit to update name, color, sex, price, status, reserved by, photos, deposit info, and notes.'],
        ['Kitten Status', 'Available, Pending (awaiting deposit), Reserved (deposit received), or Sold.'],
        ['Photos', 'Upload photos directly in the edit modal or email them to kittens@blueskycattery.com with filenames matching the kitten name (e.g., Hannah1.jpg). Photos are auto-optimized for web.'],
        ['Deposit Tracking', 'In the edit modal: enter deposit amount, date received, payment method. Balance auto-calculates from the kitten price.'],
        ['Go-Home Checklist', 'For reserved/sold kittens: 9-item checklist (spay/neuter, vaccinations, microchip, contract, etc). Each checkbox saves immediately.'],
        ['Announce Litter', 'Click Announce Litter to email all interested leads and waitlist subscribers about the new litter.'],
      ]
    },
    {
      title: 'Kings & Queens (Cats)',
      icon: '&#128049;',
      items: [
        ['What is it?', 'Manage your breeding cats. These show on the public website.'],
        ['Add / Edit', 'Name, breed, role (king/queen), color, registration, bio, health tested status, sort order. Photos work the same as kittens.'],
        ['Photos', 'Upload in the edit modal or email to kittens@blueskycattery.com with the cat name as filename (e.g., Samurai1.jpg).'],
      ]
    },
    {
      title: 'Social Media',
      icon: '&#128247;',
      items: [
        ['What is it?', 'Post directly to Facebook and Instagram from the admin portal.'],
        ['Setup', 'Enter your Facebook Page ID, Instagram Business ID, and Meta Page Access Token in Account Settings. One token works for both platforms. See the setup guide on the Social tab for step-by-step instructions.'],
        ['Templates', 'Click a template (Breed Education, New Litter, Kitten Update, Alumni Story, Event, Cat Care Tip) to get a pre-written post you can customize.'],
        ['Hashtags', 'Click any suggested hashtag to add it to your post.'],
        ['Posting', 'Post to Facebook only, Instagram only, or both at once. Instagram requires a photo URL. You can copy photo URLs from the Kittens or Cats edit modals.'],
      ]
    },
    {
      title: 'User Management',
      icon: '&#128101;',
      items: [
        ['What is it?', 'Manage all user accounts (applicants and admins). Search, edit, add notes, track trust ratings.'],
        ['Search', 'Find users by name, email, phone, or notes content. Helps spot duplicate accounts.'],
        ['Trust Rating', 'Each user has a two-part trust rating: Identity Risk (automated duplicate detection) and Verification Score (your manual checklist). Open Edit to see the full breakdown.'],
        ['Verification Checklist', 'Rate each item Pass/Concern/Fail: email deliverable, phone works, vet exists, vet confirms pets, identity consistent, references check. Add detail notes for each (e.g., "Called Dr. Smith at 555-1234, confirmed 2 cats on file").'],
        ['Activity Timeline', 'Log every interaction: calls, emails, vet checks, video visits. Each entry is timestamped automatically.'],
        ['Admin Notes', 'Free-text notes field for quick observations. Searchable and synced to Brevo CRM.'],
        ['Merge Accounts', 'If duplicate accounts are detected, click Merge Into This User in the Identity Flags section. All activity, applications, messages, and notes are moved to the primary account.'],
        ['Message History', 'See all inbound/outbound messages from the user without leaving the edit modal.'],
        ['Reset Password', 'Generates a new password and emails it to the user.'],
      ]
    },
    {
      title: 'Settings',
      icon: '&#9881;',
      items: [
        ['What is it?', 'Site-wide configuration: cattery name, email, pricing, deposit amounts, and more. These values are used across the website and portal.'],
        ['Add a Setting', 'Type a new key and value in the fields at the bottom and click Add. Then Save All Settings.'],
      ]
    },
    {
      title: 'Email Schedules',
      icon: '&#9993;',
      items: [
        ['What is it?', 'Automated email sequences sent to kitten adopters after go-home: welcome home, vet visit reminder, spay/neuter, vaccinations, check-ins, and birthday.'],
        ['Configure', 'Adjust days-after timing, toggle active/inactive, and send test emails to yourself.'],
      ]
    },
    {
      title: 'Email Photos (Automatic)',
      icon: '&#128248;',
      items: [
        ['How it works', 'Email photos to kittens@blueskycattery.com from an admin email address (Deanna or Kevin). Name files after the cat or kitten: Hannah1.jpg, Hannah2.jpg, Samurai_front.jpg, etc.'],
        ['Matching', 'The system strips numbers and underscores from the filename and matches to cat/kitten names. Hannah2.jpg matches kitten "Hannah". Chili_3.png matches cat "Chili".'],
        ['Auto-optimization', 'All photos uploaded through the admin portal are automatically resized and optimized for web (max 1200px, 80% quality). Phone photos go from 5MB to ~300KB.'],
        ['Unmatched photos', 'If a filename does not match any cat or kitten, the photo is saved as "unassigned" and appears on your To Do page. Assign it from there using the dropdown.'],
        ['Confirmation email', 'After processing, you receive a report showing which photos matched and which did not.'],
        ['Admin emails', 'Only emails from recognized admin addresses are processed: stuckeydeanna3@gmail.com, kkomlosy@gmail.com, deanna@blueskycattery.com.'],
        ['Max photos per email', '3-4 photos per email (Brevo has a 20MB limit, phone photos are 3-5MB each).'],
      ]
    },
    {
      title: 'Applicant Portal',
      icon: '&#127968;',
      items: [
        ['What is it?', 'The portal at portal.blueskycattery.com where applicants log in to fill out their adoption application, view litter info, manage their profile, and subscribe to notifications.'],
        ['Self-Registration', 'Users can create their own account from the portal login page or during kitten reservation. Email verification is required before access.'],
        ['Application Wizard', 'Multi-step form that auto-saves drafts and pre-fills from the user profile.'],
        ['User Profile', 'Users can update their contact info (name, phone, address) independently of the application.'],
        ['Subscriptions', 'Users can subscribe to the newsletter and litter waitlist with kitten preferences.'],
      ]
    },
    {
      title: 'Website (Public)',
      icon: '&#127760;',
      items: [
        ['URL', 'blueskycattery.com — auto-deployed from GitHub.'],
        ['Dynamic Content', 'Kings/Queens, kitten availability, pricing, and litter info are pulled live from the database via the portal API.'],
        ['Contact Form', 'Creates a lead for admin review. Does NOT create a user account.'],
        ['Reservation Form', 'Creates a lead AND a user account (with email verification). Redirects to the portal for the full application.'],
        ['Waitlist Signup', 'Collects preferences (sex, color, eye color, personality) and subscribes to litter notifications.'],
        ['My Portal Link', 'All pages have a "My Portal" link in the navigation.'],
      ]
    },
  ];

  let html = '<h2 style="margin:20px 0 4px">Help &amp; Documentation</h2>';
  html += '<p style="color:#6B5B4B;margin-bottom:16px;font-size:.88rem">Search or browse everything the admin portal can do.</p>';

  // Search
  html += '<input type="text" id="helpSearch" placeholder="Search help... (e.g. photos, deposit, merge, vet)" style="width:100%;padding:10px 14px;border:1px solid #D4C5A9;border-radius:6px;font-size:.9rem;margin-bottom:20px">';

  // All sections
  html += '<div id="helpContent">';
  sections.forEach((sec, si) => {
    html += '<div class="help-section" data-section="' + si + '" style="margin-bottom:16px">';
    html += '<div style="background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:14px 18px;border-radius:10px;border:1px solid rgba(212,197,169,.3)">';
    html += '<h3 style="margin:0 0 10px;font-size:1rem;color:#A0522D">' + sec.icon + ' ' + sec.title + '</h3>';
    sec.items.forEach(([q, a]) => {
      html += '<div class="help-item" style="margin-bottom:8px;padding:6px 0;border-bottom:1px solid #f0ebe3">';
      html += '<div style="font-size:.88rem;font-weight:600;color:#3E3229">' + q + '</div>';
      html += '<div style="font-size:.82rem;color:#6B5B4B;margin-top:2px">' + a + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  });
  html += '</div>';

  panel.innerHTML = html;
  container.appendChild(panel);

  // Search handler
  document.getElementById('helpSearch').oninput = () => {
    const q = document.getElementById('helpSearch').value.toLowerCase();
    panel.querySelectorAll('.help-section').forEach(sec => {
      if (!q) { sec.style.display = ''; sec.querySelectorAll('.help-item').forEach(i => i.style.display = ''); return; }
      let sectionMatch = false;
      sec.querySelectorAll('.help-item').forEach(item => {
        const text = item.textContent.toLowerCase();
        if (text.includes(q)) { item.style.display = ''; sectionMatch = true; }
        else { item.style.display = 'none'; }
      });
      sec.style.display = sectionMatch ? '' : 'none';
    });
  };
}

// ---- Audit Log ----

async function renderAudit(container) {
  const { audit } = await api('/admin/audit');
  const panel = el('div', { class: 'panel active' });

  let html = '<h2 style="margin:20px 0 12px">Audit Log</h2>';
  html += '<p style="font-size:.85rem;color:#6B5B4B;margin-bottom:12px">Last 100 actions</p>';

  html += '<table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>';
  (audit || []).forEach(entry => {
    let details = entry.details || '';
    try {
      const parsed = JSON.parse(details);
      details = Object.entries(parsed).map(([k,v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(', ');
    } catch(e) {}
    html += '<tr>';
    html += '<td style="white-space:nowrap">' + timeAgo(entry.created_at) + '<br><span style="font-size:.72rem;color:#6B5B4B">' + esc(entry.created_at || '') + '</span></td>';
    html += '<td>' + esc(entry.user_email || 'System') + '</td>';
    html += '<td><strong>' + esc(entry.action) + '</strong></td>';
    html += '<td style="font-size:.82rem;max-width:300px;overflow:hidden;text-overflow:ellipsis">' + esc(details) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  if (!audit || audit.length === 0) html += '<p style="color:#6B5B4B;padding:20px;text-align:center">No audit entries yet.</p>';

  panel.innerHTML = html;
  container.appendChild(panel);
}

// ---- Init ----
(async () => {
  if (authToken) {
    const me = await api('/auth/me');
    if (me.user) return renderApp();
  }
  renderLogin();
})();
</script>
</body>
</html>`;
