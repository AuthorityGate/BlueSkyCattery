// ============================================
// Blue Sky Cattery - API Worker
// Cloudflare Worker + D1 Database
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
  // sendBeacon sends as text/plain
  const text = await request.text();
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// Simple in-memory token store (tokens last until worker restarts, ~30min)
// In production you'd use KV, but for this scale D1 works
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

// ---- Email Sending (via MailChannels or FormSubmit) ----

// BREVO_API_KEY is set as a Cloudflare Worker secret (env.BREVO_API_KEY)
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

        // Notify Deanna of new contact
        await sendEmail('Deanna@blueskycattery.com', 'New Contact: ' + name,
          'New contact form submission:\n\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || 'N/A') + '\nSubject: ' + (subject || 'General') + '\n\nMessage:\n' + message + '\n\n---\nView in admin portal: https://portal.blueskycattery.com/admin', 'Deanna');

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

        // Notify Deanna of new reservation
        await sendEmail('Deanna@blueskycattery.com', 'New Kitten Reservation: ' + name,
          'New kitten reservation request:\n\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + (phone || 'N/A') + '\nKitten: ' + (kitten || 'General') + '\n\nFull details:\n' + fields + '\n\n---\nView in admin portal: https://portal.blueskycattery.com/admin', 'Deanna');

        return json({ success: true, message: 'Reservation saved' });
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

        await env.DB.prepare(`
          INSERT INTO applications (user_id, kitten_preference, full_name, email, phone, city_state, housing_type, housing_own_rent, other_pets, cat_experience, why_oriental, indoor_only, household_members, work_schedule, vet_name, vet_phone, pet_history, surrender_history, allergies, timeline, additional_notes, landlord_info, pet_source, pet_health_history, vocal_comfort, adjustment_plan, rehome_circumstances, enrichment_plan, spay_neuter_opinion, financial_readiness, verify_cat_count, verify_home_description, how_found_us, surrender_details, kitten_primary, kitten_backup1, kitten_backup2, sex_preference, purpose, highlights, risks, score, score_breakdown, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          grading.score, JSON.stringify(grading.categories), 'submitted', now(), now()
        ).run();

        // Notify admin of new application
        await sendEmail('Deanna@blueskycattery.com', 'New Application Submitted: ' + data.full_name,
          'A new adoption application has been submitted.\n\nApplicant: ' + data.full_name + '\nEmail: ' + data.email + '\nScore: ' + grading.score + '/100\n\nReview in admin portal: https://portal.blueskycattery.com/admin', 'Deanna');

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
      // ADMIN ENDPOINTS
      // =====================

      // Admin: Get all leads
      if (path === '/api/admin/leads' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const leads = await env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
        return json({ leads: leads.results });
      }

      // Admin: Get single lead with messages
      if (path.match(/^\/api\/admin\/leads\/\d+$/) && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const leadId = path.split('/').pop();
        const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
        const messages = await env.DB.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at ASC').bind(leadId).all();
        return json({ lead, messages: messages.results });
      }

      // Admin: Approve lead -> create applicant account
      if (path === '/api/admin/approve' && method === 'POST') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);

        const { lead_id } = await request.json();
        const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(lead_id).first();
        if (!lead) return json({ error: 'Lead not found' }, 404);

        // Check if user already exists
        const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(lead.email).first();
        if (existingUser) return json({ error: 'User account already exists for this email' }, 400);

        // Generate password and create account
        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        await env.DB.prepare(
          'INSERT INTO users (lead_id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(lead_id, lead.email, passwordHash, 'applicant', 'active', now(), now()).run();

        // Update lead status
        await env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').bind('approved', now(), lead_id).run();

        // Send welcome email
        const emailBody = `Dear ${lead.name},\n\nThank you for your interest in Blue Sky Cattery! We're excited to invite you to complete our adoption application.\n\nYour login credentials:\nEmail: ${lead.email}\nPassword: ${password}\n\nPlease visit https://portal.blueskycattery.com to log in and complete your application.\n\nWe look forward to learning more about you!\n\nWarm regards,\nDeanna\nBlue Sky Cattery`;

        await sendEmail(lead.email, 'Welcome to Blue Sky Cattery - Application Portal Access', emailBody, lead.name);

        // Record the welcome email was sent
        await env.DB.prepare(
          'UPDATE users SET welcome_sent_at = ? WHERE email = ?'
        ).bind(now(), lead.email).run();

        return json({ success: true, message: 'Account created and welcome email sent', tempPassword: password });
      }

      // Admin: Get all applications
      if (path === '/api/admin/applications' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const apps = await env.DB.prepare(`
          SELECT a.*, u.email as user_email
          FROM applications a
          JOIN users u ON a.user_id = u.id
          ORDER BY a.created_at DESC
        `).all();
        return json({ applications: apps.results });
      }

      // Admin: Get single application
      if (path.match(/^\/api\/admin\/applications\/\d+$/) && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const appId = path.split('/').pop();
        const app = await env.DB.prepare('SELECT a.*, u.email as user_email FROM applications a JOIN users u ON a.user_id = u.id WHERE a.id = ?').bind(appId).first();
        return json({ application: app });
      }

      // Admin: Update application status/notes
      if (path.match(/^\/api\/admin\/applications\/\d+$/) && method === 'PUT') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const appId = path.split('/').pop();
        const { status, admin_notes } = await request.json();
        const adminUser = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.user_id).first();
        await env.DB.prepare('UPDATE applications SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
          .bind(status, admin_notes, adminUser.email, now(), now(), appId).run();
        return json({ success: true });
      }

      // Admin: Get litters with kittens
      if (path === '/api/admin/litters' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const litters = await env.DB.prepare('SELECT * FROM litters ORDER BY year DESC, dam_name ASC').all();
        const result = [];
        for (const litter of litters.results) {
          const kittens = await env.DB.prepare('SELECT * FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
          result.push({ ...litter, kittens: kittens.results });
        }
        return json({ litters: result });
      }

      // Admin: Update kitten status
      if (path.match(/^\/api\/admin\/kittens\/\d+$/) && method === 'PUT') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
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

      // Admin: Add a new litter
      if (path === '/api/admin/litters' && method === 'POST') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const data = await request.json();
        const code = data.year + '-' + data.dam_name;
        const result = await env.DB.prepare(
          'INSERT INTO litters (litter_code, year, dam_name, sire_name, born_date, go_home_date, total_kittens, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(code, data.year, data.dam_name, data.sire_name, data.born_date || null, data.go_home_date || null, data.total_kittens || 0, 'active', data.notes || null, now(), now()).run();
        const litterId = result.meta.last_row_id;
        // Auto-create kitten entries
        for (let i = 1; i <= (data.total_kittens || 0); i++) {
          await env.DB.prepare(
            'INSERT INTO kittens (litter_id, number, name, color, status, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(litterId, i, 'Kitten #' + i, 'TBD', 'available', 1800, now(), now()).run();
        }
        return json({ success: true, litter_id: litterId, litter_code: code });
      }

      // Admin: Top candidates per kitten
      if (path === '/api/admin/candidates' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);

        // Get all active kittens
        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ candidates: {} });
        const kittens = await env.DB.prepare('SELECT * FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();

        const candidates = {};
        for (const kitten of kittens.results) {
          const label = kitten.name || 'Kitten #' + kitten.number;
          // Find apps where this kitten is primary, backup1, or backup2
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

        // Also get "any" / sex-preference-only applicants
        const sexOnly = await env.DB.prepare(`
          SELECT id, full_name, email, score, purpose, sex_preference, kitten_primary, status, highlights, risks
          FROM applications
          WHERE (kitten_primary IS NULL OR kitten_primary = '' OR kitten_primary = 'No preference')
          ORDER BY score DESC
        `).all();
        candidates['No Specific Preference'] = sexOnly.results;

        return json({ candidates, litter_code: litter.litter_code });
      }

      // Admin: Dashboard stats
      if (path === '/api/admin/stats' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);

        const totalLeads = await env.DB.prepare('SELECT COUNT(*) as count FROM leads').first();
        const newLeads = await env.DB.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").first();
        const totalApps = await env.DB.prepare('SELECT COUNT(*) as count FROM applications').first();
        const pendingApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'submitted'").first();
        const avgScore = await env.DB.prepare('SELECT AVG(score) as avg FROM applications').first();
        const availableKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'available'").first();
        const reservedKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'reserved' OR status = 'pending'").first();
        const soldKittens = await env.DB.prepare("SELECT COUNT(*) as count FROM kittens WHERE status = 'sold'").first();

        return json({
          stats: {
            totalLeads: totalLeads.count,
            newLeads: newLeads.count,
            totalApplications: totalApps.count,
            pendingApplications: pendingApps.count,
            averageScore: Math.round(avgScore.avg || 0),
            availableKittens: availableKittens.count,
            reservedKittens: reservedKittens.count,
            soldKittens: soldKittens.count
          }
        });
      }

      // PUBLIC: Get active litter kitten statuses (for main website)
      if (path === '/api/kittens/status' && method === 'GET') {
        const litter = await env.DB.prepare("SELECT * FROM litters WHERE status = 'active' ORDER BY id DESC LIMIT 1").first();
        if (!litter) return json({ kittens: [] });
        const kittens = await env.DB.prepare('SELECT number, name, color, sex, status, reserved_by FROM kittens WHERE litter_id = ? ORDER BY number ASC').bind(litter.id).all();
        return json({ litter_code: litter.litter_code, kittens: kittens.results });
      }

      // Admin: Update lead status
      if (path.match(/^\/api\/admin\/leads\/\d+$/) && method === 'PUT') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);
        const leadId = path.split('/').pop();
        const { status } = await request.json();
        await env.DB.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), leadId).run();
        return json({ success: true });
      }

      // =====================
      // PORTAL PAGE SERVING
      // =====================

      // Serve admin portal
      if (path === '/admin' || path === '/admin/') {
        return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html' } });
      }

      // Serve applicant portal
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
nav.tabs{display:flex;gap:4px;margin:20px 0 0;border-bottom:2px solid #D4C5A9}
nav.tabs button{padding:10px 20px;border:none;background:transparent;cursor:pointer;font-weight:600;color:#6B5B4B;border-bottom:3px solid transparent;margin-bottom:-2px;transition:.2s}
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
.modal textarea,.modal select{width:100%;padding:8px 12px;border:1px solid #D4C5A9;border-radius:6px;font-size:.9rem;font-family:inherit}
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
@media(max-width:768px){.stats-grid{grid-template-columns:1fr 1fr}table{font-size:.8rem}th,td{padding:8px 10px}}
</style>
</head>
<body>
<div id="app"></div>
<script>
const API = window.location.origin + '/api';
let authToken = localStorage.getItem('bsc_admin_token');
let currentTab = 'dashboard';

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(API + path, { ...opts, headers });
  return res.json();
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'onclick' || k === 'onchange' || k === 'onsubmit') e[k] = v;
    else if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  });
  children.flat().forEach(c => { if (c) e.append(typeof c === 'string' ? c : c); });
  return e;
}

function badge(status) {
  const cls = { new:'badge-new', approved:'badge-approved', submitted:'badge-submitted', reviewed:'badge-reviewed', rejected:'badge-rejected', active:'badge-approved' };
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

async function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const box = el('div', { class: 'login-page' },
    el('div', { class: 'login-box' },
      el('h1', {}, 'Admin Portal'),
      el('div', { class: 'sub' }, 'Blue Sky Cattery'),
      el('div', { id: 'loginError', class: 'error hidden' }),
      el('form', { id: 'loginForm', onsubmit: async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const pass = document.getElementById('loginPass').value;
        const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
        if (res.success) {
          authToken = res.token;
          localStorage.setItem('bsc_admin_token', res.token);
          renderApp();
        } else {
          document.getElementById('loginError').textContent = res.error || 'Login failed';
          document.getElementById('loginError').classList.remove('hidden');
        }
      }},
        el('input', { type: 'email', id: 'loginEmail', placeholder: 'Email', required: 'true' }),
        el('input', { type: 'password', id: 'loginPass', placeholder: 'Password', required: 'true' }),
        el('button', { type: 'submit', class: 'btn btn-primary', style: 'width:100%' }, 'Sign In')
      )
    )
  );
  app.appendChild(box);
}

async function renderApp() {
  const me = await api('/auth/me');
  if (!me.user || me.user.role !== 'admin') { authToken = null; localStorage.removeItem('bsc_admin_token'); return renderLogin(); }

  const app = document.getElementById('app');
  app.innerHTML = '';

  const header = el('header', {},
    el('div', { class: 'container top-bar' },
      el('div', {},
        el('h1', {}, 'Blue Sky Cattery Admin'),
        el('div', { class: 'subtitle' }, me.user.email)
      ),
      el('button', { class: 'btn btn-outline', onclick: async () => { await api('/auth/logout', { method:'POST' }); authToken = null; localStorage.removeItem('bsc_admin_token'); renderLogin(); }}, 'Logout')
    )
  );
  app.appendChild(header);

  const nav = el('nav', { class: 'container tabs' },
    el('button', { class: currentTab==='dashboard'?'active':'', onclick: () => { currentTab='dashboard'; renderApp(); }}, 'Dashboard'),
    el('button', { class: currentTab==='leads'?'active':'', onclick: () => { currentTab='leads'; renderApp(); }}, 'Leads'),
    el('button', { class: currentTab==='applications'?'active':'', onclick: () => { currentTab='applications'; renderApp(); }}, 'Applications'),
    el('button', { class: currentTab==='kittens'?'active':'', onclick: () => { currentTab='kittens'; renderApp(); }}, 'Kittens')
  );
  app.appendChild(nav);

  const content = el('div', { class: 'container' });
  app.appendChild(content);

  if (currentTab === 'dashboard') await renderDashboard(content);
  else if (currentTab === 'leads') await renderLeads(content);
  else if (currentTab === 'applications') await renderApplications(content);
  else if (currentTab === 'kittens') await renderKittens(content);
}

async function renderDashboard(container) {
  const { stats } = await api('/admin/stats');
  const panel = el('div', { class: 'panel active' },
    el('h2', { style: 'margin:20px 0 4px' }, 'Dashboard'),
    el('div', { class: 'stats-grid' },
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.totalLeads), el('div', { class: 'label' }, 'Total Leads')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.newLeads), el('div', { class: 'label' }, 'New Leads')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.totalApplications), el('div', { class: 'label' }, 'Applications')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.pendingApplications), el('div', { class: 'label' }, 'Pending Review')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.averageScore), el('div', { class: 'label' }, 'Avg Score')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number', style: 'color:#7A8B6F' }, ''+stats.availableKittens), el('div', { class: 'label' }, 'Available')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number', style: 'color:#D4AF37' }, ''+stats.reservedKittens), el('div', { class: 'label' }, 'Reserved/Pending')),
      el('div', { class: 'stat-card' }, el('div', { class: 'number', style: 'color:#8B3A3A' }, ''+stats.soldKittens), el('div', { class: 'label' }, 'Sold'))
    )
  );
  container.appendChild(panel);
}

async function renderLeads(container) {
  const { leads } = await api('/admin/leads');
  const panel = el('div', { class: 'panel active' });
  panel.innerHTML = '<h2 style="margin:20px 0 12px">Leads & Contacts</h2>';

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Name</th><th>Email</th><th>Source</th><th>Status</th><th>When</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (leads || []).forEach(lead => {
    const tr = el('tr');
    tr.innerHTML = '<td><strong>'+lead.name+'</strong></td><td>'+lead.email+'</td><td>'+lead.source+'</td><td>'+badge(lead.status)+'</td><td>'+timeAgo(lead.created_at)+'</td>';
    const actionTd = el('td');
    const viewBtn = el('button', { class: 'btn btn-outline btn-sm', onclick: () => showLeadModal(lead.id) }, 'View');
    actionTd.appendChild(viewBtn);
    if (lead.status === 'new') {
      const approveBtn = el('button', { class: 'btn btn-success btn-sm', style: 'margin-left:6px', onclick: async () => {
        if (confirm('Approve ' + lead.name + '? This will create their account and send a welcome email.')) {
          const res = await api('/admin/approve', { method: 'POST', body: JSON.stringify({ lead_id: lead.id }) });
          if (res.success) { showApprovalModal(lead.name, lead.email, res.tempPassword); }
          else alert(res.error || 'Failed');
        }
      }}, 'Approve');
      actionTd.appendChild(approveBtn);
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (!leads || leads.length === 0) panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No leads yet. They\\'ll appear here when someone uses the contact or reservation form.</p>';
  container.appendChild(panel);
}

async function showLeadModal(leadId) {
  const { lead, messages } = await api('/admin/leads/' + leadId);
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2>' + lead.name + '</h2>' +
    '<div class="field"><label>Email</label><div class="value">' + lead.email + '</div></div>' +
    '<div class="field"><label>Phone</label><div class="value">' + (lead.phone || 'N/A') + '</div></div>' +
    '<div class="field"><label>Source</label><div class="value">' + lead.source + '</div></div>' +
    '<div class="field"><label>Status</label><div class="value">' + badge(lead.status) + '</div></div>' +
    '<div class="field"><label>Created</label><div class="value">' + lead.created_at + '</div></div>' +
    '<h3 style="margin:20px 0 8px">Messages</h3>';
  (messages || []).forEach(msg => {
    modal.innerHTML += '<div style="background:#F5EDE0;padding:12px;border-radius:8px;margin-bottom:8px;font-size:.88rem"><div style="font-size:.75rem;color:#6B5B4B;margin-bottom:4px">' + msg.created_at + ' - ' + msg.subject + '</div><pre style="white-space:pre-wrap;font-family:inherit">' + msg.body + '</pre></div>';
  });
  modal.innerHTML += '<div class="actions"><button class="btn btn-outline" onclick="this.closest(\\'.modal-bg\\').remove()">Close</button></div>';
  bg.appendChild(modal);
  document.body.appendChild(bg);
}

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
      candsHtml += '<h4 style="margin-bottom:8px;color:#A0522D">' + kittenName + ' <span style="font-size:.8rem;font-weight:400;color:#6B5B4B">(' + apps.length + ' applicant' + (apps.length !== 1 ? 's' : '') + ')</span></h4>';
      if (apps.length === 0) {
        candsHtml += '<p style="font-size:.85rem;color:#6B5B4B">No applicants yet</p>';
      } else {
        candsHtml += '<table style="margin:0"><thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Preference</th><th>Purpose</th><th>Status</th></tr></thead><tbody>';
        apps.forEach((a, i) => {
          const prefColor = a.preference === 'Primary' ? '#7A8B6F' : a.preference === 'Backup 1' ? '#D4AF37' : '#87A5B4';
          candsHtml += '<tr><td><strong>' + (i+1) + '</strong></td><td>' + (a.full_name||'N/A') + '</td><td>' + scoreEl(a.score) + '</td>';
          candsHtml += '<td><span style="padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;background:' + prefColor + ';color:#fff">' + a.preference + '</span></td>';
          candsHtml += '<td>' + (a.purpose || 'Pet') + '</td><td>' + badge(a.status) + '</td></tr>';
        });
        candsHtml += '</tbody></table>';
      }
      candsHtml += '</div>';
    });
    panel.innerHTML = candsHtml;
  }

  // All Applications
  panel.innerHTML += '<h2 style="margin:20px 0 12px">All Applications</h2>';

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Applicant</th><th>Score</th><th>Purpose</th><th>Primary Kitten</th><th>Sex Pref</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (applications || []).forEach(app => {
    const tr = el('tr');
    tr.innerHTML = '<td><strong>' + (app.full_name||'N/A') + '</strong><br><span style="font-size:.78rem;color:#6B5B4B">' + (app.user_email||app.email||'') + '</span></td>';
    tr.innerHTML += '<td>' + scoreEl(app.score) + '</td>';
    tr.innerHTML += '<td>' + (app.purpose || 'Pet') + '</td>';
    tr.innerHTML += '<td>' + (app.kitten_primary || '—') + '</td>';
    tr.innerHTML += '<td>' + (app.sex_preference || '—') + '</td>';
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
}

async function renderKittens(container) {
  const { litters } = await api('/admin/litters');
  const panel = el('div', { class: 'panel active' });
  panel.innerHTML = '<h2 style="margin:20px 0 12px">Litters & Kittens</h2>';

  if (!litters || litters.length === 0) {
    panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No litters yet.</p>';
  }

  (litters || []).forEach(litter => {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom:32px';

    let litterHtml = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    litterHtml += '<div><h3 style="font-size:1.15rem;margin:0">Litter ' + litter.litter_code + '</h3>';
    litterHtml += '<span style="font-size:.82rem;color:#6B5B4B">' + litter.sire_name + ' x ' + litter.dam_name + ' | Born: ' + (litter.born_date || 'TBD') + ' | Go-Home: ' + (litter.go_home_date || 'TBD') + '</span></div>';
    litterHtml += '<span class="badge badge-' + (litter.status === 'active' ? 'approved' : 'new') + '">' + litter.status + '</span></div>';

    const statusColors = { available: '#7A8B6F', reserved: '#D4AF37', pending: '#87A5B4', sold: '#8B3A3A' };

    litterHtml += '<table><thead><tr><th>#</th><th>Name</th><th>Color</th><th>Sex</th><th>Status</th><th>Reserved By</th><th>Price</th><th>Actions</th></tr></thead><tbody>';
    (litter.kittens || []).forEach(k => {
      const statusColor = statusColors[k.status] || '#6B5B4B';
      litterHtml += '<tr>';
      litterHtml += '<td><strong>' + k.number + '</strong></td>';
      litterHtml += '<td>' + (k.name || 'Kitten #' + k.number) + '</td>';
      litterHtml += '<td>' + (k.color || 'TBD') + '</td>';
      litterHtml += '<td>' + (k.sex || 'TBD') + '</td>';
      litterHtml += '<td><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:' + statusColor + ';color:#fff">' + k.status + '</span></td>';
      litterHtml += '<td>' + (k.reserved_by || '—') + '</td>';
      litterHtml += '<td>$' + (k.price || 1800) + '</td>';
      litterHtml += '<td><button class="btn btn-outline btn-sm" data-kitten-id="' + k.id + '">Edit</button></td>';
      litterHtml += '</tr>';
    });
    litterHtml += '</tbody></table>';

    section.innerHTML = litterHtml;

    // Attach edit handlers
    section.querySelectorAll('[data-kitten-id]').forEach(btn => {
      btn.onclick = () => showKittenEditModal(btn.getAttribute('data-kitten-id'), litter.kittens.find(k => k.id == btn.getAttribute('data-kitten-id')));
    });

    panel.appendChild(section);
  });

  container.appendChild(panel);
}

function showKittenEditModal(kittenId, kitten) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = '<h2>Edit Kitten #' + kitten.number + '</h2>' +
    '<div class="field"><label>Name</label><input type="text" id="ekName" value="' + (kitten.name || '') + '" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px"></div>' +
    '<div class="field"><label>Color</label><input type="text" id="ekColor" value="' + (kitten.color || '') + '" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    '<div class="field"><label>Sex</label><select id="ekSex" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px"><option value="">TBD</option><option value="male"' + (kitten.sex === 'male' ? ' selected' : '') + '>Male</option><option value="female"' + (kitten.sex === 'female' ? ' selected' : '') + '>Female</option></select></div>' +
    '<div class="field"><label>Price ($)</label><input type="number" id="ekPrice" value="' + (kitten.price || 1800) + '" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px"></div></div>' +
    '<div class="field"><label>Status</label><select id="ekStatus" style="width:100%;padding:10px;border:1px solid #D4C5A9;border-radius:6px;font-size:.95rem;font-weight:600">' +
    '<option value="available"' + (kitten.status === 'available' ? ' selected' : '') + '>Available</option>' +
    '<option value="pending"' + (kitten.status === 'pending' ? ' selected' : '') + '>Reserved - Pending Deposit</option>' +
    '<option value="reserved"' + (kitten.status === 'reserved' ? ' selected' : '') + '>Reserved - Deposit Received</option>' +
    '<option value="sold"' + (kitten.status === 'sold' ? ' selected' : '') + '>Sold</option>' +
    '</select></div>' +
    '<div class="field"><label>Reserved By (name or email)</label><input type="text" id="ekReservedBy" value="' + (kitten.reserved_by || '') + '" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px"></div>' +
    '<div class="field"><label>Notes</label><textarea id="ekNotes" rows="2" style="width:100%;padding:8px;border:1px solid #D4C5A9;border-radius:6px">' + (kitten.notes || '') + '</textarea></div>' +
    '<div class="actions"><button class="btn btn-outline" onclick="this.closest(\\'.modal-bg\\').remove()">Cancel</button><button class="btn btn-primary" id="saveKittenBtn">Save Changes</button></div>';

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

function showApprovalModal(name, email, password) {
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) { bg.remove(); renderApp(); }}});
  const modal = el('div', { class: 'modal' });
  modal.innerHTML = '<h2 style="color:#7A8B6F">Approved & Welcome Email Sent!</h2>' +
    '<p style="margin:12px 0">An applicant account has been created for <strong>' + name + '</strong> and a welcome email with login credentials has been sent automatically.</p>' +
    '<div class="field"><label>Email</label><div class="value">' + email + '</div></div>' +
    '<div class="field"><label>Temporary Password</label><div class="value" style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#A0522D;letter-spacing:1px">' + password + '</div></div>' +
    '<div class="field"><label>Portal URL</label><div class="value">https://portal.blueskycattery.com</div></div>' +
    '<p style="margin-top:16px;font-size:.85rem;color:#6B5B4B">The applicant received an email with these credentials and a link to the application portal.</p>' +
    '<div class="actions">' +
    '<button class="btn btn-primary" onclick="this.closest(\\'.modal-bg\\').remove();renderApp();">Close</button>' +
    '</div>';
  bg.appendChild(modal);
  document.body.appendChild(bg);
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
  html += '<div><strong style="font-size:1.1rem">' + (app.full_name||'N/A') + '</strong><br>';
  html += '<span style="color:' + gradeColor + ';font-weight:700">' + gradeLabel + '</span> &mdash; ' + app.score + '/100<br>';
  html += 'Purpose: <strong>' + (app.purpose || 'Pet') + '</strong> | Status: ' + badge(app.status);
  html += '</div></div>';

  // Kitten preferences
  if (app.kitten_primary || app.sex_preference) {
    html += '<div style="padding:12px 16px;background:#FDF9F3;border:1px solid #D4C5A9;border-radius:8px;margin-bottom:16px">';
    html += '<strong style="font-size:.82rem;text-transform:uppercase;letter-spacing:1px;color:#A0522D">Kitten Preferences</strong><br>';
    if (app.kitten_primary) html += 'Primary: <strong>' + app.kitten_primary + '</strong> ';
    if (app.kitten_backup1) html += '| Backup 1: ' + app.kitten_backup1 + ' ';
    if (app.kitten_backup2) html += '| Backup 2: ' + app.kitten_backup2 + ' ';
    if (app.sex_preference) html += '| Sex preference: <strong>' + app.sex_preference + '</strong>';
    html += '</div>';
  }

  // Highlights
  if (appHighlights.length > 0) {
    html += '<div style="padding:12px 16px;background:rgba(122,139,111,.08);border:1px solid rgba(122,139,111,.2);border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#7A8B6F;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Highlights</strong><ul style="margin:6px 0 0 16px;font-size:.88rem">';
    appHighlights.forEach(h => { html += '<li style="color:#5A6B4F">' + h + '</li>'; });
    html += '</ul></div>';
  }

  // Risks
  if (appRisks.length > 0) {
    html += '<div style="padding:12px 16px;background:rgba(139,58,58,.05);border:1px solid rgba(139,58,58,.15);border-radius:8px;margin-bottom:12px">';
    html += '<strong style="color:#8B3A3A;font-size:.82rem;text-transform:uppercase;letter-spacing:1px">Detected Risks</strong><ul style="margin:6px 0 0 16px;font-size:.88rem">';
    appRisks.forEach(r => { html += '<li style="color:#6E2828">' + r + '</li>'; });
    html += '</ul></div>';
  }

  // Category breakdown
  html += '<h3 style="margin:16px 0 8px">Score Breakdown by Category</h3><div class="score-detail">';
  Object.entries(cats).forEach(([key, cat]) => {
    if (typeof cat === 'object' && cat.label) {
      const pct = cat.max > 0 ? Math.round((cat.score / cat.max) * 100) : 0;
      const barColor = cat.score < 0 ? '#8B3A3A' : pct >= 70 ? '#7A8B6F' : pct >= 40 ? '#D4AF37' : '#A0522D';
      html += '<div class="score-item" style="flex-direction:column;align-items:stretch">';
      html += '<div style="display:flex;justify-content:space-between"><span>' + cat.label + '</span><strong>' + cat.score + '/' + cat.max + '</strong></div>';
      if (cat.max > 0) {
        html += '<div style="background:#e8e2d8;border-radius:3px;height:6px;margin-top:4px"><div style="background:' + barColor + ';height:6px;border-radius:3px;width:' + pct + '%"></div></div>';
      }
      if (cat.flags && cat.flags.length > 0) {
        cat.flags.forEach(f => { html += '<div style="font-size:.78rem;color:#8B3A3A;margin-top:4px">&#9888; ' + f + '</div>'; });
      }
      html += '</div>';
    }
  });
  html += '</div>';

  // Full application details
  const sections = [
    { title: 'Personal', fields: [['Full Name', app.full_name], ['Email', app.email], ['Phone', app.phone], ['City/State', app.city_state]] },
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
      if (val) html += '<div class="field"><label>' + label + '</label><div class="value">' + val + '</div></div>';
    });
  });

  // Admin review
  html += '<h3 style="margin:16px 0 8px">Admin Decision</h3>';
  html += '<div class="field"><label>Status</label><select id="appStatus"><option value="submitted"' + (app.status==='submitted'?' selected':'') + '>Submitted</option><option value="reviewed"' + (app.status==='reviewed'?' selected':'') + '>Reviewed</option><option value="approved"' + (app.status==='approved'?' selected':'') + '>Approved</option><option value="waitlist"' + (app.status==='waitlist'?' selected':'') + '>Waitlist</option><option value="rejected"' + (app.status==='rejected'?' selected':'') + '>Rejected</option></select></div>';
  html += '<div class="field"><label>Admin Notes</label><textarea id="appNotes" rows="3">' + (app.admin_notes || '') + '</textarea></div>';
  html += '<div class="actions"><button class="btn btn-outline" onclick="this.closest(\\'.modal-bg\\').remove()">Cancel</button><button class="btn btn-primary" id="saveAppBtn">Save Review</button></div>';

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
}

// Init
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
