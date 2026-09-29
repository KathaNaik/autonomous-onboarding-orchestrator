/*
 * ServiceNow Business Rule: "AOO fulfillment callback"   (application: Autonomous Onboarding, M7D)
 *   Table:     Onboarding Access Request  (x_2230066_autono_0_onboarding_access_request)
 *   When:      async     Update: checked   (Insert/Delete/Query: unchecked)
 *   Filter:    [Request Kind] [is] [fulfillment]  AND  [Fulfillment State] [changes]
 *   Advanced:  checked, script below.
 *
 * Sends a NOTIFICATION (identifiers only) when a human fulfiller changes a FULFILLMENT record.
 * The backend never trusts it: it reads the record back with its integration account, and only
 * the authoritative fulfillment_state decides. Approval records never trigger this rule (the
 * filter and the guard below), and the approval rule never fires for fulfillment records.
 *
 * Same signing as "AOO approval callback" (HMAC-SHA256 in plain ES5; scoped apps may not use
 * GlideCertificateEncryption or GlideStringUtil.base64Encode):
 *   X-AOO-Signature = "v1=" + base64(HMAC-SHA256(secret, "<ts>.<body>")), X-AOO-Timestamp = <ms>.
 * Values come from PRIVATE GLOBAL properties only (never application-scope properties, which are
 * exported with their values): aoo.fulfillment_callback.url (the /webhooks/servicenow/fulfillment
 * endpoint) and the existing aoo.approval_callback.secret / aoo.approval_callback.instance.
 *
 * Event id "<sys_id>:<sys_mod_count>" is stable per change: re-sends deduplicate, later changes
 * get a new id.
 */
(function executeRule(current, previous /* null for async rules */) {
  if (current.getValue('request_kind') != 'fulfillment') return;
  var url = gs.getProperty('aoo.fulfillment_callback.url');
  var secret = gs.getProperty('aoo.approval_callback.secret');
  if (!url || !secret) {
    gs.warn('AOO fulfillment callback: aoo.fulfillment_callback.url / secret not configured');
    return;
  }
  var body = JSON.stringify({
    eventId: current.getUniqueValue() + ':' + current.getValue('sys_mod_count'),
    instance: gs.getProperty('aoo.approval_callback.instance') || gs.getProperty('instance_name'),
    table: current.getTableName(),
    sysId: current.getUniqueValue(),
    number: current.getValue('number'),
    correlationKey: current.getValue('correlation_key'),
    claimedFulfillmentState: current.getValue('fulfillment_state') // hint only; never authoritative
  });
  var ts = String(new GlideDateTime().getNumericValue());
  var mac = base64(hmacSha256(utf8(String(secret)), utf8(ts + '.' + body)));

  var request = new sn_ws.RESTMessageV2();
  request.setEndpoint(url);
  request.setHttpMethod('post');
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('X-AOO-Timestamp', ts);
  request.setRequestHeader('X-AOO-Signature', 'v1=' + mac);
  request.setRequestBody(body);
  request.setHttpTimeout(10000);
  var response = request.execute();
  var status = response.getStatusCode();
  if (status != 202) {
    // Status only: never log the body, headers or secret.
    gs.warn('AOO fulfillment callback for ' + current.getValue('number') + ' returned HTTP ' + status);
  }

  // ---- HMAC-SHA256 (FIPS 180-4 / RFC 2104) in plain ES5; byte arrays of 0..255 ----
  function utf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function sha256(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var m = bytes.slice(0);
    var bitLen = bytes.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64);
    for (var i = 0; i < m.length; i += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3];
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (var j = 0; j < 8; j++) out.push((H[j] >>> 24) & 255, (H[j] >>> 16) & 255, (H[j] >>> 8) & 255, H[j] & 255);
    return out;
  }
  function hmacSha256(key, message) {
    if (key.length > 64) key = sha256(key);
    var ipad = [], opad = [];
    for (var i = 0; i < 64; i++) {
      var k = i < key.length ? key[i] : 0;
      ipad.push(k ^ 0x36);
      opad.push(k ^ 0x5c);
    }
    return sha256(opad.concat(sha256(ipad.concat(message))));
  }
  function base64(bytes) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) | (i + 2 < bytes.length ? bytes[i + 2] : 0);
      out += A.charAt((n >> 18) & 63) + A.charAt((n >> 12) & 63) +
        (i + 1 < bytes.length ? A.charAt((n >> 6) & 63) : '=') + (i + 2 < bytes.length ? A.charAt(n & 63) : '=');
    }
    return out;
  }
})(current, previous);
