import { vi } from 'vitest';

/**
 * Builds an in-memory backend that responds to the same API surface
 * as the real Express server. Tests mount it via:
 *
 *   const server = createFakeServer();
 *   server.install();              // installs global fetch mock
 *   ...test...
 *   server.uninstall();            // restores original fetch
 *
 * State is reset every install(). Tests can also reach into server.state
 * to assert what changed (e.g. last sent email, members list).
 */
export function createFakeServer(initial = {}) {
  const state = {
    classTypes: initial.classTypes ?? [
      { id: 1, name: '长拳 Long Fist' },
      { id: 2, name: '太极 Tai Chi' },
    ],
    members: initial.members ?? [
      {
        id: 1,
        name: 'Alice Test',
        age: 30,
        phone: '555-0001',
        email: 'alice@test.com',
        notes: '',
        active: 1,
        balance: 5,
      },
      {
        id: 2,
        name: 'Bob Demo',
        age: 25,
        phone: '555-0002',
        email: 'bob@demo.com',
        notes: '',
        active: 1,
        balance: 0,
      },
    ],
    settings: initial.settings ?? {
      owner_name: 'Test Owner',
      owner_email: 'owner@example.com',
      smtp_host: '',
      smtp_port: 465,
      smtp_user: '',
      smtp_secure: 1,
      smtp_pass_set: false,
      default_validity_months: 12,
      reminders_enabled: 1,
      updated_at: null,
    },
    batches: initial.batches ?? {
      1: [
        {
          id: 10,
          classId: 1,
          className: '长拳 Long Fist',
          quantity: 5,
          remaining: 5,
          used: 0,
          expiresAt: '2099-12-31',
          note: '',
        },
      ],
    },
    ledger: initial.ledger ?? { 1: [], 2: [] },
    classMessages: [],
    sentTestEmails: [],
    requests: [],
  };

  const handlers = [
    {
      method: 'GET',
      match: /^\/api\/members$/,
      handle: () => state.members,
    },
    {
      method: 'POST',
      match: /^\/api\/members$/,
      handle: (_, body) => {
        const id = Math.max(0, ...state.members.map((m) => m.id)) + 1;
        const m = {
          id,
          name: body.name,
          age: body.age ?? null,
          phone: body.phone ?? '',
          email: body.email ?? '',
          notes: body.notes ?? '',
          active: 1,
          balance: 0,
        };
        state.members.push(m);
        state.batches[id] = [];
        state.ledger[id] = [];
        return { id };
      },
    },
    {
      method: 'GET',
      match: /^\/api\/members\/(\d+)$/,
      handle: (m) => {
        const id = Number(m[1]);
        const member = state.members.find((mm) => mm.id === id);
        if (!member) return { __status: 404, error: 'Member not found' };
        const memberBatches = state.batches[id] ?? [];
        const balance = memberBatches.reduce((s, b) => s + b.remaining, 0);
        const balancesByClass = state.classTypes.map((c) => ({
          classId: c.id,
          name: c.name,
          balance: memberBatches
            .filter((b) => b.classId === c.id)
            .reduce((s, b) => s + b.remaining, 0),
        }));
        return {
          member,
          balance,
          balancesByClass,
          batches: memberBatches,
          ledger: state.ledger[id] ?? [],
        };
      },
    },
    {
      method: 'PATCH',
      match: /^\/api\/members\/(\d+)$/,
      handle: (m, body) => {
        const id = Number(m[1]);
        const member = state.members.find((mm) => mm.id === id);
        if (!member) return { __status: 404, error: 'Member not found' };
        Object.assign(member, body);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      match: /^\/api\/members\/(\d+)\/purchase$/,
      handle: (m, body) => {
        const id = Number(m[1]);
        const member = state.members.find((mm) => mm.id === id);
        if (!member) return { __status: 404, error: 'Member not found' };
        const cls = state.classTypes.find((c) => c.id === Number(body.classId));
        const batch = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          classId: cls.id,
          className: cls.name,
          quantity: Number(body.classes),
          remaining: Number(body.classes),
          used: 0,
          expiresAt: body.noExpiry ? null : body.expiresAt ?? null,
          note: body.note ?? '',
        };
        state.batches[id] = [...(state.batches[id] ?? []), batch];
        member.balance = state.batches[id].reduce((s, b) => s + b.remaining, 0);
        return { ok: true, batchId: batch.id };
      },
    },
    {
      method: 'POST',
      match: /^\/api\/members\/(\d+)\/attend$/,
      handle: (m, body) => {
        const id = Number(m[1]);
        const member = state.members.find((mm) => mm.id === id);
        if (!member) return { __status: 404, error: 'Member not found' };
        const memberBatches = state.batches[id] ?? [];
        const matching = memberBatches.filter((b) => b.classId === Number(body.classId));
        let need = Number(body.count);
        const total = matching.reduce((s, b) => s + b.remaining, 0);
        if (total < need) return { __status: 400, error: 'Insufficient credits' };
        for (const b of matching) {
          if (need <= 0) break;
          const take = Math.min(need, b.remaining);
          b.remaining -= take;
          b.used += take;
          need -= take;
        }
        member.balance = memberBatches.reduce((s, b) => s + b.remaining, 0);
        state.ledger[id] = state.ledger[id] ?? [];
        state.ledger[id].push({
          id: state.ledger[id].length + 1,
          delta: -Number(body.count),
          class_name: state.classTypes.find((c) => c.id === Number(body.classId))?.name,
          note: body.note ?? '',
          created_at: new Date().toISOString(),
        });
        return { ok: true };
      },
    },
    {
      method: 'GET',
      match: /^\/api\/class-types$/,
      handle: () => state.classTypes,
    },
    {
      method: 'POST',
      match: /^\/api\/class-types$/,
      handle: (_, body) => {
        const id = Math.max(0, ...state.classTypes.map((c) => c.id)) + 1;
        const c = { id, name: body.name };
        state.classTypes.push(c);
        return c;
      },
    },
    {
      method: 'DELETE',
      match: /^\/api\/class-types\/(\d+)$/,
      handle: (m) => {
        const id = Number(m[1]);
        if (state.classTypes.length <= 1) {
          return { __status: 400, error: 'Cannot remove the last class type' };
        }
        state.classTypes = state.classTypes.filter((c) => c.id !== id);
        return { ok: true };
      },
    },
    {
      method: 'GET',
      match: /^\/api\/class-types\/(\d+)\/email-recipients$/,
      handle: (m) => {
        const id = Number(m[1]);
        const recipients = state.members
          .filter((mm) => mm.active && mm.email && mm.balance > 0)
          .map((mm) => ({ id: mm.id, name: mm.name, email: mm.email }));
        return {
          classId: id,
          recipients,
          totalActive: state.members.filter((mm) => mm.active).length,
          noEmail: 0,
        };
      },
    },
    {
      method: 'POST',
      match: /^\/api\/class-types\/(\d+)\/email$/,
      handle: (m, body) => {
        const id = Number(m[1]);
        if (!state.settings.smtp_host) {
          return { __status: 400, error: 'SMTP not configured' };
        }
        state.classMessages.push({
          id: state.classMessages.length + 1,
          classId: id,
          subject: body.subject,
          body: body.body,
          recipientCount: body.recipientIds?.length ?? 0,
          createdAt: new Date().toISOString(),
        });
        return { ok: true, sent: body.recipientIds?.length ?? 0 };
      },
    },
    {
      method: 'GET',
      match: /^\/api\/class-messages$/,
      handle: () => ({ messages: state.classMessages }),
    },
    {
      method: 'GET',
      match: /^\/api\/summary$/,
      handle: () => ({
        classTypes: state.classTypes,
        members: state.members.map((m) => ({
          id: m.id,
          name: m.name,
          age: m.age,
          phone: m.phone,
          email: m.email,
          active: m.active,
          balanceTotal: m.balance,
          byClass: state.classTypes.map((c) => ({
            classId: c.id,
            balance: (state.batches[m.id] ?? [])
              .filter((b) => b.classId === c.id)
              .reduce((s, b) => s + b.remaining, 0),
            visits: 0,
          })),
        })),
      }),
    },
    {
      method: 'GET',
      match: /^\/api\/settings$/,
      handle: () => state.settings,
    },
    {
      method: 'PATCH',
      match: /^\/api\/settings$/,
      handle: (_, body) => {
        Object.assign(state.settings, body);
        if (body.smtp_pass) state.settings.smtp_pass_set = true;
        state.settings.updated_at = new Date().toISOString();
        return state.settings;
      },
    },
    {
      method: 'POST',
      match: /^\/api\/settings\/test-email$/,
      handle: (_, body) => {
        if (!state.settings.smtp_host) {
          return { __status: 400, error: 'SMTP not configured' };
        }
        const to = body.to || state.settings.owner_email;
        state.sentTestEmails.push({ to });
        return { ok: true, to };
      },
    },
  ];

  let originalFetch;

  const fakeFetch = vi.fn(async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    state.requests.push({ method, url, body });
    for (const h of handlers) {
      if (h.method !== method) continue;
      const m = url.match(h.match);
      if (m) {
        const result = h.handle(m, body);
        if (result && typeof result === 'object' && '__status' in result) {
          const { __status, ...rest } = result;
          return new Response(JSON.stringify(rest), {
            status: __status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(result ?? null), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: `No handler for ${method} ${url}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return {
    state,
    fakeFetch,
    install() {
      originalFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch;
    },
    uninstall() {
      globalThis.fetch = originalFetch;
    },
  };
}
