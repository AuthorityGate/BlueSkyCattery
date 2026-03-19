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
    // Set Brevo key from environment secret
    _brevoKey = env.BREVO_API_KEY || null;

    // Ensure sessions table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, user_id INTEGER, role TEXT, expires_at TEXT)').run();
    } catch (e) { /* table exists */ }

    // Ensure audit_log table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, details TEXT, created_at TEXT)').run();
    } catch (e) { /* table exists */ }

    // Ensure config table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run();
    } catch (e) { /* table exists */ }

    // Ensure cats table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS cats (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, breed TEXT, role TEXT, sex TEXT, color TEXT, bio TEXT, photo_url TEXT, registration TEXT, health_tested INTEGER DEFAULT 0, status TEXT DEFAULT \'active\', sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)').run();
    } catch (e) { /* table exists */ }

    // Ensure email_schedules table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS email_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, template_name TEXT, subject TEXT, body_template TEXT, trigger_event TEXT, days_after INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)').run();
    } catch (e) { /* table exists */ }

    // Ensure grading_config table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS grading_config (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, key TEXT, value TEXT, updated_at TEXT)').run();
    } catch (e) { /* table exists */ }

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
        let sql = 'SELECT * FROM leads WHERE 1=1';
        const params = [];
        if (search) { sql += ' AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(phone) LIKE ?)'; params.push('%'+search.toLowerCase()+'%', '%'+search.toLowerCase()+'%', '%'+search.toLowerCase()+'%'); }
        if (status) { sql += ' AND status = ?'; params.push(status); }
        if (source) { sql += ' AND source = ?'; params.push(source); }
        sql += ' ORDER BY created_at DESC';
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
        const newLeads = await env.DB.prepare("SELECT id, name, email, source, created_at FROM leads WHERE status = 'new' ORDER BY created_at DESC").all();

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

        return json({
          newLeads: newLeads.results,
          pendingApps: pendingApps.results,
          unassigned: unassigned.results,
          pendingKittens: pendingKittens.results,
          recentMessages: recentMessages.results,
          upcomingEmails: upcomingEmails
        });
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
        const users = await env.DB.prepare('SELECT id, email, role, status, lead_id, welcome_sent_at, created_at, updated_at FROM users ORDER BY created_at DESC').all();
        return json({ users: users.results });
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
        fields.push('updated_at = ?'); values.push(now());
        values.push(userId);
        await env.DB.prepare('UPDATE users SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();
        await writeAuditLog(env.DB, session.user_id, 'user_updated', { target_user_id: userId, changes: data });
        return json({ success: true });
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

  const tabs = ['todo','dashboard','leads','applications','kittens','cats','settings','emails','users','audit'];
  const tabLabels = { todo:'To Do', dashboard:'Dashboard', leads:'Leads', applications:'Applications', kittens:'Kittens', cats:'Cats', settings:'Settings', emails:'Emails', users:'Users', audit:'Audit Log' };

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
  else if (currentTab === 'settings') await renderSettings(content);
  else if (currentTab === 'emails') await renderEmails(content);
  else if (currentTab === 'users') await renderUsers(content);
  else if (currentTab === 'audit') await renderAudit(content);
}

// ---- Dashboard ----

async function renderTodo(container) {
  const data = await api('/admin/todo');
  const panel = el('div', { class: 'panel active' });
  let html = '<h2 style="margin:20px 0 4px">Action Center</h2>';
  html += '<p style="color:#6B5B4B;margin-bottom:20px;font-size:.88rem">Everything that needs your attention, in one place.</p>';

  // Count total actions
  const totalActions = (data.newLeads||[]).length + (data.pendingApps||[]).length + (data.recentMessages||[]).length + (data.pendingKittens||[]).length;

  if (totalActions === 0 && (data.upcomingEmails||[]).length === 0) {
    html += '<div style="text-align:center;padding:40px;color:#7A8B6F"><div style="font-size:2.5rem;margin-bottom:12px">&#10003;</div><h3>All caught up!</h3><p style="color:#6B5B4B">No pending actions right now.</p></div>';
  }

  // New Leads
  if ((data.newLeads||[]).length > 0) {
    html += '<div style="margin-bottom:24px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="background:#87A5B4;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">' + data.newLeads.length + '</div><h3 style="margin:0;font-size:1rem">New Leads to Review</h3></div>';
    data.newLeads.forEach(l => {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:6px">';
      html += '<div><strong>' + esc(l.name) + '</strong><br><span style="font-size:.78rem;color:#6B5B4B">' + esc(l.email) + ' &mdash; ' + esc(l.source) + ' &mdash; ' + timeAgo(l.created_at) + '</span></div>';
      html += '<div style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="currentTab=&#39;leads&#39;;renderApp()">Review</button></div>';
      html += '</div>';
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
      html += '<button class="btn btn-outline btn-sm" onclick="currentTab=&#39;applications&#39;;renderApp()">Review</button>';
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
      html += '<button class="btn btn-outline btn-sm" onclick="showLeadModal(' + m.lead_id + ')">Reply</button>';
      html += '</div>';
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
  table.innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Status</th><th>When</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (leads || []).forEach(lead => {
    const tr = el('tr');
    tr.innerHTML = '<td><strong>'+esc(lead.name)+'</strong></td><td>'+esc(lead.email)+'</td><td>'+esc(lead.phone||'—')+'</td><td>'+esc(lead.source)+'</td><td>'+badge(lead.status)+'</td><td>'+timeAgo(lead.created_at)+'</td>';
    const actionTd = el('td', { style: 'white-space:nowrap' });
    actionTd.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showLeadModal(lead.id) }, 'View'));
    if (lead.status === 'new') {
      actionTd.appendChild(el('button', { class: 'btn btn-success btn-sm', style: 'margin-left:4px', onclick: async () => {
        if (confirm('Approve ' + lead.name + '? This will create their account and send a welcome email.')) {
          const res = await api('/admin/approve', { method: 'POST', body: JSON.stringify({ lead_id: lead.id }) });
          if (res.success) { showApprovalModal(lead.name, lead.email, res.tempPassword); }
          else alert(res.error || 'Failed');
        }
      }}, 'Approve'));
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
    html += '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';padding:12px;border-radius:8px;margin-bottom:8px;font-size:.88rem">';
    html += '<div style="font-size:.75rem;color:#6B5B4B;margin-bottom:4px;display:flex;justify-content:space-between">' + dirLabel + ' <span>' + esc(msg.created_at) + '</span></div>';
    html += '<div style="font-size:.8rem;font-weight:600;margin-bottom:4px">' + esc(msg.subject || '') + '</div>';
    html += '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">' + esc(msg.body || '') + '</pre></div>';
  });

  // Send message form
  html += '<h3 style="margin:20px 0 8px">Send Message</h3>';
  html += '<div class="field"><label>Subject</label><input type="text" id="msgSubject" value="Blue Sky Cattery" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px"></div>';
  html += '<div class="field"><label>Message</label><textarea id="msgBody" rows="4" style="width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px" placeholder="Type your message to ' + esc(lead.name) + '..."></textarea></div>';

  html += '<div class="actions">';
  html += '<button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Close</button>';
  html += '<button class="btn btn-primary" id="sendMsgBtn">Send Email</button>';
  html += '</div>';

  modal.innerHTML = html;
  bg.appendChild(modal);
  document.body.appendChild(bg);

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

    litterHtml += '<table><thead><tr><th>#</th><th>Name</th><th>Color</th><th>Sex</th><th>Status</th><th>Reserved By</th><th>Price</th><th>Actions</th></tr></thead><tbody>';
    (litter.kittens || []).forEach(k => {
      const statusColor = statusColors[k.status] || '#6B5B4B';
      litterHtml += '<tr>';
      litterHtml += '<td><strong>' + k.number + '</strong></td>';
      litterHtml += '<td>' + esc(k.name || 'Kitten #' + k.number) + '</td>';
      litterHtml += '<td>' + esc(k.color || 'TBD') + '</td>';
      litterHtml += '<td>' + esc(k.sex || 'TBD') + '</td>';
      litterHtml += '<td><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:' + statusColor + ';color:#fff">' + esc(k.status) + '</span></td>';
      litterHtml += '<td>' + esc(k.reserved_by || '---') + '</td>';
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

function showKittenEditModal(kittenId, kitten) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };

  const modal = document.createElement('div');
  modal.className = 'modal';
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
    '<div class="field"><label>Notes</label><textarea id="ekNotes" rows="2">' + esc(kitten.notes || '') + '</textarea></div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveKittenBtn">Save Changes</button></div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  document.getElementById('saveKittenBtn').onclick = async () => {
    await api('/admin/kittens/' + kittenId, { method: 'PUT', body: JSON.stringify({
      name: document.getElementById('ekName').value,
      color: document.getElementById('ekColor').value,
      sex: document.getElementById('ekSex').value,
      price: parseFloat(document.getElementById('ekPrice').value),
      status: document.getElementById('ekStatus').value,
      reserved_by: document.getElementById('ekReservedBy').value,
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

function showCatModal(cat) {
  const isEdit = !!cat;
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2>' + (isEdit ? 'Edit Cat' : 'Add Cat') + '</h2>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Name</label><input type="text" id="catName" value="' + esc(cat ? cat.name : '') + '"></div>' +
    '<div class="field"><label>Breed</label><input type="text" id="catBreed" value="' + esc(cat ? cat.breed : 'Oriental Shorthair') + '"></div>' +
    '<div class="field"><label>Role</label><select id="catRole"><option value="queen"' + (cat && cat.role === 'queen' ? ' selected' : '') + '>Queen</option><option value="king"' + (cat && cat.role === 'king' ? ' selected' : '') + '>King</option></select></div>' +
    '<div class="field"><label>Sex</label><select id="catSex"><option value="female"' + (cat && cat.sex === 'female' ? ' selected' : '') + '>Female</option><option value="male"' + (cat && cat.sex === 'male' ? ' selected' : '') + '>Male</option></select></div>' +
    '<div class="field"><label>Color</label><input type="text" id="catColor" value="' + esc(cat ? cat.color : '') + '"></div>' +
    '<div class="field"><label>Registration</label><input type="text" id="catReg" value="' + esc(cat ? cat.registration : '') + '"></div>' +
    '<div class="field"><label>Photo URL</label><input type="text" id="catPhoto" value="' + esc(cat ? cat.photo_url : '') + '"></div>' +
    '<div class="field"><label>Sort Order</label><input type="number" id="catSort" value="' + (cat ? cat.sort_order || 0 : 0) + '"></div>' +
    '</div>' +
    '<div class="field" style="margin-top:12px"><label>Bio</label><textarea id="catBio" rows="3">' + esc(cat ? cat.bio : '') + '</textarea></div>' +
    '<div style="display:flex;gap:16px;margin-top:12px;align-items:center">' +
    '<label style="display:flex;align-items:center;gap:8px;font-size:.88rem"><input type="checkbox" id="catHealth"' + (cat && cat.health_tested ? ' checked' : '') + '> Health Tested</label>' +
    (isEdit ? '<label style="display:flex;align-items:center;gap:8px;font-size:.88rem">Status: <select id="catStatus"><option value="active"' + (cat.status === 'active' ? ' selected' : '') + '>Active</option><option value="inactive"' + (cat.status === 'inactive' ? ' selected' : '') + '>Inactive</option><option value="retired"' + (cat.status === 'retired' ? ' selected' : '') + '>Retired</option></select></label>' : '') +
    '</div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveCatBtn">' + (isEdit ? 'Save Changes' : 'Add Cat') + '</button></div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  document.getElementById('saveCatBtn').onclick = async () => {
    const data = {
      name: document.getElementById('catName').value,
      breed: document.getElementById('catBreed').value,
      role: document.getElementById('catRole').value,
      sex: document.getElementById('catSex').value,
      color: document.getElementById('catColor').value,
      registration: document.getElementById('catReg').value,
      photo_url: document.getElementById('catPhoto').value,
      sort_order: parseInt(document.getElementById('catSort').value) || 0,
      bio: document.getElementById('catBio').value,
      health_tested: document.getElementById('catHealth').checked
    };
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

async function renderUsers(container) {
  const { users } = await api('/admin/users');
  const panel = el('div', { class: 'panel active' });

  let html = '<h2 style="margin:20px 0 12px">User Management</h2>';
  html += '<table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Lead ID</th><th>Welcome Sent</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
  (users || []).forEach(u => {
    html += '<tr>';
    html += '<td><strong>' + esc(u.email) + '</strong></td>';
    html += '<td><span style="padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;background:' + (u.role === 'admin' ? '#A0522D' : '#87A5B4') + ';color:#fff;text-transform:uppercase">' + esc(u.role) + '</span></td>';
    html += '<td>' + badge(u.status) + '</td>';
    html += '<td>' + (u.lead_id || '---') + '</td>';
    html += '<td>' + (u.welcome_sent_at ? timeAgo(u.welcome_sent_at) : '---') + '</td>';
    html += '<td>' + timeAgo(u.created_at) + '</td>';
    html += '<td>';
    html += '<button class="btn btn-outline btn-sm" data-user-edit="' + u.id + '">Edit</button> ';
    html += '<button class="btn btn-danger btn-sm" data-user-reset="' + u.id + '">Reset PW</button>';
    html += '</td></tr>';
  });
  html += '</tbody></table>';
  if (!users || users.length === 0) html += '<p style="color:#6B5B4B;padding:20px;text-align:center">No users.</p>';

  panel.innerHTML = html;
  container.appendChild(panel);

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

function showUserEditModal(user) {
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2>Edit User</h2>' +
    '<div class="field"><label>Email</label><div class="value">' + esc(user.email) + '</div></div>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Role</label><select id="euRole"><option value="applicant"' + (user.role === 'applicant' ? ' selected' : '') + '>Applicant</option><option value="admin"' + (user.role === 'admin' ? ' selected' : '') + '>Admin</option></select></div>' +
    '<div class="field"><label>Status</label><select id="euStatus"><option value="active"' + (user.status === 'active' ? ' selected' : '') + '>Active</option><option value="suspended"' + (user.status === 'suspended' ? ' selected' : '') + '>Suspended</option><option value="inactive"' + (user.status === 'inactive' ? ' selected' : '') + '>Inactive</option></select></div>' +
    '</div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(&#39;.modal-bg&#39;).remove()">Cancel</button><button class="btn btn-primary" id="saveUserBtn">Save</button></div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  document.getElementById('saveUserBtn').onclick = async () => {
    await api('/admin/users/' + user.id, { method: 'PUT', body: JSON.stringify({
      role: document.getElementById('euRole').value,
      status: document.getElementById('euStatus').value
    })});
    bg.remove();
    renderApp();
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
