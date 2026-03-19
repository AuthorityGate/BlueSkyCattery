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

// CRM pipeline lists (adoption flow): Leads(5) -> Approved(6) -> Active(7) -> Adopters(10) or Rejected(8)/Waitlist(9)/Flagged(11)
// Separate signup lists: Newsletter(12), Litter Waitlist(13) — public opt-in, not part of adoption pipeline
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

        // Get active litter info for Brevo
        const activeLitter = await env.DB.prepare("SELECT litter_code, sire_name, dam_name, born_date FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        const litterInfo = activeLitter ? activeLitter.litter_code + ' (' + activeLitter.sire_name + ' x ' + activeLitter.dam_name + ', born ' + activeLitter.born_date + ')' : '';

        // Sync to Brevo CRM
        await syncToBrevoCRM({ name, email, phone, source: 'contact', status: 'new' }, BREVO_LISTS.leads, {
          LITTER_INFO: litterInfo
        });

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

        // Get active litter info for Brevo
        const activeLitter = await env.DB.prepare("SELECT litter_code, sire_name, dam_name, born_date FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        const litterInfo = activeLitter ? activeLitter.litter_code + ' (' + activeLitter.sire_name + ' x ' + activeLitter.dam_name + ', born ' + activeLitter.born_date + ')' : '';

        // Sync to Brevo CRM with kitten + litter info
        await syncToBrevoCRM({ name, email, phone, source: 'reservation', status: 'new' }, BREVO_LISTS.leads, {
          KITTEN_INTEREST: kitten || 'General interest',
          LITTER_INFO: litterInfo,
          LITTERS_APPLIED: activeLitter ? activeLitter.litter_code : ''
        });

        // Notify Deanna of new reservation
        await sendEmail('Deanna@blueskycattery.com', 'New Kitten Reservation: ' + name,
          'New kitten reservation request:\n\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || 'N/A') + '\nKitten: ' + (kitten || 'General') + '\n\nFull details:\n' + fields + '\n\n---\nView in admin portal: https://admin.blueskycattery.com', 'Deanna');

        // Auto-create account if password provided
        let accountToken = null;
        if (data.password && data.password.length >= 8) {
          const existingUser = await env.DB.prepare('SELECT id, password_hash, status FROM users WHERE email = ?').bind(email).first();
          if (!existingUser) {
            const passwordHash = await hashPassword(data.password);
            const userResult = await env.DB.prepare(
              'INSERT INTO users (lead_id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(leadId, email, passwordHash, 'applicant', 'active', now(), now()).run();
            accountToken = await createSession(env.DB, userResult.meta.last_row_id, 'applicant');
            await updateBrevoContact(email, { LEAD_STATUS: 'self_registered', APPLICANT_TYPE: 'applicant' }, [BREVO_LISTS.approved], []);
          } else if (existingUser.status === 'active') {
            // Existing account - try to log them in
            const valid = await verifyPassword(data.password, existingUser.password_hash);
            if (valid) {
              accountToken = await createSession(env.DB, existingUser.id, 'applicant');
            }
          }
        }

        return json({ success: true, message: 'Reservation saved', token: accountToken });
      }

      // Public kitten availability for website
      if (path === '/api/kittens/status' && method === 'GET') {
        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ kittens: [] });
        const kittens = await env.DB.prepare('SELECT number, name, color, sex, status, reserved_by FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
        return json({ litter_code: litter.litter_code, kittens: kittens.results });
      }

      // Public litter info for website
      if (path === '/api/litter' && method === 'GET') {
        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ litter: null });
        const kittens = await env.DB.prepare('SELECT number, name, color, sex, status, photo_url FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
        return json({ litter: { ...litter, kittens: kittens.results } });
      }

      // Public: application questions (for dynamic form rendering)
      if (path === '/api/questions' && method === 'GET') {
        const questions = await env.DB.prepare("SELECT section, label, field_name, field_type, options, required, hint, sort_order FROM app_questions WHERE active = 1 ORDER BY sort_order ASC").all();
        return json({ questions: questions.results });
      }

      // Public config (website-safe settings only)
      if (path === '/api/config' && method === 'GET') {
        const safeKeys = ['cattery_name','cattery_tagline','cattery_location','cattery_email','cattery_registration','deposit_amount','kitten_base_price','go_home_weeks','current_litter'];
        const config = {};
        for (const key of safeKeys) {
          const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
          if (row) config[key] = row.value;
        }
        return json({ config });
      }

      // Public cat profiles
      if (path === '/api/cats' && method === 'GET') {
        const cats = await env.DB.prepare("SELECT * FROM cats WHERE status = 'active' ORDER BY sort_order").all();
        return json({ cats: cats.results });
      }

      // Newsletter / Waitlist signup (public, no auth)
      if (path === '/api/signup' && method === 'POST') {
        const data = await parseBody(request);
        const { name, email, type } = data; // type: "newsletter" or "waitlist" or "both"
        if (!email) return json({ error: 'Email required' }, 400);

        const firstName = (name || '').split(' ')[0] || '';
        const lastName = (name || '').split(' ').slice(1).join(' ') || '';
        const lists = [];
        if (type === 'newsletter' || type === 'both') lists.push(12); // Newsletter (public opt-in, NOT CRM waitlist)
        if (type === 'waitlist' || type === 'both') lists.push(13); // Litter Waitlist (public opt-in for new litter alerts, NOT application waitlist list 9)
        if (lists.length === 0) lists.push(12); // Default to newsletter

        // Add to Brevo
        if (_brevoKey) {
          await fetch('https://api.brevo.com/v3/contacts', {
            method: 'POST',
            headers: { 'api-key': _brevoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              attributes: { FIRSTNAME: firstName, LASTNAME: lastName, LEAD_SOURCE: 'signup_' + type, LEAD_STATUS: 'subscribed' },
              listIds: lists,
              updateEnabled: true
            })
          });
        }

        // Also create a lead in D1
        const existing = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(email).first();
        if (!existing) {
          await env.DB.prepare('INSERT INTO leads (name, email, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(name || email, email, 'signup_' + type, 'subscribed', now(), now()).run();
        }

        return json({ success: true, message: 'Signed up successfully!' });
      }

      // Account self-disable (applicant can disable their own account)
      if (path === '/api/auth/disable-account' && method === 'POST') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);

        // Mark user as disabled in D1
        await env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind('disabled', now(), session.user_id).run();

        // Mark in Brevo as blacklisted (stops all emails)
        const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
        if (user && _brevoKey) {
          await fetch('https://api.brevo.com/v3/contacts/' + encodeURIComponent(user.email), {
            method: 'PUT',
            headers: { 'api-key': _brevoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailBlacklisted: true, attributes: { LEAD_STATUS: 'disabled' } })
          });
        }

        // Delete session
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.user_id).run();

        return json({ success: true, message: 'Account disabled. No further emails will be sent.' });
      }

      // Redirect old admin URL to new admin domain
      if (path === '/admin' || path === '/admin/') {
        return new Response(null, { status: 301, headers: { 'Location': 'https://admin.blueskycattery.com/' } });
      }

      // Brevo inbound email webhook
      if (path === '/api/webhook/inbound-email' && method === 'POST') {
        const payload = await parseBody(request);
        const items = payload.items || [payload];
        for (const item of items) {
          const fromEmail = (item.From || item.from || {}).Address || (item.From || item.from || '');
          const subject = item.Subject || item.subject || 'Reply';
          const body = item.ExtractedMarkdownMessage || item.RawTextBody || item.rawTextBody || '';
          const attachments = item.Attachments || item.attachments || [];

          // Check for image attachments from admin emails
          const imageAttachments = attachments.filter(a => {
            const ct = (a.ContentType || a.contentType || '').toLowerCase();
            return ct.startsWith('image/');
          });

          // Process photo attachments - match filenames to kitten/cat names
          if (imageAttachments.length > 0) {
            const adminEmails = ['deanna@blueskycattery.com', 'kkomlosy@gmail.com', 'stuckeydeanna3@gmail.com'];
            const isAdmin = adminEmails.includes(fromEmail.toLowerCase());

            if (isAdmin) {
              // Ensure photos table exists
              try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, r2_key TEXT NOT NULL, filename TEXT, sort_order INTEGER DEFAULT 0, uploaded_at TEXT, source TEXT DEFAULT \'admin\')').run(); } catch(e) {}

              const matched = [];
              const unmatched = [];

              for (const att of imageAttachments) {
                const filename = att.Name || att.name || 'photo.jpg';
                const content = att.Content || att.content || '';
                if (!content) { unmatched.push(filename + ' (no data)'); continue; }

                // Extract name from filename: "Hannah2.jpg" -> "Hannah", "Chili_3.png" -> "Chili"
                const baseName = filename.replace(/\.[^.]+$/, '').replace(/[\d_\-\s]+$/, '').trim();

                // Try to match to kitten first, then cat
                let entityType = null, entityId = null, entityName = null;
                const kitten = await env.DB.prepare('SELECT id, name FROM kittens WHERE LOWER(name) = LOWER(?)').bind(baseName).first();
                if (kitten) {
                  entityType = 'kitten'; entityId = kitten.id; entityName = kitten.name;
                } else {
                  const cat = await env.DB.prepare('SELECT id, name FROM cats WHERE LOWER(name) = LOWER(?)').bind(baseName).first();
                  if (cat) { entityType = 'cat'; entityId = cat.id; entityName = cat.name; }
                }

                if (entityType && entityId) {
                  const ext = filename.split('.').pop().toLowerCase();
                  const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
                  const r2Key = entityType + 's/' + entityId + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;

                  // Decode and upload to R2
                  const binary = Uint8Array.from(atob(content), c => c.charCodeAt(0));
                  await env.PHOTOS.put(r2Key, binary, { httpMetadata: { contentType } });

                  // Insert photo record
                  const maxSort = await env.DB.prepare('SELECT MAX(sort_order) as m FROM photos WHERE entity_type = ? AND entity_id = ?').bind(entityType, entityId).first();
                  const sortOrder = (maxSort && maxSort.m !== null) ? maxSort.m + 1 : 0;
                  await env.DB.prepare('INSERT INTO photos (entity_type, entity_id, r2_key, filename, sort_order, uploaded_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .bind(entityType, entityId, r2Key, filename, sortOrder, now(), 'email').run();

                  // Update entity photo_url if first photo
                  if (sortOrder === 0) {
                    const table = entityType === 'cat' ? 'cats' : 'kittens';
                    await env.DB.prepare('UPDATE ' + table + ' SET photo_url = ?, updated_at = ? WHERE id = ?')
                      .bind('https://portal.blueskycattery.com/photos/' + r2Key, now(), entityId).run();
                  }

                  matched.push(filename + ' -> ' + entityType + ' ' + entityName);
                } else {
                  // Store as unassigned - admin can assign later from Todo page
                  const ext = filename.split('.').pop().toLowerCase();
                  const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
                  const r2Key = 'unassigned/' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
                  const binary = Uint8Array.from(atob(content), c => c.charCodeAt(0));
                  await env.PHOTOS.put(r2Key, binary, { httpMetadata: { contentType } });
                  await env.DB.prepare('INSERT INTO photos (entity_type, entity_id, r2_key, filename, sort_order, uploaded_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .bind('unassigned', 0, r2Key, filename, 0, now(), 'email').run();
                  unmatched.push(filename + ' (saved as unassigned - assign in admin portal)');
                }
              }

              // Send confirmation back to sender
              let report = 'Photo intake processed ' + imageAttachments.length + ' image(s).\n\n';
              if (matched.length) report += 'MATCHED:\n' + matched.map(m => '  ✓ ' + m).join('\n') + '\n\n';
              if (unmatched.length) report += 'NOT MATCHED (upload manually via admin portal):\n' + unmatched.map(u => '  ✗ ' + u).join('\n') + '\n';
              report += '\n---\nManage all photos: https://admin.blueskycattery.com';

              await sendEmail(fromEmail, 'Photo Upload Report', report, 'Admin');

              // Still process any text message content as a regular inbound
              if (body && body.trim().length > 20) {
                const lead = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(fromEmail).first();
                if (lead) {
                  await env.DB.prepare('INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
                    .bind(lead.id, 'inbound_reply', subject, body, now()).run();
                }
              }

              continue; // Skip normal reply processing for photo emails
            }
          }

          // Normal reply processing (non-photo emails)
          if (fromEmail) {
            const lead = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(fromEmail).first();
            if (lead) {
              await env.DB.prepare('INSERT INTO messages (lead_id, direction, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
                .bind(lead.id, 'inbound_reply', subject, body, now()).run();
            }
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
      // Forgot password - send reset email
      if (path === '/api/auth/forgot-password' && method === 'POST') {
        const { email } = await parseBody(request);
        if (!email) return json({ error: 'Email required' }, 400);
        const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND status = ?').bind(email, 'active').first();
        if (!user) {
          // Don't reveal whether email exists
          return json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
        }
        const resetToken = generateToken();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
        await env.DB.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').bind(resetToken, expires, user.id).run();

        const resetUrl = (user.role === 'admin' ? 'https://admin.blueskycattery.com' : 'https://portal.blueskycattery.com') + '/?reset=' + resetToken;
        await sendEmail(email, 'Blue Sky Cattery - Password Reset',
          'You requested a password reset for your Blue Sky Cattery account.\n\nClick this link to reset your password (expires in 1 hour):\n' + resetUrl + '\n\nIf you did not request this, you can safely ignore this email.\n\n- Blue Sky Cattery', user.email);

        return json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
      }

      // Reset password with token
      if (path === '/api/auth/reset-password' && method === 'POST') {
        const { token: resetToken, password } = await parseBody(request);
        if (!resetToken || !password) return json({ error: 'Token and new password required' }, 400);
        if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

        const user = await env.DB.prepare('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?').bind(resetToken, now()).first();
        if (!user) return json({ error: 'Invalid or expired reset link. Please request a new one.' }, 400);

        const hash = await hashPassword(password);
        await env.DB.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, updated_at = ? WHERE id = ?').bind(hash, now(), user.id).run();

        return json({ success: true, message: 'Password has been reset. You can now log in.' });
      }

      // Self-registration (from portal login page)
      if (path === '/api/auth/register' && method === 'POST') {
        const data = await parseBody(request);
        const { name, email, password } = data;

        if (!name || !email || !password) {
          return json({ error: 'Name, email, and password are required' }, 400);
        }
        if (password.length < 8) {
          return json({ error: 'Password must be at least 8 characters' }, 400);
        }

        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existingUser) {
          return json({ error: 'An account already exists with this email. Please log in instead.' }, 400);
        }

        let leadId;
        const existingLead = await env.DB.prepare('SELECT id FROM leads WHERE email = ?').bind(email).first();
        if (existingLead) {
          leadId = existingLead.id;
          await env.DB.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').bind(now(), leadId).run();
        } else {
          const result = await env.DB.prepare(
            'INSERT INTO leads (name, email, phone, subject, message, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(name, email, null, 'Self Registration', 'Registered via portal', 'self_register', 'new', now(), now()).run();
          leadId = result.meta.last_row_id;
        }

        const passwordHash = await hashPassword(password);
        const userResult = await env.DB.prepare(
          'INSERT INTO users (lead_id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(leadId, email, passwordHash, 'applicant', 'active', now(), now()).run();
        const userId = userResult.meta.last_row_id;

        const sessionToken = await createSession(env.DB, userId, 'applicant');

        // Sync to Brevo
        await syncToBrevoCRM({ name, email, source: 'self_register', status: 'new' }, BREVO_LISTS.leads, {});
        await updateBrevoContact(email, { LEAD_STATUS: 'self_registered', APPLICANT_TYPE: 'applicant' }, [BREVO_LISTS.approved], [BREVO_LISTS.leads]);

        // Notify admin
        await sendEmail('Deanna@blueskycattery.com', 'New Self-Registration: ' + name,
          'A new user registered directly on the portal.\n\nName: ' + name + '\nEmail: ' + email + '\n\nThey now have access to fill out the adoption application.\n\n---\nView in admin portal: https://admin.blueskycattery.com', 'Deanna');

        return json({ success: true, token: sessionToken });
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

      // Save application draft
      if (path === '/api/application/draft' && method === 'POST') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const data = await request.json();
        // Save draft to user record
        const existing = await env.DB.prepare('SELECT id FROM applications WHERE user_id = ? AND status = ?').bind(session.user_id, 'draft').first();
        if (existing) {
          await env.DB.prepare('UPDATE applications SET draft_data = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(data), now(), existing.id).run();
        } else {
          await env.DB.prepare('INSERT INTO applications (user_id, draft_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .bind(session.user_id, JSON.stringify(data), 'draft', now(), now()).run();
        }
        return json({ success: true, message: 'Draft saved' });
      }

      // Get draft
      if (path === '/api/application/draft' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const draft = await env.DB.prepare('SELECT draft_data FROM applications WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').bind(session.user_id, 'draft').first();
        if (draft && draft.draft_data) {
          return json({ draft: JSON.parse(draft.draft_data) });
        }
        return json({ draft: null });
      }

      // Get user profile (from lead record)
      if (path === '/api/profile' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const user = await env.DB.prepare('SELECT lead_id, email FROM users WHERE id = ?').bind(session.user_id).first();
        if (!user || !user.lead_id) return json({ profile: { email: user ? user.email : '' } });
        const lead = await env.DB.prepare('SELECT name, email, phone, home_address, marital_status, partner_name, partner_email FROM leads WHERE id = ?').bind(user.lead_id).first();
        return json({ profile: lead || { email: user.email } });
      }

      // Update user profile (updates lead record)
      if (path === '/api/profile' && method === 'PUT') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const user = await env.DB.prepare('SELECT lead_id, email FROM users WHERE id = ?').bind(session.user_id).first();
        if (!user || !user.lead_id) return json({ error: 'No profile found' }, 404);
        const data = await parseBody(request);
        const fields = [];
        const values = [];
        if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
        if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
        if (data.home_address !== undefined) { fields.push('home_address = ?'); values.push(data.home_address); }
        if (data.marital_status !== undefined) { fields.push('marital_status = ?'); values.push(data.marital_status); }
        if (data.partner_name !== undefined) { fields.push('partner_name = ?'); values.push(data.partner_name); }
        if (data.partner_email !== undefined) { fields.push('partner_email = ?'); values.push(data.partner_email); }
        if (fields.length === 0) return json({ success: true });
        fields.push('updated_at = ?'); values.push(now());
        values.push(user.lead_id);
        await env.DB.prepare('UPDATE leads SET ' + fields.join(', ') + ' WHERE id = ?').bind(...values).run();
        return json({ success: true });
      }

      // Get my application (strip score data - admin only)
      if (path === '/api/application' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const app = await env.DB.prepare('SELECT id, user_id, kitten_preference, full_name, email, phone, city_state, housing_type, status, admin_notes, created_at, updated_at FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(session.user_id).first();
        return json({ application: app });
      }

      // =====================
      // PHOTO SERVING FROM R2
      // =====================

      if (path.startsWith('/photos/')) {
        const key = path.slice(8); // strip /photos/
        if (!key) return new Response('Not found', { status: 404 });
        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }

      // Public photos list (for website)
      if (path.match(/^\/api\/photos\/(cat|kitten)\/\d+$/) && method === 'GET') {
        const parts = path.split('/');
        const entityType = parts[3];
        const entityId = parts[4];
        const photos = await env.DB.prepare('SELECT id, r2_key, sort_order FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY sort_order ASC').bind(entityType, entityId).all();
        const photoList = photos.results.map(p => ({
          id: p.id,
          url: 'https://portal.blueskycattery.com/photos/' + p.r2_key,
          sort_order: p.sort_order
        }));
        return json({ photos: photoList });
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
// APPLICANT PORTAL HTML (Dynamic Multi-Step)
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
.card table{width:100%}.card table th,.card table td{text-align:left;padding:10px 12px;font-size:.88rem;border-bottom:1px solid #e8e2d8}.card table th{font-weight:600;color:#6B5B4B;font-size:.8rem;text-transform:uppercase;letter-spacing:.5px}.card table tr:last-child td{border-bottom:none}
@media(max-width:600px){.form-row{grid-template-columns:1fr}#subsGrid{grid-template-columns:1fr!important}}
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
  // Check for reset token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('reset');

  if (resetToken) {
    return renderResetPassword(resetToken);
  }

  document.getElementById('app').innerHTML = \`
  <div class="login-page">
    <div class="login-box">
      <h1>Application Portal</h1>
      <div class="sub">Blue Sky Cattery</div>
      <div id="loginError" class="error hidden"></div>
      <div id="loginSuccess" class="error hidden" style="color:#7A8B6F"></div>
      <form id="loginForm">
        <input type="email" id="loginEmail" placeholder="Email" required>
        <input type="password" id="loginPass" placeholder="Password" required>
        <button type="submit" class="btn btn-primary" style="width:100%">Sign In</button>
      </form>
      <div style="text-align:center;margin-top:12px">
        <a href="#" id="forgotLink" style="color:#A0522D;font-size:.85rem">Forgot your password?</a>
      </div>
      <div id="forgotForm" style="display:none;margin-top:16px">
        <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:8px">Enter your email and we will send you a password reset link.</p>
        <input type="email" id="forgotEmail" placeholder="Email address" style="width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:8px">
        <button class="btn btn-primary" id="forgotBtn" style="width:100%">Send Reset Link</button>
      </div>
      <p style="margin-top:16px;font-size:.82rem;color:#6B5B4B;text-align:center">Don't have an account? <a href="#" id="registerLink" style="color:#A0522D;font-weight:600">Create one here</a></p>
      <div id="registerForm" style="display:none;margin-top:16px">
        <h2 style="font-size:1.2rem;margin-bottom:4px;color:#3E3229">Create Account</h2>
        <p style="font-size:.82rem;color:#6B5B4B;margin-bottom:12px">Create your account to apply for kitten adoption, sign up for newsletters, and receive litter notifications.</p>
        <div id="registerError" class="error hidden"></div>
        <input type="text" id="registerName" placeholder="Full Name" required style="width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:12px">
        <input type="email" id="registerEmail" placeholder="Email" required style="width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:12px">
        <input type="password" id="registerPass" placeholder="Password (min 8 characters)" required minlength="8" style="width:100%;padding:12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;margin-bottom:12px">
        <button class="btn btn-primary" id="registerBtn" style="width:100%">Create Account</button>
        <p style="margin-top:8px;font-size:.82rem;color:#6B5B4B;text-align:center">Already have an account? <a href="#" id="backToLogin" style="color:#A0522D">Sign in</a></p>
      </div>
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
      window.history.replaceState({}, '', '/');
      renderPortal();
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
    const res = await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    document.getElementById('forgotForm').innerHTML = '<p style="color:#7A8B6F;font-size:.9rem;text-align:center;padding:12px">If an account exists with that email, a password reset link has been sent. Check your inbox (and spam folder).</p>';
  };

  document.getElementById('registerLink').onclick = (e) => {
    e.preventDefault();
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('forgotLink').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
  };

  document.getElementById('backToLogin').onclick = (e) => {
    e.preventDefault();
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('forgotLink').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
  };

  document.getElementById('registerBtn').onclick = async () => {
    const name = document.getElementById('registerName').value;
    const email = document.getElementById('registerEmail').value;
    const pass = document.getElementById('registerPass').value;
    if (!name || !email || !pass) return;
    if (pass.length < 8) {
      document.getElementById('registerError').textContent = 'Password must be at least 8 characters';
      document.getElementById('registerError').classList.remove('hidden');
      return;
    }
    const btn = document.getElementById('registerBtn');
    btn.disabled = true; btn.textContent = 'Creating account...';
    const res = await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password: pass }) });
    if (res.success) {
      authToken = res.token;
      localStorage.setItem('bsc_portal_token', res.token);
      renderPortal();
    } else {
      document.getElementById('registerError').textContent = res.error || 'Registration failed';
      document.getElementById('registerError').classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Create Account';
    }
  };
}

function renderResetPassword(token) {
  document.getElementById('app').innerHTML = \`
  <div class="login-page">
    <div class="login-box">
      <h1>Reset Password</h1>
      <div class="sub">Blue Sky Cattery</div>
      <div id="resetError" class="error hidden"></div>
      <div id="resetSuccess" style="display:none;color:#7A8B6F;text-align:center;padding:16px"></div>
      <form id="resetForm">
        <input type="password" id="newPass" placeholder="New password (min 8 characters)" required minlength="8">
        <input type="password" id="confirmPass" placeholder="Confirm new password" required minlength="8">
        <button type="submit" class="btn btn-primary" style="width:100%">Set New Password</button>
      </form>
    </div>
  </div>\`;

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
      document.getElementById('resetSuccess').innerHTML = 'Password has been reset successfully!<br><br><a href="/" style="color:#A0522D;font-weight:600">Click here to log in</a>';
      window.history.replaceState({}, '', '/');
    } else {
      document.getElementById('resetError').textContent = res.error || 'Reset failed';
      document.getElementById('resetError').classList.remove('hidden');
    }
  };
}

async function renderPortal() {
  const me = await api('/auth/me');
  if (!me.user) { authToken = null; localStorage.removeItem('bsc_portal_token'); return renderLogin(); }

  const [appRes, litterRes, profileRes] = await Promise.all([api('/application'), api('/litter'), api('/profile')]);
  const existing = appRes.application;
  const litter = litterRes.litter;
  const profile = profileRes.profile || {};

  let appContent = '';
  if (existing) {
    const statusMap = { submitted: 'Your application is under review', reviewed: 'Your application has been reviewed', approved: 'Congratulations! Your application has been approved!', rejected: 'Unfortunately, your application was not approved at this time.' };
    appContent = \`<div class="card"><div class="status-card">
      <div style="font-size:2.5rem;margin-bottom:12px">\${existing.status === 'approved' ? '&#127881;' : existing.status === 'rejected' ? '&#128532;' : '&#128203;'}</div>
      <h2>Application \${existing.status.charAt(0).toUpperCase() + existing.status.slice(1)}</h2>
      <p>\${statusMap[existing.status] || 'Status: ' + existing.status}</p>
      <p style="font-size:.85rem;color:#6B5B4B">Submitted: \${existing.created_at}</p>
    </div></div>\`;
  } else {
    appContent = await renderApplicationForm();
  }

  // Current litter info
  let litterContent = '';
  if (litter) {
    const kittens = litter.kittens || [];
    const statusColors = { available: '#7A8B6F', reserved: '#D4AF37', pending: '#87A5B4', sold: '#8B3A3A' };
    let kittenRows = '';
    kittens.forEach(k => {
      const color = statusColors[k.status] || '#6B5B4B';
      const sexIcon = k.sex === 'male' ? '&#9794;' : k.sex === 'female' ? '&#9792;' : '?';
      kittenRows += '<tr><td><strong>' + (k.name || 'Kitten #' + k.number) + '</strong></td><td>' + sexIcon + ' ' + (k.sex || 'TBD') + '</td><td>' + (k.color || 'Developing') + '</td><td><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:700;color:#fff;background:' + color + ';text-transform:uppercase">' + k.status + '</span></td></tr>';
    });
    litterContent = \`<div class="card" style="margin-top:20px">
      <h2 style="margin-bottom:4px">Current Litter: \${litter.litter_code || ''}</h2>
      <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:16px">\${litter.sire_name || ''} x \${litter.dam_name || ''} &mdash; Born: \${litter.born_date || 'TBD'} &mdash; Go-Home: \${litter.go_home_date || 'TBD'}</p>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:2px solid #D4C5A9"><th style="text-align:left;padding:8px;font-size:.85rem">Name</th><th style="text-align:left;padding:8px;font-size:.85rem">Sex</th><th style="text-align:left;padding:8px;font-size:.85rem">Color</th><th style="text-align:left;padding:8px;font-size:.85rem">Status</th></tr></thead>
        <tbody>\${kittenRows}</tbody>
      </table>
    </div>\`;
  }

  // Subscription preferences
  const subsContent = \`<div class="card" style="margin-top:20px">
    <h2 style="margin-bottom:4px">Stay Connected</h2>
    <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:16px">Manage your email preferences below.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" id="subsGrid">
      <div style="padding:20px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:10px;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:8px">&#128231;</div>
        <h3 style="font-size:.95rem;margin-bottom:4px">Newsletter</h3>
        <p style="font-size:.82rem;color:#6B5B4B;margin-bottom:12px">Cattery updates, cat care tips, and the occasional adorable photo.</p>
        <button class="btn btn-primary" style="width:100%;font-size:.85rem" id="subNewsletter" onclick="toggleSub('newsletter')">Subscribe</button>
      </div>
      <div style="padding:20px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:10px;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:8px">&#128049;</div>
        <h3 style="font-size:.95rem;margin-bottom:4px">Litter Notifications</h3>
        <p style="font-size:.82rem;color:#6B5B4B;margin-bottom:12px">Be the first to know when new kittens are born or available.</p>
        <button class="btn btn-primary" style="width:100%;font-size:.85rem" id="subWaitlist" onclick="toggleSub('waitlist')">Join Waitlist</button>
      </div>
    </div>
  </div>\`;

  // Profile section
  const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const profileContent = \`<div class="card" style="margin-top:20px">
    <h2 style="margin-bottom:4px">My Profile</h2>
    <p style="font-size:.85rem;color:#6B5B4B;margin-bottom:16px">Keep your contact information up to date. This info will auto-fill your adoption application.</p>
    <div id="profileMsg" style="display:none;padding:10px 14px;border-radius:6px;margin-bottom:12px;font-size:.88rem"></div>
    <div class="form-row">
      <div class="form-group"><label>Full Name</label><input type="text" id="profName" value="\${esc(profile.name)}"></div>
      <div class="form-group"><label>Email</label><input type="email" id="profEmail" value="\${esc(me.user.email)}" disabled style="background:#f0ece6;color:#6B5B4B"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Phone</label><input type="tel" id="profPhone" value="\${esc(profile.phone)}"></div>
      <div class="form-group"><label>Home Address</label><input type="text" id="profAddress" value="\${esc(profile.home_address)}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Marital Status</label>
        <select id="profMarital">
          <option value="">Select...</option>
          <option value="Single"\${profile.marital_status === 'Single' ? ' selected' : ''}>Single</option>
          <option value="Married"\${profile.marital_status === 'Married' ? ' selected' : ''}>Married</option>
          <option value="Partnered"\${profile.marital_status === 'Partnered' ? ' selected' : ''}>Partnered</option>
          <option value="Other"\${profile.marital_status === 'Other' ? ' selected' : ''}>Other</option>
        </select>
      </div>
      <div class="form-group"><label>Partner Name</label><input type="text" id="profPartner" value="\${esc(profile.partner_name)}"></div>
    </div>
    <div class="form-group"><label>Partner Email</label><input type="email" id="profPartnerEmail" value="\${esc(profile.partner_email)}" style="max-width:50%"></div>
    <button class="btn btn-primary" id="saveProfileBtn" onclick="saveProfile()" style="margin-top:8px">Save Profile</button>
  </div>\`;

  document.getElementById('app').innerHTML = \`
  <header><div class="container top-bar">
    <div><h1>My Portal</h1><div class="sub">\${me.user.email}</div></div>
    <div style="display:flex;gap:12px;align-items:center">
      <a href="https://blueskycattery.com" style="color:#C8B88A;font-size:.8rem;text-decoration:none">Back to Website</a>
      <button class="btn btn-outline" onclick="logout()">Logout</button>
    </div>
  </div></header>
  <div class="container">
    \${appContent}
    \${litterContent}
    \${profileContent}
    \${subsContent}
    <div style="text-align:center;margin:24px 0 40px"><a href="#" onclick="disableAccount();return false" style="color:#999;font-size:.78rem;text-decoration:none">Disable my account &amp; unsubscribe from all emails</a></div>
  </div>\`;

  // If showing the wizard, render the first step
  if (!existing && document.getElementById('appContainer')) {
    renderWizard();
  }
}

// Conditional logic: which fields show based on other answers
const CONDITIONS = {
  partner_name: { field: 'has_partner', value: 'Yes' },
  partner_email: { field: 'has_partner', value: 'Yes' },
  partner_phone: { field: 'has_partner', value: 'Yes' },
  landlord_info: { field: 'housing_own_rent', value: 'Rent' },
  surrender_details: { field: 'surrender_history', value: 'Yes' }
};

let formData = {};
let allQuestions = [];
let sections = [];
let currentStep = 0;

async function loadQuestions() {
  const res = await api('/questions');
  allQuestions = res.questions || [];
  // Group by section
  const sectionMap = {};
  allQuestions.forEach(q => {
    if (!sectionMap[q.section]) sectionMap[q.section] = [];
    sectionMap[q.section].push(q);
  });
  sections = Object.keys(sectionMap).map(name => ({ name, questions: sectionMap[name] }));
}

async function loadDraft() {
  // Pre-fill from profile first, then overlay draft data on top
  const [draftRes, profileRes] = await Promise.all([api('/application/draft'), api('/profile')]);
  const profile = profileRes.profile || {};
  // Map profile fields to application field names
  if (profile.name && !formData.full_name) formData.full_name = profile.name;
  if (profile.email && !formData.email) formData.email = profile.email;
  if (profile.phone && !formData.phone) formData.phone = profile.phone;
  if (profile.home_address && !formData.home_address) formData.home_address = profile.home_address;
  if (profile.marital_status && !formData.marital_status) formData.marital_status = profile.marital_status;
  if (profile.partner_name && !formData.partner_name) formData.partner_name = profile.partner_name;
  if (profile.partner_email && !formData.partner_email) formData.partner_email = profile.partner_email;
  // Draft data takes priority
  if (draftRes.draft) formData = { ...formData, ...draftRes.draft };
}

async function saveDraft() {
  collectCurrentStepData();
  await api('/application/draft', { method: 'POST', body: JSON.stringify(formData) });
}

function collectCurrentStepData() {
  const form = document.getElementById('wizardForm');
  if (!form) return;
  new FormData(form).forEach((v, k) => { if (v) formData[k] = v; });
}

function shouldShow(q) {
  const cond = CONDITIONS[q.field_name];
  if (!cond) return true;
  return formData[cond.field] === cond.value;
}

function renderWizard() {
  const section = sections[currentStep];
  const totalSteps = sections.length;
  const pct = Math.round(((currentStep) / totalSteps) * 100);

  // Count answered questions
  const totalQ = allQuestions.filter(q => q.required && shouldShow(q)).length;
  const answeredQ = allQuestions.filter(q => q.required && shouldShow(q) && formData[q.field_name]).length;
  const completePct = totalQ > 0 ? Math.round((answeredQ / totalQ) * 100) : 0;

  let html = '<div class="card">';
  html += '<h2>Adoption Application</h2>';

  // Progress bar
  html += '<div style="margin-bottom:24px">';
  html += '<div style="display:flex;justify-content:space-between;font-size:.82rem;color:#6B5B4B;margin-bottom:6px"><span>Step ' + (currentStep + 1) + ' of ' + totalSteps + ': ' + section.name + '</span><span>' + completePct + '% complete</span></div>';
  html += '<div style="background:#e8e2d8;border-radius:6px;height:10px;overflow:hidden"><div style="background:linear-gradient(90deg,#7A8B6F,#A0522D);height:10px;border-radius:6px;width:' + pct + '%;transition:width .4s ease"></div></div>';

  // Step indicators
  html += '<div style="display:flex;gap:4px;margin-top:8px">';
  sections.forEach((s, i) => {
    const color = i < currentStep ? '#7A8B6F' : i === currentStep ? '#A0522D' : '#D4C5A9';
    html += '<div style="flex:1;height:4px;border-radius:2px;background:' + color + '"></div>';
  });
  html += '</div></div>';

  // Form fields for this section
  html += '<form id="wizardForm">';
  const visibleQuestions = section.questions.filter(q => shouldShow(q));

  visibleQuestions.forEach(q => {
    const val = formData[q.field_name] || '';
    const req = q.required ? ' *' : '';

    html += '<div class="form-group">';
    html += '<label>' + q.label + req + '</label>';

    if (q.field_type === 'select' && q.options) {
      const opts = q.options.split('|');
      html += '<select name="' + q.field_name + '"' + (q.required ? ' required' : '') + '>';
      html += '<option value="">Select...</option>';
      opts.forEach(o => {
        html += '<option value="' + o + '"' + (val === o ? ' selected' : '') + '>' + o + '</option>';
      });
      html += '</select>';
    } else if (q.field_type === 'textarea') {
      html += '<textarea name="' + q.field_name + '" rows="3"' + (q.required ? ' required' : '') + '>' + val + '</textarea>';
    } else {
      html += '<input type="' + (q.field_type || 'text') + '" name="' + q.field_name + '" value="' + val + '"' + (q.required ? ' required' : '') + '>';
    }

    if (q.hint) html += '<div class="hint">' + q.hint + '</div>';
    html += '</div>';
  });
  html += '</form>';

  // Navigation buttons
  html += '<div style="display:flex;gap:12px;margin-top:20px">';
  if (currentStep > 0) {
    html += '<button class="btn btn-outline" onclick="prevStep()" style="flex:1">Back</button>';
  }
  html += '<button class="btn btn-outline" onclick="saveDraftBtn()" style="flex:0 0 auto;color:#87A5B4;border-color:#87A5B4">Save Progress</button>';
  if (currentStep < totalSteps - 1) {
    html += '<button class="btn btn-primary" onclick="nextStep()" style="flex:1">Continue</button>';
  } else {
    html += '<button class="btn btn-primary" onclick="submitApp()" style="flex:1">Submit Application</button>';
  }
  html += '</div>';

  // Consent text on last step
  if (currentStep === totalSteps - 1) {
    html += '<div style="background:#F5EDE0;padding:16px;border-radius:8px;margin:20px 0 0;font-size:.85rem;color:#6B5B4B"><strong>By submitting, you confirm:</strong><ul style="margin:8px 0 0 16px"><li>All information is truthful and accurate</li><li>False information is grounds for denial</li><li>You consent to us contacting your veterinarian</li><li>Submitting does not guarantee a kitten</li></ul></div>';
  }

  html += '</div>';
  document.getElementById('appContainer').innerHTML = html;

  // Add change listeners for conditional fields
  const form = document.getElementById('wizardForm');
  if (form) {
    form.querySelectorAll('select, input').forEach(el => {
      el.addEventListener('change', () => {
        collectCurrentStepData();
        // Re-render if this field controls visibility
        const affectsOthers = Object.values(CONDITIONS).some(c => c.field === el.name);
        if (affectsOthers) renderWizard();
      });
    });
  }
}

function nextStep() {
  const form = document.getElementById('wizardForm');
  if (form && !form.reportValidity()) return;
  collectCurrentStepData();
  currentStep++;
  renderWizard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function prevStep() {
  collectCurrentStepData();
  currentStep--;
  renderWizard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function saveDraftBtn() {
  collectCurrentStepData();
  const btn = event.target;
  btn.textContent = 'Saving...';
  btn.disabled = true;
  await api('/application/draft', { method: 'POST', body: JSON.stringify(formData) });
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = 'Save Progress'; btn.disabled = false; }, 2000);
}

async function submitApp() {
  const form = document.getElementById('wizardForm');
  if (form && !form.reportValidity()) return;
  collectCurrentStepData();

  if (!confirm('Are you ready to submit your application? You will not be able to edit it after submission.')) return;

  const res = await api('/application', { method: 'POST', body: JSON.stringify(formData) });
  if (res.success) {
    renderPortal();
  } else {
    alert(res.error || 'Failed to submit. Please try again.');
  }
}

async function renderApplicationForm() {
  await loadQuestions();
  await loadDraft();
  return '<div id="appContainer"></div>';
}

async function saveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const msg = document.getElementById('profileMsg');
  btn.disabled = true; btn.textContent = 'Saving...';
  const data = {
    name: document.getElementById('profName').value,
    phone: document.getElementById('profPhone').value,
    home_address: document.getElementById('profAddress').value,
    marital_status: document.getElementById('profMarital').value,
    partner_name: document.getElementById('profPartner').value,
    partner_email: document.getElementById('profPartnerEmail').value
  };
  const res = await api('/profile', { method: 'PUT', body: JSON.stringify(data) });
  if (res.success) {
    msg.style.display = 'block';
    msg.style.background = 'rgba(122,139,111,.1)';
    msg.style.color = '#5A6B4F';
    msg.textContent = 'Profile saved! This info will auto-fill your application.';
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save Profile'; btn.disabled = false; msg.style.display = 'none'; }, 3000);
  } else {
    msg.style.display = 'block';
    msg.style.background = 'rgba(139,58,58,.1)';
    msg.style.color = '#8B3A3A';
    msg.textContent = res.error || 'Failed to save';
    btn.textContent = 'Save Profile'; btn.disabled = false;
  }
}

async function toggleSub(type) {
  const btn = document.getElementById(type === 'newsletter' ? 'subNewsletter' : 'subWaitlist');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Signing up...';
  const me = await api('/auth/me');
  const res = await fetch(API + '/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: me.user.email, email: me.user.email, type })
  }).then(r => r.json());
  if (res.success) {
    btn.textContent = 'Subscribed!';
    btn.style.background = '#7A8B6F';
    btn.style.cursor = 'default';
  } else {
    btn.textContent = origText;
    btn.disabled = false;
    alert(res.error || 'Something went wrong');
  }
}

function logout() {
  api('/auth/logout', { method: 'POST' });
  authToken = null;
  localStorage.removeItem('bsc_portal_token');
  renderLogin();
}

async function disableAccount() {
  if (!confirm('Are you sure you want to disable your account? You will no longer receive emails from Blue Sky Cattery and will not be able to log in. Your application data will be retained.')) return;
  if (!confirm('This cannot be undone from your side. You would need to contact Blue Sky Cattery directly to re-enable your account. Proceed?')) return;
  const res = await api('/auth/disable-account', { method: 'POST' });
  if (res.success) {
    authToken = null;
    localStorage.removeItem('bsc_portal_token');
    document.getElementById('app').innerHTML = '<div class="login-page"><div class="login-box" style="text-align:center"><h1>Account Disabled</h1><p style="color:#6B5B4B;margin:16px 0">Your account has been disabled and no further emails will be sent. If you change your mind, please contact us at <a href="mailto:kittens@blueskycattery.com" style="color:#A0522D">kittens@blueskycattery.com</a>.</p><a href="https://blueskycattery.com" class="btn btn-primary">Return to Website</a></div></div>';
  }
}

// Init
(async () => {
  // Check for token from reservation redirect
  const urlParams = new URLSearchParams(window.location.search);
  const redirectToken = urlParams.get('token');
  if (redirectToken) {
    authToken = redirectToken;
    localStorage.setItem('bsc_portal_token', redirectToken);
    window.history.replaceState({}, '', '/');
  }

  if (authToken) {
    const me = await api('/auth/me');
    if (me.user) return renderPortal();
  }
  renderLogin();
})();
</script>
</body>
</html>`;
