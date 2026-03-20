// ============================================
// Blue Sky Cattery - Email Worker
// Parses kittens@ emails for photo attachments
// Gmail forwarding handled by email routing rule
// ============================================

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const subject = message.headers.get('subject') || '';

    // Read the raw email stream
    let rawText = '';
    try {
      const reader = message.raw.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const allBytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { allBytes.set(chunk, offset); offset += chunk.length; }
      rawText = new TextDecoder('utf-8', { fatal: false }).decode(allBytes);
    } catch(e) {
      return; // Can't read email, nothing to do
    }

    // Parse MIME
    const textBody = extractPlainText(rawText);
    const attachments = extractImageAttachments(rawText);

    // POST to portal webhook for photo processing + CRM tracking
    const payload = {
      items: [{
        From: { Address: from },
        Subject: subject,
        RawTextBody: textBody,
        Attachments: attachments
      }]
    };

    // Use waitUntil so the email handler doesn't timeout
    ctx.waitUntil(
      fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {})
    );
  }
};

function extractPlainText(raw) {
  const boundary = findBoundary(raw);
  if (!boundary) {
    const idx = raw.indexOf('\r\n\r\n');
    return idx > -1 ? raw.slice(idx + 4, idx + 5004).trim() : '';
  }
  const parts = raw.split('--' + boundary);
  for (const part of parts) {
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
  const attachments = [];
  const boundary = findBoundary(raw);
  if (!boundary) return attachments;

  // Also check for nested multipart boundaries
  const allBoundaries = [boundary];
  const nestedMatches = raw.matchAll(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/gi);
  for (const m of nestedMatches) {
    if (m[1].trim() !== boundary) allBoundaries.push(m[1].trim());
  }

  for (const b of allBoundaries) {
    const parts = raw.split('--' + b);
    for (const part of parts) {
      const ctMatch = part.match(/Content-Type:\s*(image\/[^\s;\r\n]+)/i);
      if (!ctMatch) continue;
      if (!part.match(/Content-Transfer-Encoding:\s*base64/i)) continue;
      const nameMatch = part.match(/(?:file)?name=["']?([^"'\r\n;]+)/i);
      const filename = nameMatch ? nameMatch[1].trim() : 'photo.jpg';
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      let base64 = part.slice(idx + 4).trim();
      const bIdx = base64.indexOf('--');
      if (bIdx > 0) base64 = base64.slice(0, bIdx);
      base64 = base64.replace(/[\r\n\s]/g, '');
      if (base64.length > 1000) {
        attachments.push({ Name: filename, ContentType: ctMatch[1], Content: base64 });
      }
    }
  }
  return attachments;
}

function findBoundary(raw) {
  const m = raw.match(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/i);
  return m ? m[1].trim() : null;
}
