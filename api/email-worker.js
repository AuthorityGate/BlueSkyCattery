// ============================================
// Blue Sky Cattery - Email Worker
// photos@blueskycattery.com -> parse photos -> webhook
// ============================================
export default {
  async email(message, env, ctx) {
    const from = message.from;
    const subject = message.headers.get('subject') || '';

    // Read raw email
    let rawText = '';
    try {
      const reader = message.raw.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > 25 * 1024 * 1024) break;
      }
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      rawText = new TextDecoder('utf-8', { fatal: false }).decode(all);
    } catch(e) {
      try {
        rawText = await new Response(message.raw).text();
      } catch(e2) {
        rawText = '';
      }
    }

    // Parse
    const textBody = extractPlainText(rawText);
    const attachments = extractImageAttachments(rawText);

    // POST to webhook
    try {
      await fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            From: { Address: from },
            Subject: subject,
            RawTextBody: textBody || 'Email from ' + from,
            Attachments: attachments
          }]
        })
      });
    } catch(e) {}
  }
};

function extractPlainText(raw) {
  if (!raw) return '';
  const boundary = findBoundary(raw);
  if (!boundary) {
    const idx = raw.indexOf('\r\n\r\n');
    return idx > -1 ? raw.slice(idx + 4, idx + 5004).trim() : '';
  }
  for (const part of raw.split('--' + boundary)) {
    if (part.match(/Content-Type:\s*text\/plain/i)) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      let body = part.slice(idx + 4).trim();
      if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
        try { body = atob(body.replace(/\s/g, '')); } catch(e) {}
      }
      if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      }
      return body.slice(0, 5000);
    }
  }
  return '';
}

function extractImageAttachments(raw) {
  if (!raw) return [];
  const attachments = [];
  const boundaries = [];
  for (const m of raw.matchAll(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/gi)) {
    boundaries.push(m[1].trim());
  }
  if (!boundaries.length) return [];
  for (const b of boundaries) {
    for (const part of raw.split('--' + b)) {
      const ct = part.match(/Content-Type:\s*(image\/[^\s;\r\n]+)/i);
      if (!ct) continue;
      if (!part.match(/Content-Transfer-Encoding:\s*base64/i)) continue;
      const nm = part.match(/(?:file)?name=["']?([^"'\r\n;]+)/i);
      const fn = nm ? nm[1].trim() : 'photo.jpg';
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      let b64 = part.slice(idx + 4).trim();
      const bi = b64.indexOf('--');
      if (bi > 0) b64 = b64.slice(0, bi);
      b64 = b64.replace(/[\r\n\s]/g, '');
      if (b64.length > 1000) {
        attachments.push({ Name: fn, ContentType: ct[1], Content: b64 });
      }
    }
  }
  return attachments;
}

function findBoundary(raw) {
  const m = raw.match(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/i);
  return m ? m[1].trim() : null;
}
