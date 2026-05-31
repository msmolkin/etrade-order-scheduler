/*
Google Apps Script: poll Gmail for forwarded Google Voice E*TRADE OTP emails
and POST the newest unprocessed code to /api/auth/auto/webhook.

Where to put this:
1. Go to https://script.google.com
2. Create a new project
3. Replace the default contents of Code.gs with this file
4. In Project Settings -> Script properties, set:
   ETRADE_WEBHOOK_URL=https://YOUR-PUBLIC-ENDPOINT/api/auth/auto/webhook
   ETRADE_WEBHOOK_SECRET=YOUR_LONG_RANDOM_SECRET
   ETRADE_GMAIL_QUERY=in:inbox newer_than:1d "Your E*TRADE verification code is"
   ETRADE_PROCESSED_LABEL=etrade-otp-processed
   ETRADE_TIMEZONE=America/New_York
   ETRADE_POLL_START=06:30
   ETRADE_POLL_END=07:30
5. In Triggers, add a time-driven trigger for pollEtradeOtpEmail every minute.

Notes:
- This is designed for Google Voice -> Gmail email forwarding.
- It only posts the newest matching unprocessed message.
- It labels successfully delivered messages with ETRADE_PROCESSED_LABEL.
- It does NOT require sessionId if only one auto-auth session is waiting.
- If your server exposes multiple simultaneous auto-auth sessions someday, add a
  sessionId field to the JSON payload here.
*/

function pollEtradeOtpEmail() {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = requireProperty_(props, 'ETRADE_WEBHOOK_URL');
  const webhookSecret = requireProperty_(props, 'ETRADE_WEBHOOK_SECRET');
  const gmailQuery = props.getProperty('ETRADE_GMAIL_QUERY') || 'in:inbox newer_than:1d "Your E*TRADE verification code is"';
  const processedLabelName = props.getProperty('ETRADE_PROCESSED_LABEL') || 'etrade-otp-processed';
  const timezone = props.getProperty('ETRADE_TIMEZONE') || 'America/New_York';
  const pollStart = props.getProperty('ETRADE_POLL_START') || '06:30';
  const pollEnd = props.getProperty('ETRADE_POLL_END') || '07:30';

  if (!isWithinWindow_(timezone, pollStart, pollEnd)) {
    console.log('Outside polling window; skipping run.');
    return;
  }

  const processedLabel = GmailApp.getUserLabelByName(processedLabelName) || GmailApp.createLabel(processedLabelName);
  const threads = GmailApp.search(`${gmailQuery} -label:${processedLabelName}`, 0, 20);
  const candidates = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const body = buildSearchableBody_(message);
      const match = body.match(/Your\s+E\*TRADE\s+verification\s+code\s+is\s+(\d{6})/i);
      if (!match) {
        return;
      }

      candidates.push({
        thread: thread,
        message: message,
        body: body,
        code: match[1],
        timestamp: message.getDate().getTime(),
      });
    });
  });

  if (candidates.length === 0) {
    console.log('No matching unprocessed E*TRADE OTP emails found.');
    return;
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp);
  const newest = candidates[0];

  const payload = {
    Body: newest.body,
  };

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-webhook-secret': webhookSecret,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();
  console.log(`Webhook status=${status} body=${responseText}`);

  if (status < 200 || status >= 300) {
    throw new Error(`Webhook call failed with HTTP ${status}: ${responseText}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Webhook returned non-JSON response: ${responseText}`);
  }

  if (!parsed || parsed.success !== true) {
    throw new Error(`Webhook did not report success: ${responseText}`);
  }

  newest.thread.addLabel(processedLabel);
  newest.message.markRead();
  console.log(`Delivered E*TRADE code ${newest.code} from message ${newest.message.getId()}.`);
}

function buildSearchableBody_(message) {
  const plain = message.getPlainBody() || '';
  if (plain.trim()) {
    return plain.trim();
  }

  const html = message.getBody() || '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWithinWindow_(timezone, startHHMM, endHHMM) {
  const now = new Date();
  const current = Utilities.formatDate(now, timezone, 'HH:mm');
  return current >= startHHMM && current <= endHHMM;
}

function requireProperty_(props, key) {
  const value = (props.getProperty(key) || '').trim();
  if (!value) {
    throw new Error(`Missing required script property: ${key}`);
  }
  return value;
}
