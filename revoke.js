/**
 * Everything that lets someone in, ended at once: what a new password, a reset
 * and the admin's "sign out everywhere" do.
 *
 * A password is what people change when they think someone else got in. Each
 * of those paths used to close its own part: the browsers' sessions, and only
 * the admin's also the API tokens, the assistants' grants and the phones. So
 * whoever had the account for a while and left an API token, an AI client or a
 * phone behind kept it after the owner changed the password — and a phone's
 * token opens a new web session whenever it wants (devices.webSessions). Now
 * every path calls this one function, and none is left with a subset.
 *
 * In this order:
 *   1. the identity provider's sessions behind the ones here, read before they close;
 *   2–6. in one transaction: the sessions here (all but `keep`'s), the API tokens,
 *        the OAuth grants of the suite's own server and their tokens, the device
 *        tokens with the web sessions they opened and their native push tokens,
 *        and the browsers' push subscriptions;
 *   7. with WorkOS, the AI clients authorized in AuthKit: refused here now (every
 *      token issued until now), and withdrawn at WorkOS in the background;
 *   8. the provider's sessions of step 1, in the background;
 *   9. the open tabs' live channels, but `keep`'s (whoever hears whenRevoked);
 *   10. the audit log: `auth.revoke_everything`, with the reason and the counts.
 *
 * Disabling an account doesn't come here on purpose: it is reversible, and an
 * account that comes back keeps its grants and tokens (they refuse a disabled
 * account meanwhile).
 */

/**
 * @param {object} deps
 * @param {object} deps.database
 * @param {object} [deps.sessions]     from createSessions()
 * @param {object} [deps.tokens]       from createTokens()
 * @param {object} [deps.oauth]        from createOAuthServer(), with modules.oauth
 * @param {object} [deps.devices]      from createDevices(), with modules.devices
 * @param {object} [deps.push]         from createPush(), with modules.push
 * @param {object} [deps.idp]          the identity provider: revokeSession, revokeAllConnections
 * @param {object} [deps.connections]  from workosConnections(): the AI clients refused here
 * @param {object} [deps.workosPeople] from workosUsers(): workosIdOf
 * @param {object} [deps.audit]        from createAudit()
 * @param {(line: string) => void} [deps.log]
 */
export function createRevoker({
  database, sessions = null, tokens = null, oauth = null, devices = null, push = null, idp = null,
  connections = null, workosPeople = null, audit = null, log = console.log,
}) {
  const hooks = [];
  const hasTable = (name) => database.columnsOf(name).length > 0;
  const background = (promise, what) => Promise.resolve(promise)
    .catch((err) => log(`[auth] ${what}: ${err.message}`));

  /**
   * @param {number} userId
   * @param {object} [options]
   * @param {{ sessionToken: string } | null} [options.keep]  the session (and its tab) that stays: the one
   *   where the person just changed their password
   * @param {boolean} [options.provider]  also withdraw the AI clients at the identity provider
   * @param {string} [options.reason]     for the audit log: password, reset, admin_password, sign_out_everywhere…
   * @param {object|number|null} [options.actor]  who did it, for the audit log (the person by default)
   * @param {object} [options.req]
   * @returns {{ closed: number, tokens: number, grants: number, devices: number, push: number, ai_clients: number }}
   */
  function revokeEverything(userId, { keep = null, provider = true, reason = null, actor = undefined, req = null } = {}) {
    const id = Number(userId);
    const exceptToken = keep?.sessionToken || null;
    // 1. Read before they close: the provider's sessions behind the ones here.
    const atProvider = sessions?.idpSessionsOf?.(id, { exceptToken }) || [];
    const subject = workosPeople?.workosIdOf?.(id) || null;

    const counts = database.tx(() => {
      // 2. The sessions here.
      const closed = sessions ? sessions.closeAllOf(id, { exceptToken }) : 0;
      // 3. The API tokens.
      const revoked = tokens?.revokeAllOf(id) ?? 0;
      // 4. The suite's own OAuth grants and their tokens.
      const grants = oauth && hasTable('oauth_grants')
        ? Number(database.get('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?', id).n) : 0;
      oauth?.forgetUser(id);
      // 5. The phones: their tokens, the web sessions they opened, their native push tokens.
      if (hasTable('device_push_tokens')) {
        database.run('DELETE FROM device_push_tokens WHERE device_id IN (SELECT id FROM device_tokens WHERE user_id = ?)', id);
      }
      const phones = devices ? devices.revokeAllOf(id) : 0;
      // 6. The browsers that get notices.
      const subscriptions = push ? push.unsubscribe(id)
        : hasTable('push_subscriptions') ? database.run('DELETE FROM push_subscriptions WHERE user_id = ?', id).changes : 0;
      // 7. The AI clients of AuthKit, refused here from now on: every token issued until now.
      let aiClients = 0;
      if (subject && connections && hasTable('idp_connections')) {
        for (const row of database.all("SELECT client_id FROM idp_connections WHERE provider = 'workos' AND subject = ?", String(subject))) {
          connections.revoke(subject, row.client_id);
          aiClients += 1;
        }
      }
      return { closed, tokens: revoked, grants, devices: phones, push: subscriptions, ai_clients: aiClients };
    });

    // 7. …and withdrawn at WorkOS, so AuthKit stops refreshing them: a request to another service.
    if (provider && subject && idp?.revokeAllConnections) {
      background(idp.revokeAllConnections(id), `the AI clients of user #${id} stay authorized at ${idp.name || 'the provider'}`);
    }
    // 8. The provider's sessions.
    if (idp?.revokeSession) {
      for (const sid of atProvider) background(idp.revokeSession(sid), `a session at ${idp.name || 'the provider'} stays open`);
    }
    // 9. The open tabs (live channels), and whatever else listens.
    for (const hook of hooks) {
      try { hook(id, { keep }); } catch (err) { log(`[auth] after revoking user #${id}: ${err.message}`); }
    }
    // 10. Said in the audit log.
    audit?.record({
      action: 'auth.revoke_everything', actor: actor === undefined ? id : actor, req,
      targetType: 'user', targetId: id, meta: { reason, ...counts },
    });
    return counts;
  }

  return {
    revokeEverything,
    /** Who hears that someone was revoked: (userId, { keep }) — the live channels, a host's modules' too. */
    whenRevoked: (hook) => { hooks.push(hook); },
  };
}
