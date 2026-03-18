// ============================================
// Blue Sky Cattery - Portal Worker
// Cloudflare Worker + D1 Database
// Slimmed-down: public + applicant endpoints only
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
  // sendBeacon sends as text/plain
  const text = await request.text();
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// ---- Token / Session Management ----

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

  // Housing type + ownership (max 15)
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

  // Landlord info if renting (bonus 3)
  if (app.housing_own_rent === 'rent' && app.landlord_info && app.landlord_info.length > 10) {
    homeScore += 3; highlights.push('Provided landlord contact for pet verification');
  }

  // Indoor only (max 7)
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

  // Bonus for reputable pet sources
  if (petSource.includes('breeder') || petSource.includes('rescue') || petSource.includes('shelter')) {
    companionScore = Math.min(companionScore + 2, 20);
  }

  categories.companion = { score: companionScore, max: 20, label: 'Companion & Pets' };

  // ============ EXPERIENCE & KNOWLEDGE (max 20) ============
  let expScore = 0;
  const exp = (app.cat_experience || '').toLowerCase();
  const why = (app.why_oriental || '').toLowerCase();
  const vocal = (app.vocal_comfort || '').toLowerCase();

  // Cat experience (max 10)
  if (exp.includes('oriental') || exp.includes('siamese') || exp.includes('breeder') || exp.includes('show')) {
    expScore += 10; highlights.push('Experience with Oriental/Siamese breeds');
  } else if ((exp.includes('cat') || exp.includes('years')) && exp.length > 30) {
    expScore += 7;
  } else if (exp.includes('first') || exp.includes('new') || exp.includes('never')) {
    expScore += 2; risks.push('First-time cat owner');
  } else {
    expScore += 4;
  }

  // Breed knowledge / motivation (max 7)
  const knowledgeWords = ['personality', 'intelligent', 'vocal', 'companion', 'bond', 'research', 'active', 'social', 'honk', 'dog-like', 'follow', 'attention'];
  const knowledgeCount = knowledgeWords.filter(w => why.includes(w)).length;
  if (knowledgeCount >= 4) { expScore += 7; highlights.push('Demonstrates strong breed knowledge'); }
  else if (knowledgeCount >= 2) { expScore += 5; }
  else if (why.length > 50) { expScore += 3; }
  else { expScore += 1; }

  // Vocal comfort (max 3)
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

  // Adjustment plan (max 5)
  if (adjust.includes('patience') || adjust.includes('time') || adjust.includes('vet') || adjust.includes('work with') || adjust.includes('behaviorist')) {
    commitScore += 5; highlights.push('Thoughtful adjustment plan');
  } else if (adjust.length > 30) {
    commitScore += 3;
  } else {
    commitScore += 0;
  }

  // Rehome circumstances (max 5)
  if (rehome.includes('never') || rehome.includes('no circumstance') || rehome.includes('would not') || rehome.includes('not an option') || rehome.includes('lifetime')) {
    commitScore += 5; highlights.push('Committed to lifetime ownership');
  } else if (rehome.includes('last resort') || rehome.includes('only if') || rehome.includes('breeder first')) {
    commitScore += 3;
  } else if (rehome.length > 10) {
    commitScore += 0; risks.push('Listed circumstances for rehoming');
  } else {
    commitScore += 1;
  }

  // Spay/neuter agreement (max 3)
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
    commitScore += 2; // breeding/show - spay not applicable
  }

  // Enrichment plan (max 4)
  const enrichWords = ['tree', 'toys', 'play', 'climb', 'puzzle', 'feather', 'interactive', 'scratch', 'perch', 'window'];
  const enrichCount = enrichWords.filter(w => enrich.includes(w)).length;
  if (enrichCount >= 3) { commitScore += 4; highlights.push('Detailed enrichment plan'); }
  else if (enrichCount >= 1) { commitScore += 2; }
  else if (enrich.length > 20) { commitScore += 1; }
  else { commitScore += 0; risks.push('No enrichment plan provided'); }

  // Financial readiness (max 3)
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

  // Pet health history transparency
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

  // Consistency: cat count vs pet description
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

  // Consistency: home description vs housing type
  const homeDesc = (app.verify_home_description || '').toLowerCase();
  if (app.housing_type === 'house' && (homeDesc.includes('apartment') || homeDesc.includes('studio') || homeDesc.includes('small unit'))) {
    deceptionPenalty += 8;
    deceptionFlags.push('INCONSISTENT: Selected house but describes apartment-like space');
    risks.push('Housing description contradicts selection');
  }

  // Surrender history: said no but details suggest otherwise
  if (app.surrender_history === 'no' && app.pet_history) {
    const history = app.pet_history.toLowerCase();
    if (history.includes('rehome') || history.includes('gave away') || history.includes('returned') || history.includes('had to give') || history.includes('found a home for')) {
      deceptionPenalty += 8;
      deceptionFlags.push('INCONSISTENT: Denied rehoming but pet history suggests otherwise');
      risks.push('Possible undisclosed pet rehoming');
    }
  }

  // Surrender said yes but no explanation
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
    else { totalScore += cat.score; } // penalties
  });

  totalScore = Math.max(0, Math.min(100, totalScore));

  // ============ PURPOSE-SPECIFIC FLAGS ============
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
    // Extract JSON from response (handle potential markdown wrapping)
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

const BREVO_LISTS = { leads: 5, approved: 6, active: 7, rejected: 8, waitlist: 9, adopters: 10, flagged: 11 };

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

// ---- Cross-Application Matching ----

async function findMatchingApplicants(db, app) {
  const matches = [];

  // Match by email
  if (app.email) {
    const emailMatches = await db.prepare('SELECT id, full_name, email, litter_code, score, status, created_at FROM applications WHERE email = ? AND id != ? ORDER BY created_at DESC').bind(app.email, app.id || 0).all();
    emailMatches.results.forEach(m => matches.push({ type: 'Same Email', ...m }));
  }

  // Match by partner email
  if (app.partner_email) {
    const partnerMatches = await db.prepare('SELECT id, full_name, email, litter_code, score, status, created_at FROM applications WHERE email = ? OR partner_email = ?').bind(app.partner_email, app.partner_email).all();
    partnerMatches.results.forEach(m => { if (m.id !== (app.id || 0)) matches.push({ type: 'Partner Email Match', ...m }); });
  }

  // Match by phone
  if (app.phone) {
    const cleanPhone = (app.phone || '').replace(/\D/g, '');
    if (cleanPhone.length >= 7) {
      const phoneMatches = await db.prepare("SELECT id, full_name, email, phone, litter_code, score, status, created_at FROM applications WHERE REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '(', '') LIKE ?").bind('%' + cleanPhone.slice(-7) + '%').all();
      phoneMatches.results.forEach(m => { if (m.id !== (app.id || 0)) matches.push({ type: 'Phone Match', ...m }); });
    }
  }

  // Match by home address (fuzzy)
  if (app.home_address && app.home_address.length > 10) {
    const addrWords = app.home_address.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (addrWords.length >= 2) {
      const addrMatches = await db.prepare("SELECT id, full_name, email, home_address, litter_code, score, status, created_at FROM applications WHERE LOWER(home_address) LIKE ? AND id != ?").bind('%' + addrWords[0] + '%', app.id || 0).all();
      addrMatches.results.forEach(m => {
        const mWords = (m.home_address || '').toLowerCase().split(/\s+/);
        const overlap = addrWords.filter(w => mWords.some(mw => mw.includes(w))).length;
        if (overlap >= 2) matches.push({ type: 'Address Match', ...m });
      });
    }
  }

  // Match by name (exact or very close)
  if (app.full_name) {
    const nameMatches = await db.prepare('SELECT id, full_name, email, litter_code, score, status, created_at FROM applications WHERE LOWER(full_name) = ? AND id != ?').bind(app.full_name.toLowerCase(), app.id || 0).all();
    nameMatches.results.forEach(m => matches.push({ type: 'Same Name', ...m }));
  }

  // Deduplicate by id
  const seen = new Set();
  return matches.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
}

// ---- Email Sending (via Brevo) ----

let _brevoKey = null;

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

// ---- Route Handler ----

export default {
  async fetch(request, env) {
    // Set Brevo key from environment secret
    _brevoKey = env.BREVO_API_KEY || null;

    // Ensure sessions table exists
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, user_id INTEGER, role TEXT, expires_at TEXT)').run();
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
      // PUBLIC ENDPOINTS
      // =====================

      // Contact form submission (from website)
      if (path === '/api/contact' && method === 'POST') {
        const data = await parseBody(request);
        const { name, email, phone, subject, message } = data;

        if (!name || !email || !message) {
          return json({ error: 'Name, email, and message are required' }, 400);
        }

        // Check if lead already exists
        const existing = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(email).first();

        let leadId;
        if (existing) {
          leadId = existing.id;
          await env.DB.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').bind(now(), leadId).run();
        } else {
          const result = await env.DB.prepare(
            'INSERT INTO leads (name, email, phone, subject, message, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(name, email, phone || null, subject || 'general', message, 'contact', 'new', now(), now()).run();
          leadId = result.meta.last_row_id;
        }

        // Save the message
        await env.DB.prepare(
          'INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(leadId, 'inbound', subject || 'Contact Form', `From: ${name} (${email})\nPhone: ${phone || 'N/A'}\n\n${message}`, now()).run();

        // Sync to Brevo CRM
        await syncToBrevoCRM({ name, email, phone, source: 'contact', status: 'new' }, BREVO_LISTS.leads, {});

        // Notify Deanna of new contact
        await sendEmail('Deanna@blueskycattery.com', 'New Contact: ' + name,
          'New contact form submission:\n\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || 'N/A') + '\nSubject: ' + (subject || 'General') + '\n\nMessage:\n' + message + '\n\n---\nView in admin portal: https://admin.blueskycattery.com', 'Deanna');

        return json({ success: true, message: 'Contact saved' });
      }

      // Reservation form submission (from website)
      if (path === '/api/reserve' && method === 'POST') {
        const data = await parseBody(request);
        const { name, email, phone, kitten } = data;

        if (!name || !email) {
          return json({ error: 'Name and email are required' }, 400);
        }

        const existing = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(email).first();

        let leadId;
        if (existing) {
          leadId = existing.id;
          await env.DB.prepare('UPDATE leads SET updated_at = ?, source = ? WHERE id = ?').bind(now(), 'reservation', leadId).run();
        } else {
          const result = await env.DB.prepare(
            'INSERT INTO leads (name, email, phone, subject, message, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(name, email, phone || null, 'Kitten Reservation', `Interested in ${kitten || 'a kitten'}`, 'reservation', 'new', now(), now()).run();
          leadId = result.meta.last_row_id;
        }

        // Build summary of all form fields
        const fields = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n');
        await env.DB.prepare(
          'INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(leadId, 'inbound', `Kitten Reservation - ${kitten || 'General'}`, `From: ${name} (${email})\n\n${fields}`, now()).run();

        // Sync to Brevo CRM
        await syncToBrevoCRM({ name, email, phone, source: 'reservation', status: 'new' }, BREVO_LISTS.leads, {});

        // Notify Deanna of new reservation
        await sendEmail('Deanna@blueskycattery.com', 'New Kitten Reservation: ' + name,
          'New kitten reservation request:\n\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || 'N/A') + '\nKitten: ' + (kitten || 'General') + '\n\nFull details:\n' + fields + '\n\n---\nView in admin portal: https://admin.blueskycattery.com', 'Deanna');

        return json({ success: true, message: 'Reservation saved' });
      }

      // Public kitten availability for website
      if (path === '/api/kittens/status' && method === 'GET') {
        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ kittens: [] });
        const kittens = await env.DB.prepare('SELECT number, name, color, sex, status, reserved_by FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
        return json({ litter_code: litter.litter_code, kittens: kittens.results });
      }

      // Public cat profiles
      if (path === '/api/cats' && method === 'GET') {
        const cats = await env.DB.prepare("SELECT * FROM cats WHERE status = 'active' ORDER BY sort_order").all();
        return json({ cats: cats.results });
      }

      // Brevo inbound email webhook
      if (path === '/api/webhook/inbound-email' && method === 'POST') {
        const payload = await parseBody(request);
        const items = payload.items || [payload];
        for (const item of items) {
          const fromEmail = (item.From || item.from || {}).Address || (item.From || item.from || '');
          const subject = item.Subject || item.subject || 'Reply';
          const body = item.ExtractedMarkdownMessage || item.RawTextBody || item.rawTextBody || '';
          if (fromEmail) {
            // Find the lead by email
            const lead = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(fromEmail).first();
            if (lead) {
              await env.DB.prepare('INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
                .bind(lead.id, 'inbound_reply', subject, body, now()).run();
            }
            // Also forward to Deanna so she sees it in Gmail too
            await sendEmail('Deanna@blueskycattery.com', 'Reply from ' + fromEmail + ': ' + subject,
              'Reply received from: ' + fromEmail + '\nSubject: ' + subject + '\n\n' + body + '\n\n---\nView in admin portal: https://admin.blueskycattery.com', 'Deanna');
          }
        }
        return json({ success: true });
      }

      // =====================
      // AUTH ENDPOINTS
      // =====================

      // Login
      if (path === '/api/auth/login' && method === 'POST') {
        const { email, password } = await request.json();
        if (!email || !password) {
          return json({ error: 'Email and password required' }, 400);
        }

        const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND status = ?').bind(email, 'active').first();
        if (!user) {
          return json({ error: 'Invalid credentials' }, 401);
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
      // APPLICANT ENDPOINTS
      // =====================

      // Submit application
      if (path === '/api/application' && method === 'POST') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);

        const data = await request.json();
        const grading = gradeApplication(data);

        // AI analysis (non-blocking — if it fails, we still have rule-based score)
        let aiResult = null;
        try {
          if (env.AI) {
            aiResult = await aiAnalyzeApplication(data, grading, env);
            if (aiResult) {
              // Merge AI findings into grading
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
              // Update grade label
              grading.grade = grading.score >= 80 ? 'Excellent' : grading.score >= 65 ? 'Good' : grading.score >= 45 ? 'Fair' : 'Needs Review';
            }
          }
        } catch (e) { console.error('AI analysis error:', e); }

        await env.DB.prepare(`
          INSERT INTO applications (user_id, kitten_preference, full_name, email, phone, city_state, housing_type, housing_own_rent, other_pets, cat_experience, why_oriental, indoor_only, household_members, work_schedule, vet_name, vet_phone, pet_history, surrender_history, allergies, timeline, additional_notes, landlord_info, pet_source, pet_health_history, vocal_comfort, adjustment_plan, rehome_circumstances, enrichment_plan, spay_neuter_opinion, financial_readiness, verify_cat_count, verify_home_description, how_found_us, surrender_details, kitten_primary, kitten_backup1, kitten_backup2, sex_preference, purpose, highlights, risks, score, score_breakdown, status, home_address, marital_status, partner_name, partner_email, partner_phone, litter_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          session.user_id, data.kitten_preference || null, data.full_name, data.email, data.phone,
          data.city_state, data.housing_type, data.housing_own_rent || null, data.other_pets,
          data.cat_experience, data.why_oriental, data.indoor_only, data.household_members || null,
          data.work_schedule || null, data.vet_name || null, data.vet_phone || null,
          data.pet_history || null, data.surrender_history || null, data.allergies || null,
          data.timeline || null, data.additional_notes || null,
          data.landlord_info || null, data.pet_source || null, data.pet_health_history || null,
          data.vocal_comfort || null, data.adjustment_plan || null, data.rehome_circumstances || null,
          data.enrichment_plan || null, data.spay_neuter_opinion || null, data.financial_readiness || null,
          data.verify_cat_count || null, data.verify_home_description || null, data.how_found_us || null,
          data.surrender_details || null,
          data.kitten_primary || null, data.kitten_backup1 || null, data.kitten_backup2 || null,
          data.sex_preference || null, data.purpose || 'pet',
          JSON.stringify(grading.highlights), JSON.stringify(grading.risks),
          grading.score, JSON.stringify(grading.categories), 'submitted',
          data.home_address || null, data.marital_status || null,
          data.partner_name || null, data.partner_email || null, data.partner_phone || null,
          '2026-Chili', now(), now()
        ).run();

        // Cross-application matching
        const appRecord = { id: 0, email: data.email, phone: data.phone, full_name: data.full_name, home_address: data.home_address, partner_email: data.partner_email };
        const priorMatches = await findMatchingApplicants(env.DB, appRecord);
        if (priorMatches.length > 0) {
          // Update the application with match info
          const matchInfo = priorMatches.map(m => m.type + ': ' + m.full_name + ' (' + m.email + ') - ' + m.litter_code + ' score:' + m.score + ' status:' + m.status).join('; ');
          grading.risks.push('PRIOR APPLICATION MATCH: ' + priorMatches.length + ' related record(s) found');
          // Save match flags
          await env.DB.prepare('UPDATE applications SET match_flags = ?, previous_app_ids = ?, risks = ? WHERE user_id = ? ORDER BY id DESC LIMIT 1')
            .bind(matchInfo, priorMatches.map(m => m.id).join(','), JSON.stringify(grading.risks), session.user_id).run();
        }

        // Sync to Brevo CRM with application data
        const riskLevel = grading.risks.length === 0 ? 'low' : grading.risks.length <= 2 ? 'medium' : 'high';
        await updateBrevoContact(data.email, {
          APPLICATION_SCORE: grading.score,
          APPLICATION_GRADE: grading.grade,
          PURPOSE: data.purpose || 'pet',
          RISK_LEVEL: riskLevel,
          MARITAL_STATUS: data.marital_status || '',
          PARTNER_NAME: data.partner_name || '',
          PARTNER_EMAIL: data.partner_email || '',
          PARTNER_PHONE: data.partner_phone || '',
          HOME_ADDRESS: data.home_address || '',
          CITY_STATE: data.city_state || ''
        }, [BREVO_LISTS.active], [BREVO_LISTS.approved]);

        // If partner email provided, create/update partner in Brevo too
        if (data.partner_email) {
          await syncToBrevoCRM({
            name: data.partner_name || 'Partner of ' + data.full_name,
            email: data.partner_email,
            phone: data.partner_phone,
            source: 'partner',
            status: 'partner'
          }, BREVO_LISTS.active, {
            PARTNER_NAME: data.full_name,
            PARTNER_EMAIL: data.email
          });
        }

        // Build notification with match info
        let notification = 'A new adoption application has been submitted.\n\nApplicant: ' + data.full_name + '\nEmail: ' + data.email + '\nScore: ' + grading.score + '/100 (' + grading.grade + ')\nPurpose: ' + (data.purpose || 'pet');
        if (data.partner_name) notification += '\nPartner: ' + data.partner_name + ' (' + (data.partner_email || 'no email') + ')';
        if (priorMatches.length > 0) notification += '\n\n⚠ PRIOR MATCHES FOUND: ' + priorMatches.length + ' related record(s)';
        if (grading.risks.length > 0) notification += '\n\nRisks: ' + grading.risks.join(', ');
        notification += '\n\nReview in admin portal: https://admin.blueskycattery.com';

        await sendEmail('Deanna@blueskycattery.com', 'New Application: ' + data.full_name + ' (' + grading.grade + ')', notification, 'Deanna');

        return json({ success: true, message: 'Application submitted' });
      }

      // Get my application (strip score data - admin only)
      if (path === '/api/application' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const app = await env.DB.prepare('SELECT id, user_id, kitten_preference, full_name, email, phone, city_state, housing_type, status, admin_notes, created_at, updated_at FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(session.user_id).first();
        return json({ application: app });
      }

      // =====================
      // PORTAL PAGE SERVING
      // =====================

      // Serve applicant portal at root
      if (path === '/' || path === '') {
        return new Response(PORTAL_HTML, { headers: { 'Content-Type': 'text/html' } });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', details: err.message }, 500);
    }
  }
};

// ============================================
// APPLICANT PORTAL HTML
// ============================================
const PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blue Sky Cattery - Application Portal</title>
<meta name="robots" content="noindex, nofollow">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f0eb;color:#3E3229;line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:0 20px}
header{background:linear-gradient(145deg,#4A3D33,#3E3229);color:#fff;padding:16px 0;box-shadow:0 4px 12px rgba(0,0,0,.15)}
header h1{font-size:1.3rem}
header .sub{font-size:.8rem;color:#C8B88A}
.top-bar{display:flex;justify-content:space-between;align-items:center}
.btn{padding:10px 22px;border:none;border-radius:6px;cursor:pointer;font-size:.9rem;font-weight:600;transition:.2s}
.btn-primary{background:linear-gradient(180deg,#B5613A,#A0522D,#8A4425);color:#fff;box-shadow:0 3px 10px rgba(160,82,45,.3)}
.btn-primary:hover{transform:translateY(-1px)}
.btn-outline{background:transparent;border:1px solid #D4C5A9;color:#6B5B4B}
.card{background:linear-gradient(145deg,#FDF9F3,#F8F3EA);padding:32px;border-radius:16px;margin:24px 0;box-shadow:0 8px 24px rgba(62,50,41,.1),inset 0 1px 0 rgba(255,255,255,.6);border:1px solid rgba(212,197,169,.3)}
.card h2{font-size:1.4rem;margin-bottom:8px}
.card p{color:#6B5B4B;margin-bottom:16px}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:.82rem;font-weight:600;color:#3E3229;margin-bottom:4px}
.form-group .hint{font-size:.75rem;color:#6B5B4B;margin-top:2px}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 14px;border:1px solid #D4C5A9;border-radius:6px;font-size:.92rem;font-family:inherit;box-shadow:inset 0 2px 4px rgba(62,50,41,.05)}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{outline:none;border-color:#A0522D;box-shadow:0 0 0 3px rgba(160,82,45,.1)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-section{font-size:1rem;font-weight:700;color:#A0522D;margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid #D4C5A9}
.login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3E3229,#6B5B4B)}
.login-box{background:#FAF6F0;padding:40px;border-radius:16px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.login-box h1{font-size:1.5rem;margin-bottom:4px;color:#3E3229}
.login-box .sub{color:#6B5B4B;margin-bottom:24px;font-size:.9rem}
.login-box input{width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:12px}
.login-box input:focus{outline:none;border-color:#A0522D}
.error{color:#8B3A3A;font-size:.85rem;margin-bottom:12px}
.success-msg{text-align:center;padding:40px}
.success-msg .icon{font-size:3rem;margin-bottom:12px}
.success-msg h2{margin-bottom:8px}
.status-card{text-align:center;padding:24px}
.status-card .badge{font-size:.9rem;padding:6px 16px}
.hidden{display:none!important}
@media(max-width:600px){.form-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="app"></div>
<script>
const API = window.location.origin + '/api';
let authToken = localStorage.getItem('bsc_portal_token');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(API + path, { ...opts, headers });
  return res.json();
}

async function renderLogin() {
  document.getElementById('app').innerHTML = \`
  <div class="login-page">
    <div class="login-box">
      <h1>Application Portal</h1>
      <div class="sub">Blue Sky Cattery</div>
      <div id="loginError" class="error hidden"></div>
      <form id="loginForm">
        <input type="email" id="loginEmail" placeholder="Email" required>
        <input type="password" id="loginPass" placeholder="Password" required>
        <button type="submit" class="btn btn-primary" style="width:100%">Sign In</button>
      </form>
      <p style="margin-top:16px;font-size:.82rem;color:#6B5B4B;text-align:center">Don't have an account? Contact us at <a href="https://blueskycattery.com/contact.html" style="color:#A0522D">blueskycattery.com</a> to get started.</p>
    </div>
  </div>\`;

  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPass').value;
    const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    if (res.success) {
      authToken = res.token;
      localStorage.setItem('bsc_portal_token', res.token);
      renderPortal();
    } else {
      document.getElementById('loginError').textContent = res.error || 'Login failed';
      document.getElementById('loginError').classList.remove('hidden');
    }
  };
}

async function renderPortal() {
  const me = await api('/auth/me');
  if (!me.user) { authToken = null; localStorage.removeItem('bsc_portal_token'); return renderLogin(); }

  const { application: existing } = await api('/application');

  let content = '';
  if (existing) {
    const statusMap = { submitted: 'Your application is under review', reviewed: 'Your application has been reviewed', approved: 'Congratulations! Your application has been approved!', rejected: 'Unfortunately, your application was not approved at this time.' };
    content = \`<div class="card"><div class="status-card">
      <div style="font-size:2.5rem;margin-bottom:12px">\${existing.status === 'approved' ? '&#127881;' : existing.status === 'rejected' ? '&#128532;' : '&#128203;'}</div>
      <h2>Application \${existing.status.charAt(0).toUpperCase() + existing.status.slice(1)}</h2>
      <p>\${statusMap[existing.status] || 'Status: ' + existing.status}</p>
      <p style="font-size:.85rem;color:#6B5B4B">Submitted: \${existing.created_at}</p>
    </div></div>\`;
  } else {
    content = renderApplicationForm();
  }

  document.getElementById('app').innerHTML = \`
  <header><div class="container top-bar">
    <div><h1>Application Portal</h1><div class="sub">\${me.user.email}</div></div>
    <button class="btn btn-outline" onclick="logout()">Logout</button>
  </div></header>
  <div class="container">\${content}</div>\`;

  if (!existing) {
    document.getElementById('appForm').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = {};
      new FormData(form).forEach((v, k) => data[k] = v);
      const res = await api('/application', { method: 'POST', body: JSON.stringify(data) });
      if (res.success) renderPortal();
      else alert(res.error || 'Failed to submit');
    };
  }
}

function renderApplicationForm() {
  return \`<div class="card">
    <h2>Adoption Application</h2>
    <p>Thank you for your interest in a Blue Sky Cattery kitten! Please complete this application thoroughly and honestly. All information helps us ensure the best match between our kittens and their forever families. Incomplete or inconsistent applications may not be considered.</p>
    <form id="appForm">
      <div class="form-section">Personal Information</div>
      <div class="form-row">
        <div class="form-group"><label>Full Legal Name *</label><input type="text" name="full_name" required></div>
        <div class="form-group"><label>Email Address *</label><input type="email" name="email" required></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Phone Number *</label><input type="tel" name="phone" required></div>
        <div class="form-group"><label>City / State *</label><input type="text" name="city_state" required></div>
      </div>
      <div class="form-group"><label>Full Home Address *</label><input type="text" name="home_address" required placeholder="Street, City, State, ZIP">
        <div class="hint">Used for verification and to ensure we can deliver your kitten safely.</div></div>

      <div class="form-section">Relationship & Household Decision-Makers</div>
      <div class="form-row">
        <div class="form-group"><label>Marital / Relationship Status *</label>
          <select name="marital_status" required><option value="">Select...</option><option value="single">Single</option><option value="married">Married</option><option value="partner">Long-term Partner / Living Together</option><option value="divorced">Divorced / Separated</option><option value="other">Other</option></select></div>
        <div class="form-group"><label>Does a spouse or partner live in the household? *</label>
          <select name="has_partner" id="hasPartner" onchange="document.getElementById('partnerFields').style.display=this.value==='yes'?'block':'none'"><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select></div>
      </div>
      <div id="partnerFields" style="display:none">
        <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:12px">Since your partner is a household decision-maker, we need their information as well. Both parties must agree to the adoption terms.</p>
        <div class="form-row">
          <div class="form-group"><label>Partner's Full Name</label><input type="text" name="partner_name"></div>
          <div class="form-group"><label>Partner's Email</label><input type="email" name="partner_email">
            <div class="hint">We may send them a confirmation of the adoption agreement.</div></div>
        </div>
        <div class="form-group"><label>Partner's Phone Number</label><input type="tel" name="partner_phone"></div>
      </div>

      <div class="form-section">Your Home Environment</div>
      <div class="form-row">
        <div class="form-group"><label>What type of home do you live in? *</label>
          <select name="housing_type" required><option value="">Select...</option><option value="house">House</option><option value="apartment">Apartment/Condo</option><option value="townhouse">Townhouse</option><option value="other">Other</option></select>
        </div>
        <div class="form-group"><label>Do you own or rent? *</label>
          <select name="housing_own_rent" required><option value="">Select...</option><option value="own">Own</option><option value="rent">Rent</option></select>
        </div>
      </div>
      <div class="form-group"><label>If renting, does your lease allow cats? Please provide your landlord's name and contact for verification.</label><textarea name="landlord_info" rows="2"></textarea></div>
      <div class="form-group"><label>Who lives in your household? Please list all members and their ages (include children) *</label><textarea name="household_members" rows="2" required></textarea></div>
      <div class="form-group"><label>Describe your typical daily schedule. How many hours per day is someone home? *</label><textarea name="work_schedule" rows="2" required></textarea>
        <div class="hint">Orientals require significant human interaction and do not do well alone for long periods.</div></div>
      <div class="form-group"><label>Does anyone in the household have allergies to cats? Have allergies ever been a reason for rehoming a pet?</label><textarea name="allergies" rows="2"></textarea></div>

      <div class="form-section">Current & Past Pets</div>
      <div class="form-group"><label>List ALL pets you currently own (type, breed, age, spayed/neutered status) *</label><textarea name="other_pets" rows="3" required></textarea>
        <div class="hint">Oriental Shorthairs require a feline companion at their energy level. If you don't have one, describe your plan.</div></div>
      <div class="form-group"><label>Where did you acquire your current pets? (breeder, shelter, rescue, etc.)</label><textarea name="pet_source" rows="2"></textarea></div>
      <div class="form-group"><label>Please describe your complete pet ownership history over the past 10 years. Include what happened to each animal. *</label><textarea name="pet_history" rows="4" required></textarea>
        <div class="hint">We want to understand the full picture. Please be thorough.</div></div>
      <div class="form-group"><label>Have you ever had to rehome, surrender, return to a breeder, or give away a pet for any reason? *</label>
        <select name="surrender_history" required><option value="">Select...</option><option value="no">No, never</option><option value="yes">Yes</option></select></div>
      <div class="form-group"><label>If yes, please explain the full circumstances.</label><textarea name="surrender_details" rows="3"></textarea></div>
      <div class="form-group"><label>Have any of your pets ever been injured, become ill, or passed away unexpectedly? Please describe.</label><textarea name="pet_health_history" rows="2"></textarea></div>

      <div class="form-section">Knowledge & Expectations</div>
      <div class="form-group"><label>What do you know about the Oriental Shorthair breed? What attracted you to them specifically? *</label><textarea name="why_oriental" rows="4" required></textarea></div>
      <div class="form-group"><label>Describe your previous experience with cats, especially purebred, Oriental, or Siamese breeds. *</label><textarea name="cat_experience" rows="3" required></textarea></div>
      <div class="form-group"><label>Oriental Shorthairs are extremely vocal and demand constant attention. How do you feel about a cat that honks, chirps, and follows you everywhere? *</label><textarea name="vocal_comfort" rows="2" required></textarea></div>
      <div class="form-group"><label>What would you do if the kitten didn't bond with you immediately or showed behavioral issues in the first few weeks? *</label><textarea name="adjustment_plan" rows="3" required></textarea></div>
      <div class="form-group"><label>Under what circumstances, if any, would you consider rehoming this cat?</label><textarea name="rehome_circumstances" rows="2"></textarea></div>
      <div class="form-group"><label>Where will the cat be kept? *</label>
        <select name="indoor_only" required><option value="">Select...</option><option value="yes">Strictly indoors</option><option value="enclosed">Indoors with enclosed outdoor access (catio)</option><option value="no">Will have outdoor access</option></select>
      </div>
      <div class="form-group"><label>How will you provide enrichment and exercise for an Oriental Shorthair? (cat trees, toys, playtime, etc.) *</label><textarea name="enrichment_plan" rows="2" required></textarea></div>

      <div class="form-section">Veterinary Care</div>
      <div class="form-group"><label>What is your current veterinarian's name and clinic? *</label><input type="text" name="vet_name" required>
        <div class="hint">We may contact your vet as a reference.</div></div>
      <div class="form-group"><label>Veterinarian phone number *</label><input type="tel" name="vet_phone" required></div>
      <div class="form-group"><label>How do you feel about the spay/neuter requirement in our contract? *</label><textarea name="spay_neuter_opinion" rows="2" required></textarea></div>
      <div class="form-group"><label>Are you prepared for the financial responsibility of cat ownership? (annual vet visits, emergencies, quality food, etc.) Approximate annual budget you'd allocate?</label><textarea name="financial_readiness" rows="2"></textarea></div>

      <div class="form-section">Verification Questions</div>
      <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:12px">These questions help us verify the consistency of your application.</p>
      <div class="form-group"><label>Earlier you described your pets. How many total cats do you currently have in your home? *</label><input type="text" name="verify_cat_count" required></div>
      <div class="form-group"><label>You mentioned your housing situation. If we visited your home, what would we see in terms of space for a cat? *</label><textarea name="verify_home_description" rows="2" required></textarea></div>
      <div class="form-group"><label>How did you first learn about Blue Sky Cattery? *</label><textarea name="how_found_us" rows="2" required></textarea></div>

      <div class="form-section">Purpose & Preferences</div>
      <div class="form-group"><label>What is the purpose of this adoption? *</label>
        <select name="purpose" required><option value="">Select...</option><option value="pet">Pet (companion animal)</option><option value="show">Show Cat</option><option value="breeding">Breeding Rights</option></select>
        <div class="hint">Breeding rights are available to selected candidates only and carry additional fees.</div></div>
      <div class="form-group"><label>Do you have a sex preference?</label>
        <select name="sex_preference"><option value="">No preference</option><option value="male">Male</option><option value="female">Female</option></select></div>
      <div class="form-group"><label>Primary Kitten Choice</label>
        <select name="kitten_primary"><option value="">No preference</option><option value="Kitten #1">Kitten #1</option><option value="Kitten #2">Kitten #2</option><option value="Kitten #3">Kitten #3</option><option value="Kitten #4">Kitten #4</option><option value="Kitten #5">Kitten #5</option><option value="Kitten #6">Kitten #6</option></select></div>
      <div class="form-group"><label>Backup Choice #1</label>
        <select name="kitten_backup1"><option value="">No backup preference</option><option value="Kitten #1">Kitten #1</option><option value="Kitten #2">Kitten #2</option><option value="Kitten #3">Kitten #3</option><option value="Kitten #4">Kitten #4</option><option value="Kitten #5">Kitten #5</option><option value="Kitten #6">Kitten #6</option></select></div>
      <div class="form-group"><label>Backup Choice #2</label>
        <select name="kitten_backup2"><option value="">No backup preference</option><option value="Kitten #1">Kitten #1</option><option value="Kitten #2">Kitten #2</option><option value="Kitten #3">Kitten #3</option><option value="Kitten #4">Kitten #4</option><option value="Kitten #5">Kitten #5</option><option value="Kitten #6">Kitten #6</option></select></div>
      <div class="form-group"><label>When are you hoping to bring a kitten home?</label><input type="text" name="timeline"></div>
      <div class="form-group"><label>Is there anything else you'd like us to know about you or your home?</label><textarea name="additional_notes" rows="3"></textarea></div>

      <div style="background:#F5EDE0;padding:16px;border-radius:8px;margin:20px 0;font-size:.85rem;color:#6B5B4B">
        <strong>By submitting this application, you confirm that:</strong>
        <ul style="margin:8px 0 0 16px">
          <li>All information provided is truthful and accurate</li>
          <li>You understand that false information is grounds for denial</li>
          <li>You consent to Blue Sky Cattery contacting your veterinarian</li>
          <li>You understand that submitting an application does not guarantee a kitten</li>
        </ul>
      </div>

      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px;padding:14px">Submit Application</button>
    </form>
  </div>\`;
}

function logout() {
  api('/auth/logout', { method: 'POST' });
  authToken = null;
  localStorage.removeItem('bsc_portal_token');
  renderLogin();
}

// Init
(async () => {
  if (authToken) {
    const me = await api('/auth/me');
    if (me.user) return renderPortal();
  }
  renderLogin();
})();
</script>
</body>
</html>`;
