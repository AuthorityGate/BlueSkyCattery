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
  let score = 0;
  const breakdown = {};

  // Housing (max 20)
  if (app.housing_type === 'house' || app.housing_own_rent === 'own') {
    score += 20; breakdown.housing = 20;
  } else if (app.housing_type === 'house-rent' || app.housing_own_rent === 'rent') {
    score += 12; breakdown.housing = 12;
  } else if (app.housing_type === 'apartment') {
    score += 8; breakdown.housing = 8;
  } else {
    score += 5; breakdown.housing = 5;
  }

  // Indoor only (max 15)
  if (app.indoor_only === 'yes') {
    score += 15; breakdown.indoor = 15;
  } else if (app.indoor_only === 'enclosed') {
    score += 12; breakdown.indoor = 12;
  } else {
    score += 0; breakdown.indoor = 0;
  }

  // Other pets - having a companion cat is ideal (max 20)
  const pets = (app.other_pets || '').toLowerCase();
  if (pets.includes('cat') || pets.includes('kitten') || pets.includes('oriental') || pets.includes('siamese')) {
    score += 20; breakdown.companion = 20;
  } else if (pets.includes('getting') || pets.includes('plan') || pets.includes('will get') || pets.includes('two')) {
    score += 15; breakdown.companion = 15;
  } else if (pets.includes('dog')) {
    score += 10; breakdown.companion = 10;
  } else if (pets.includes('no') || pets.includes('none')) {
    score += 3; breakdown.companion = 3;
  } else {
    score += 8; breakdown.companion = 8;
  }

  // Experience (max 15)
  const exp = (app.cat_experience || '').toLowerCase();
  if (exp.includes('oriental') || exp.includes('siamese') || exp.includes('breeder')) {
    score += 15; breakdown.experience = 15;
  } else if (exp.includes('cat') || exp.includes('years') || exp.includes('always')) {
    score += 10; breakdown.experience = 10;
  } else if (exp.includes('first') || exp.includes('new') || exp.includes('never')) {
    score += 3; breakdown.experience = 3;
  } else {
    score += 6; breakdown.experience = 6;
  }

  // Why interested - looking for passion (max 15)
  const why = (app.why_oriental || '').toLowerCase();
  const passionWords = ['love', 'personality', 'intelligent', 'companion', 'family', 'bond', 'research', 'dream', 'passion', 'years', 'always wanted'];
  const passionCount = passionWords.filter(w => why.includes(w)).length;
  if (passionCount >= 3) { score += 15; breakdown.motivation = 15; }
  else if (passionCount >= 1) { score += 10; breakdown.motivation = 10; }
  else if (why.length > 50) { score += 7; breakdown.motivation = 7; }
  else { score += 3; breakdown.motivation = 3; }

  // Vet info provided (max 10)
  if (app.vet_name && app.vet_phone) {
    score += 10; breakdown.vet = 10;
  } else if (app.vet_name || app.vet_phone) {
    score += 5; breakdown.vet = 5;
  } else {
    score += 0; breakdown.vet = 0;
  }

  // Work schedule - home presence (max 5)
  const work = (app.work_schedule || '').toLowerCase();
  if (work.includes('home') || work.includes('remote') || work.includes('wfh') || work.includes('retired')) {
    score += 5; breakdown.schedule = 5;
  } else if (work.includes('part')) {
    score += 3; breakdown.schedule = 3;
  } else {
    score += 1; breakdown.schedule = 1;
  }

  // Enrichment plan (max 5)
  const enrich = (app.enrichment_plan || '').toLowerCase();
  if (enrich.includes('tree') || enrich.includes('toy') || enrich.includes('play')) {
    score += 5; breakdown.enrichment = 5;
  } else if (enrich.length > 20) {
    score += 3; breakdown.enrichment = 3;
  } else {
    score += 1; breakdown.enrichment = 1;
  }

  // Spay/neuter agreement (max 5)
  const spay = (app.spay_neuter_opinion || '').toLowerCase();
  if (spay.includes('agree') || spay.includes('absolutely') || spay.includes('support') || spay.includes('of course') || spay.includes('no problem')) {
    score += 5; breakdown.spay_neuter = 5;
  } else if (spay.includes('understand') || spay.includes('fine')) {
    score += 3; breakdown.spay_neuter = 3;
  } else {
    score += 0; breakdown.spay_neuter = 0;
  }

  // Rehome circumstances - red flag detection (deduct up to -10)
  const rehome = (app.rehome_circumstances || '').toLowerCase();
  if (rehome.includes('never') || rehome.includes('no circumstance') || rehome.includes('would not') || rehome.includes('not an option')) {
    score += 5; breakdown.commitment = 5;
  } else if (rehome.includes('last resort') || rehome.includes('only if')) {
    score += 2; breakdown.commitment = 2;
  } else if (rehome.length > 0) {
    score -= 5; breakdown.commitment = -5;
  } else {
    score += 0; breakdown.commitment = 0;
  }

  // Consistency check: verify_cat_count vs other_pets (flag only, no score deduction)
  const catCount = (app.verify_cat_count || '').toLowerCase();
  const petsDesc = (app.other_pets || '').toLowerCase();
  let consistencyFlag = 'consistent';
  if (catCount === '0' || catCount === 'none' || catCount === 'zero') {
    if (petsDesc.includes('cat') || petsDesc.includes('kitten')) {
      consistencyFlag = 'INCONSISTENT - claims 0 cats but mentioned cats in pets section';
      score -= 10; breakdown.consistency = -10;
    } else {
      breakdown.consistency = 0;
    }
  } else {
    breakdown.consistency = 0;
  }
  breakdown.consistency_note = consistencyFlag;

  // Surrender history - flag (deduct if yes but no explanation)
  if (app.surrender_history === 'yes' && (!app.surrender_details || app.surrender_details.length < 20)) {
    score -= 5; breakdown.surrender_flag = -5;
  } else {
    breakdown.surrender_flag = 0;
  }

  // Adjustment plan quality (max 5)
  const adjust = (app.adjustment_plan || '').toLowerCase();
  if (adjust.includes('patience') || adjust.includes('time') || adjust.includes('vet') || adjust.includes('work with')) {
    score += 5; breakdown.adjustment = 5;
  } else if (adjust.length > 30) {
    score += 3; breakdown.adjustment = 3;
  } else {
    score += 0; breakdown.adjustment = 0;
  }

  // Cap score at 0-100
  score = Math.max(0, Math.min(100, score));

  return { score, breakdown, maxScore: 100 };
}

// ---- Email Sending (via MailChannels or FormSubmit) ----

async function sendEmail(to, subject, body) {
  // Use FormSubmit for email delivery
  try {
    await fetch('https://formsubmit.co/ajax/' + to, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: subject,
        message: body,
        name: 'Blue Sky Cattery',
        email: 'noreply@blueskycattery.com'
      })
    });
    return true;
  } catch (e) {
    console.error('Email failed:', e);
    return false;
  }
}

// ---- Route Handler ----

export default {
  async fetch(request, env) {
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
        const data = await request.json();
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

        return json({ success: true, message: 'Contact saved' });
      }

      // Reservation form submission (from website)
      if (path === '/api/reserve' && method === 'POST') {
        const data = await request.json();
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
          INSERT INTO applications (user_id, kitten_preference, full_name, email, phone, city_state, housing_type, housing_own_rent, other_pets, cat_experience, why_oriental, indoor_only, household_members, work_schedule, vet_name, vet_phone, pet_history, surrender_history, allergies, timeline, additional_notes, score, score_breakdown, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          session.user_id, data.kitten_preference || null, data.full_name, data.email, data.phone,
          data.city_state, data.housing_type, data.housing_own_rent || null, data.other_pets,
          data.cat_experience, data.why_oriental, data.indoor_only, data.household_members || null,
          data.work_schedule || null, data.vet_name || null, data.vet_phone || null,
          data.pet_history || null, data.surrender_history || null, data.allergies || null,
          data.timeline || null, data.additional_notes || null,
          grading.score, JSON.stringify(grading.breakdown), 'submitted', now(), now()
        ).run();

        return json({ success: true, message: 'Application submitted' });
      }

      // Get my application
      if (path === '/api/application' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session) return json({ error: 'Not authenticated' }, 401);
        const app = await env.DB.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(session.user_id).first();
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

        await sendEmail(lead.email, 'Welcome to Blue Sky Cattery - Application Portal Access', emailBody);

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

      // Admin: Dashboard stats
      if (path === '/api/admin/stats' && method === 'GET') {
        const session = await validateSession(env.DB, token);
        if (!session || session.role !== 'admin') return json({ error: 'Forbidden' }, 403);

        const totalLeads = await env.DB.prepare('SELECT COUNT(*) as count FROM leads').first();
        const newLeads = await env.DB.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").first();
        const totalApps = await env.DB.prepare('SELECT COUNT(*) as count FROM applications').first();
        const pendingApps = await env.DB.prepare("SELECT COUNT(*) as count FROM applications WHERE status = 'submitted'").first();
        const avgScore = await env.DB.prepare('SELECT AVG(score) as avg FROM applications').first();

        return json({
          stats: {
            totalLeads: totalLeads.count,
            newLeads: newLeads.count,
            totalApplications: totalApps.count,
            pendingApplications: pendingApps.count,
            averageScore: Math.round(avgScore.avg || 0)
          }
        });
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
    el('button', { class: currentTab==='applications'?'active':'', onclick: () => { currentTab='applications'; renderApp(); }}, 'Applications')
  );
  app.appendChild(nav);

  const content = el('div', { class: 'container' });
  app.appendChild(content);

  if (currentTab === 'dashboard') await renderDashboard(content);
  else if (currentTab === 'leads') await renderLeads(content);
  else if (currentTab === 'applications') await renderApplications(content);
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
      el('div', { class: 'stat-card' }, el('div', { class: 'number' }, ''+stats.averageScore), el('div', { class: 'label' }, 'Avg Score'))
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
          if (res.success) { alert('Account created! Temp password: ' + res.tempPassword); renderApp(); }
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
  const { applications } = await api('/admin/applications');
  const panel = el('div', { class: 'panel active' });
  panel.innerHTML = '<h2 style="margin:20px 0 12px">Applications</h2>';

  const table = el('table');
  table.innerHTML = '<thead><tr><th>Applicant</th><th>Email</th><th>Score</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  (applications || []).forEach(app => {
    const tr = el('tr');
    tr.innerHTML = '<td><strong>' + (app.full_name||'N/A') + '</strong></td><td>' + (app.user_email||app.email||'') + '</td><td>' + scoreEl(app.score) + '</td><td>' + badge(app.status) + '</td><td>' + timeAgo(app.created_at) + '</td>';
    const actionTd = el('td');
    actionTd.appendChild(el('button', { class: 'btn btn-outline btn-sm', onclick: () => showAppModal(app.id) }, 'Review'));
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  if (!applications || applications.length === 0) panel.innerHTML += '<p style="color:#6B5B4B;padding:20px;text-align:center">No applications yet.</p>';
  container.appendChild(panel);
}

async function showAppModal(appId) {
  const { application: app } = await api('/admin/applications/' + appId);
  if (!app) return;
  const breakdown = app.score_breakdown ? JSON.parse(app.score_breakdown) : {};
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); }});
  const modal = el('div', { class: 'modal' });

  const fields = [
    ['Full Name', app.full_name], ['Email', app.email], ['Phone', app.phone],
    ['City/State', app.city_state], ['Housing Type', app.housing_type],
    ['Kitten Preference', app.kitten_preference], ['Other Pets', app.other_pets],
    ['Cat Experience', app.cat_experience], ['Why Oriental', app.why_oriental],
    ['Indoor Only', app.indoor_only], ['Household Members', app.household_members],
    ['Work Schedule', app.work_schedule], ['Vet Name', app.vet_name],
    ['Vet Phone', app.vet_phone], ['Pet History', app.pet_history],
    ['Surrender History', app.surrender_history], ['Allergies', app.allergies],
    ['Timeline', app.timeline], ['Additional Notes', app.additional_notes]
  ];

  let html = '<h2>Application Review</h2>';
  html += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">' + scoreEl(app.score) + '<div><strong>Score: ' + app.score + '/100</strong><br>Status: ' + badge(app.status) + '</div></div>';
  html += '<h3 style="margin:12px 0 8px">Score Breakdown</h3><div class="score-detail">';
  Object.entries(breakdown).forEach(([k, v]) => { html += '<div class="score-item"><span>' + k + '</span><strong>' + v + '</strong></div>'; });
  html += '</div><h3 style="margin:16px 0 8px">Application Details</h3>';
  fields.forEach(([label, val]) => {
    if (val) html += '<div class="field"><label>' + label + '</label><div class="value">' + val + '</div></div>';
  });

  html += '<h3 style="margin:16px 0 8px">Admin Review</h3>';
  html += '<div class="field"><label>Status</label><select id="appStatus"><option value="submitted"' + (app.status==='submitted'?' selected':'') + '>Submitted</option><option value="reviewed"' + (app.status==='reviewed'?' selected':'') + '>Reviewed</option><option value="approved"' + (app.status==='approved'?' selected':'') + '>Approved</option><option value="rejected"' + (app.status==='rejected'?' selected':'') + '>Rejected</option></select></div>';
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

      <div class="form-section">Preferences</div>
      <div class="form-group"><label>Kitten Preference</label>
        <select name="kitten_preference"><option value="">No preference</option><option value="kitten1">Kitten #1</option><option value="kitten2">Kitten #2</option><option value="kitten3">Kitten #3</option><option value="kitten4">Kitten #4</option><option value="kitten5">Kitten #5</option><option value="kitten6">Kitten #6</option></select></div>
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
