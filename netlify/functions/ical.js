// Server-side fetch of a calendar feed (webcal/ICS), so the planner can
// subscribe to a live feed URL. A browser can't fetch the school's feed
// directly (no CORS headers from that server); this first-party function runs
// on Netlify, fetches it, and returns the ICS text to the app with CORS.
//
// Usage from the app:  /.netlify/functions/ical?u=<encoded feed url>
// Only well-known calendar hosts are allowed, so this isn't an open proxy.

const https = require('https');
const { URL } = require('url');

// A feed host is allowed if it equals, or is a subdomain of, one of these.
const ALLOW_SUFFIXES = [
  'myschoolapp.com', 'blackbaud.com', 'veracross.com', 'finalsite.com',
  'google.com', 'googleusercontent.com', 'gstatic.com',
  'icloud.com', 'me.com', 'office365.com', 'outlook.com', 'live.com',
];

function hostAllowed(host) {
  host = String(host || '').toLowerCase();
  return ALLOW_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}

// GET with https, following a few redirects, size- and time-capped.
function fetchFeed(urlStr, redirectsLeft, cb) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return cb(new Error('bad url')); }
  if (u.protocol !== 'https:') return cb(new Error('only https feeds are supported'));
  if (!hostAllowed(u.hostname)) return cb(new Error('that calendar host is not on the allowed list'));
  const req = https.get(u, {
    headers: { 'User-Agent': 'BJP-Planner-Calendar/1.0', 'Accept': 'text/calendar, text/plain, */*' },
  }, res => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, u).toString(); } catch (e) { return cb(new Error('bad redirect')); }
      return fetchFeed(next, redirectsLeft - 1, cb);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('the feed server returned HTTP ' + res.statusCode)); }
    let data = '', size = 0;
    res.setEncoding('utf8');
    res.on('data', d => {
      size += d.length;
      if (size > 5 * 1024 * 1024) { req.destroy(); return cb(new Error('feed is too large')); }
      data += d;
    });
    res.on('end', () => cb(null, data));
  });
  req.on('error', e => cb(e));
  req.setTimeout(12000, () => { req.destroy(); cb(new Error('timed out reaching the feed')); });
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  let u = (event.queryStringParameters && event.queryStringParameters.u) || '';
  if (/^webcal:\/\//i.test(u)) u = 'https://' + u.replace(/^webcal:\/\//i, '');
  if (!u) return { statusCode: 400, headers: cors, body: 'Missing ?u= feed url' };

  return await new Promise(resolve => {
    fetchFeed(u, 3, (err, data) => {
      if (err) return resolve({ statusCode: 502, headers: cors, body: 'Could not read the feed: ' + err.message });
      resolve({
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
        body: data,
      });
    });
  });
};
