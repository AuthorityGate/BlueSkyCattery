// ============================================
// Blue Sky Cattery - Cron Worker
// Scheduled email automation for post-adoption
// ============================================

function now() {
  return new Date().toISOString();
}

async function sendEmail(brevoKey, to, subject, body, toName) {
  if (!brevoKey) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Blue Sky Cattery', email: 'kittens@blueskycattery.com' },
        replyTo: { name: 'Blue Sky Cattery', email: 'kittens@reply.blueskycattery.com' },
        to: [{ email: to, name: toName || to }],
        subject,
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

async function sendTemplateEmail(brevoKey, to, toName, templateId, params) {
  if (!brevoKey) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: templateId,
        to: [{ email: to, name: toName || to }],
        params: params
      })
    });
    const result = await res.json();
    return !!result.messageId;
  } catch (e) {
    console.error('Template email failed:', e);
    return false;
  }
}

export default {
  // Cron trigger - runs on schedule
  async scheduled(event, env, ctx) {
    const brevoKey = env.BREVO_API_KEY;
    const db = env.DB;

    try {
      // Ensure tracking table exists
      await db.prepare(`CREATE TABLE IF NOT EXISTS email_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kitten_id INTEGER,
        lead_id INTEGER,
        schedule_id INTEGER,
        template_id INTEGER,
        recipient_email TEXT,
        sent_at TEXT,
        status TEXT DEFAULT 'sent'
      )`).run();

      // Get active email schedules
      const schedules = await db.prepare("SELECT * FROM email_schedules WHERE active = 1").all();
      if (!schedules.results.length) return;

      // Get all sold kittens with their buyer info and go-home dates
      const soldKittens = await db.prepare(`
        SELECT k.id as kitten_id, k.name as kitten_name, k.reserved_by,
               k.notes as kitten_notes, k.breeding_rights, k.go_home_date, l.born_date,
               lead.id as lead_id, lead.name as buyer_name, lead.email as buyer_email
        FROM kittens k
        JOIN litters l ON k.litter_id = l.id
        LEFT JOIN leads lead ON lead.email = k.reserved_by
        WHERE k.status = 'sold' AND k.reserved_by IS NOT NULL
      `).all();

      const todayMs = Date.now();

      for (const kitten of soldKittens.results) {
        if (!kitten.buyer_email) continue;

        // Go-home date must be explicitly set by admin
        if (!kitten.go_home_date) continue;
        const goHomeDate = new Date(kitten.go_home_date);

        const birthdayDate = kitten.born_date ? new Date(kitten.born_date) : null;

        for (const schedule of schedules.results) {
          // Check if this email was already sent
          const alreadySent = await db.prepare(
            'SELECT id FROM email_sent_log WHERE kitten_id = ? AND schedule_id = ?'
          ).bind(kitten.kitten_id, schedule.id).first();
          if (alreadySent) continue;

          // Determine the trigger date
          let triggerDate = null;
          if (schedule.trigger_type === 'go_home') {
            triggerDate = new Date(goHomeDate);
            triggerDate.setDate(triggerDate.getDate() + schedule.days_after);
          } else if (schedule.trigger_type === 'birthday' && birthdayDate) {
            triggerDate = new Date(birthdayDate);
            triggerDate.setFullYear(triggerDate.getFullYear() + 1);
          }
          if (!triggerDate) continue;

          // Is it time to send?
          const triggerMs = triggerDate.getTime();
          if (todayMs >= triggerMs) {
            // Skip spay/neuter email (template 3) if kitten has breeding rights
            if (schedule.brevo_template_id === 3 && kitten.breeding_rights) continue;

            // Send the template email
            const sent = await sendTemplateEmail(
              brevoKey,
              kitten.buyer_email,
              kitten.buyer_name,
              schedule.brevo_template_id,
              {
                KITTEN_NAME: kitten.kitten_name || 'your kitten',
                FIRSTNAME: (kitten.buyer_name || '').split(' ')[0] || 'there'
              }
            );

            // Log it
            await db.prepare(
              'INSERT INTO email_sent_log (kitten_id, lead_id, schedule_id, template_id, recipient_email, sent_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(
              kitten.kitten_id, kitten.lead_id || null, schedule.id,
              schedule.brevo_template_id, kitten.buyer_email, now(),
              sent ? 'sent' : 'failed'
            ).run();

            console.log(`Email ${schedule.name} ${sent ? 'sent' : 'FAILED'} to ${kitten.buyer_email} for ${kitten.kitten_name}`);
          }
        }
      }

      // Also clean up expired sessions (older than 24 hours)
      await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();

    } catch (e) {
      console.error('Cron error:', e);
    }
  },

  // Also handle fetch for health checks
  async fetch(request, env) {
    return new Response(JSON.stringify({ status: 'ok', worker: 'cron', time: now() }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
