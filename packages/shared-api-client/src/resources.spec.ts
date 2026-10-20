import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { authApi, casesApi, clientsApi, courtsApi, officesApi, usersApi } from './resources.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });

const session = {
  accessToken: 'access-1',
  expiresIn: 900,
  user: {
    id: '01920000-0000-7000-8000-000000000001',
    fullName: 'Layla Haddad',
    email: 'layla@example.test',
    role: 'OFFICE_MANAGER',
    officeId: '01920000-0000-7000-8000-000000000002',
    officeName: 'Haddad Law',
    uiLanguage: 'AR',
    permissions: ['create:case'],
    emailVerified: true,
    verifyBy: null,
    idleMinutes: 30,
  },
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setup(token: string | null = null) {
  const store = { token };
  const onAuthFailure = vi.fn();
  const client = createApiClient({
    baseURL: ORIGIN,
    realm: 'office',
    getToken: () => store.token,
    setToken: (next) => {
      store.token = next;
    },
    onAuthFailure,
  });
  return {
    auth: authApi(client),
    users: usersApi(client),
    cases: casesApi(client),
    clients: clientsApi(client),
    courts: courtsApi(client),
    offices: officesApi(client),
    store,
    onAuthFailure,
  };
}

const registration = {
  fullName: 'Layla Haddad',
  email: 'layla@example.test',
  password: 'Testtesttest1',
  officeName: 'Haddad Law',
  accountType: 'FIRM',
  currency: 'ILS',
  acceptTerms: true,
  acceptPrivacy: true,
} as const;

describe('authApi', () => {
  it.each([
    ['login', { email: 'layla@example.test', password: 'Testtesttest1' }],
    ['register', registration],
  ] as const)(
    'should %s, keep the access token in the client and return the session without it',
    async (call, input) => {
      let body: unknown;
      server.use(
        http.post(url(`auth/${call}`), async ({ request }) => {
          body = await request.json();
          return ok(session, call === 'register' ? 201 : 200);
        }),
      );
      const { auth, store } = setup();
      const result =
        call === 'login'
          ? await auth.login(input)
          : await auth.register(input as typeof registration);
      expect(result.user.role).toBe('OFFICE_MANAGER');
      expect(result).not.toHaveProperty('accessToken');
      expect(store.token).toBe('access-1');
      expect(body).toEqual(input);
    },
  );

  it('should reject a session that breaks the contract without storing its token', async () => {
    server.use(http.post(url('auth/login'), () => ok({ accessToken: 'access-1' })));
    const { auth, store } = setup();
    await expect(
      auth.login({ email: 'layla@example.test', password: 'Testtesttest1' }),
    ).rejects.toMatchObject({ code: 'SYS-001' });
    expect(store.token).toBeNull();
  });

  it('should pass a refused login through and store nothing', async () => {
    server.use(
      http.post(url('auth/login'), () =>
        HttpResponse.json(
          { success: false, error: { code: 'AUTH-007', message: 'Locked' }, meta },
          { status: 423 },
        ),
      ),
    );
    const { auth, store, onAuthFailure } = setup();
    await expect(
      auth.login({ email: 'layla@example.test', password: 'Testtesttest1' }),
    ).rejects.toMatchObject({ code: 'AUTH-007', status: 423 });
    expect(store.token).toBeNull();
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should restore the session from the refresh cookie', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({ ...session, accessToken: 'access-2' })));
    const { auth, store } = setup();
    const restored = await auth.refresh();
    expect(restored).toMatchObject({ user: { officeName: 'Haddad Law' } });
    expect(restored).not.toHaveProperty('accessToken');
    expect(store.token).toBe('access-2');
  });

  it('should reject without onAuthFailure when there is no session to restore (public pages stay put)', async () => {
    server.use(
      http.post(url('auth/refresh'), () =>
        HttpResponse.json(
          { success: false, error: { code: 'AUTH-005', message: 'No session' }, meta },
          { status: 401 },
        ),
      ),
    );
    const { auth, onAuthFailure } = setup();
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should turn a restored session that breaks the contract into SYS-001 and drop its token', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({ accessToken: 'access-2' })));
    const { auth, store } = setup();
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'SYS-001' });
    expect(store.token).toBeNull();
  });

  it('should clear the token on logout, also when the server cannot be reached', async () => {
    server.use(http.post(url('auth/logout'), () => new HttpResponse(null, { status: 204 })));
    const { auth, store } = setup('access-1');
    await auth.logout();
    expect(store.token).toBeNull();

    server.use(http.post(url('auth/logout'), () => HttpResponse.error()));
    store.token = 'access-1';
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SYS-002' });
    expect(store.token).toBeNull();
  });

  it.each([
    ['verifyEmail', 'auth/verify-email', { token: 'a'.repeat(43) }, 204],
    ['resendVerification', 'auth/resend-verification', { email: 'layla@example.test' }, 202],
    ['forgotPassword', 'auth/forgot-password', { email: 'layla@example.test' }, 200],
    [
      'resetPassword',
      'auth/reset-password',
      { token: 'a'.repeat(43), newPassword: 'Testtesttest1', confirmPassword: 'Testtesttest1' },
      204,
    ],
  ] as const)('should call %s on %s', async (call, path, input, status) => {
    let body: unknown;
    server.use(
      http.post(url(path), async ({ request }) => {
        body = await request.json();
        return status === 204 ? new HttpResponse(null, { status }) : ok(null, status);
      }),
    );
    const { auth } = setup();
    await expect((auth[call] as (body: unknown) => Promise<void>)(input)).resolves.toBeUndefined();
    expect(body).toEqual(input);
  });
});

describe('usersApi', () => {
  it('should change the password with the bearer token', async () => {
    let authorization: string | null = null;
    server.use(
      http.post(url('users/me/password'), ({ request }) => {
        authorization = request.headers.get('authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      setup('access-1').users.changePassword({
        currentPassword: 'Testtesttest1',
        newPassword: 'Testtesttest2',
      }),
    ).resolves.toBeUndefined();
    expect(authorization).toBe('Bearer access-1');
  });
});

describe('casesApi', () => {
  const row = {
    id: '01920000-0000-7000-8000-0000000000f1',
    fileNumber: '2026-LIT-00001',
    title: 'Land dispute',
    fileType: 'LITIGATION',
    status: 'OPEN',
    priority: 'HIGH',
    openingDate: '2026-10-01',
    isConfidential: false,
    primaryClient: null,
    responsibleLawyer: { id: '01920000-0000-7000-8000-000000000001', fullName: 'Layla Haddad' },
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
  const pagination = { page: 2, limit: 20, total: 21, totalPages: 2, hasMore: false };

  it('should send the filters and return the rows with the pagination', async () => {
    let query = '';
    server.use(
      http.get(url('cases'), ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ success: true, data: [row], meta: { ...meta, pagination } });
      }),
    );
    await expect(
      setup('access-1').cases.list({ fileType: 'NDA_REVIEW,RENTAL_AGREEMENT', page: '2' }),
    ).resolves.toEqual({ items: [row], pagination });
    expect(new URLSearchParams(query).get('fileType')).toBe('NDA_REVIEW,RENTAL_AGREEMENT');
  });

  it.each([
    ['a row that breaks the contract', [{ ...row, status: 'LOST' }], pagination],
    ['no pagination', [row], undefined],
  ])('should refuse %s as SYS-001', async (_case, data, page) => {
    server.use(
      http.get(url('cases'), () =>
        HttpResponse.json({ success: true, data, meta: { ...meta, pagination: page } }),
      ),
    );
    await expect(setup('access-1').cases.list({})).rejects.toMatchObject({ code: 'SYS-001' });
  });
  const detail = {
    ...row,
    description: null,
    subType: null,
    closingDate: null,
    responsibleParalegal: null,
    courtCaseNumber: null,
    court: null,
    judge: null,
    jurisdiction: 'PALESTINE',
    billingMethod: null,
    hourlyRate: null,
    fixedFee: null,
    retainerBalance: null,
    currency: 'ILS',
    clients: [],
    team: [],
    counts: { parties: 0, notes: 0 },
    createdAt: '2026-10-01T10:00:00.000Z',
  };

  it('should get, update and delete one file', async () => {
    const seen: string[] = [];
    let body: unknown;
    server.use(
      http.get(url(`cases/${row.id}`), () => ok(detail)),
      http.patch(url(`cases/${row.id}`), async ({ request }) => {
        body = await request.json();
        return ok({ ...detail, title: 'Renamed' });
      }),
      http.delete(url(`cases/${row.id}`), ({ request }) => {
        seen.push(request.method);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { cases } = setup('access-1');
    await expect(cases.get(row.id)).resolves.toEqual(detail);
    await expect(cases.update(row.id, { title: 'Renamed' })).resolves.toMatchObject({
      title: 'Renamed',
    });
    expect(body).toEqual({ title: 'Renamed' });
    await expect(cases.remove(row.id)).resolves.toBeUndefined();
    expect(seen).toEqual(['DELETE']);
  });

  it('should create a file and return it', async () => {
    let body: unknown;
    server.use(
      http.post(url('cases'), async ({ request }) => {
        body = await request.json();
        return ok(detail, 201);
      }),
    );
    const create = {
      title: 'Land dispute',
      fileType: 'LITIGATION' as const,
      clientIds: ['01920000-0000-7000-8000-0000000000c1'],
      primaryClientId: '01920000-0000-7000-8000-0000000000c1',
      responsibleLawyerId: '01920000-0000-7000-8000-000000000001',
    };
    await expect(setup('access-1').cases.create(create)).resolves.toEqual(detail);
    expect(body).toEqual(create);
  });

  it('should refuse a detail that breaks the contract as SYS-001', async () => {
    server.use(http.get(url(`cases/${row.id}`), () => ok({ ...detail, counts: undefined })));
    await expect(setup('access-1').cases.get(row.id)).rejects.toMatchObject({ code: 'SYS-001' });
  });
});

describe('usersApi.directory and courtsApi', () => {
  const courtId = '01920000-0000-7000-8000-0000000000e1';
  const court = {
    id: courtId,
    jurisdiction: 'PALESTINE',
    courtType: 'FIRST_INSTANCE',
    nameAr: 'محكمة بداية رام الله',
    nameEn: 'Ramallah First Instance Court',
    city: 'Ramallah',
    address: null,
    phone: null,
    email: null,
    isPlatform: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
  const judge = {
    id: '01920000-0000-7000-8000-0000000000e2',
    courtId,
    fullName: 'Judge Salem',
    isActive: true,
    notes: null,
    isPlatform: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
  const people = [
    { id: '01920000-0000-7000-8000-000000000001', fullName: 'Layla Haddad', role: 'LAWYER' },
  ];

  it('should read the directory, search courts and list the judges of a court', async () => {
    let query = '';
    server.use(
      http.get(url('users/directory'), () => ok(people)),
      http.get(url('courts'), ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({
          success: true,
          data: [court],
          meta: {
            ...meta,
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
          },
        });
      }),
      http.get(url(`courts/${courtId}/judges`), () => ok([judge])),
    );
    const { users, courts } = setup('access-1');
    await expect(users.directory()).resolves.toEqual(people);
    await expect(courts.list({ search: 'رام' })).resolves.toMatchObject({ items: [court] });
    expect(new URLSearchParams(query).get('search')).toBe('رام');
    await expect(courts.judges(courtId)).resolves.toEqual([judge]);
  });

  it('should refuse a directory entry with an unknown role as SYS-001', async () => {
    server.use(http.get(url('users/directory'), () => ok([{ ...people[0], role: 'CEO' }])));
    await expect(setup('access-1').users.directory()).rejects.toMatchObject({ code: 'SYS-001' });
  });
});

describe('officesApi', () => {
  it('should read the subscription and check it against the contract', async () => {
    const subscription = {
      plan: { code: 'PS_FREE', name: 'Free' },
      status: 'TRIALING',
      readOnly: false,
      periodEnd: '2027-04-01T00:00:00.000Z',
      trialEndsAt: '2027-04-01T00:00:00.000Z',
      limits: { users: 5, storageMb: 2048, aiMonthly: 5 },
      features: { ai: true, clientPortal: true, googleVisionOcr: false },
      usage: { users: 2, storageMb: 1, aiThisMonth: 0 },
    };
    server.use(http.get(url('offices/me/subscription'), () => ok(subscription)));
    const { offices } = setup('access-1');
    await expect(offices.subscription()).resolves.toEqual(subscription);
    server.use(
      http.get(url('offices/me/subscription'), () => ok({ ...subscription, status: 'GONE' })),
    );
    await expect(offices.subscription()).rejects.toMatchObject({ code: 'SYS-001' });
  });

  it('should read and patch the profile and the settings', async () => {
    const profile = {
      id: '01920000-0000-7000-8000-0000000000e1',
      name: 'Haddad Law',
      registrationNumber: null,
      taxId: null,
      phone: null,
      email: null,
      address: null,
      website: null,
      jurisdiction: 'PALESTINE',
      accountType: 'FIRM',
      defaultLanguage: 'AR',
      currency: 'ILS',
      timezone: 'Asia/Hebron',
    };
    const settings = {
      courtReminderDays: [7, 3, 1],
      taskReminderDays: [1],
      defaultBillingRate: null,
      defaultBillingMethod: 'HOURLY',
      taxRatePercent: '0.00',
      enableAi: true,
      enableOcr: true,
      fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}',
      sessionIdleMinutes: 30,
      auditRetentionDays: 365,
    };
    const bodies: unknown[] = [];
    server.use(
      http.get(url('offices/me'), () => ok(profile)),
      http.patch(url('offices/me'), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...profile, name: 'New' });
      }),
      http.get(url('offices/me/settings'), () => ok(settings)),
      http.patch(url('offices/me/settings'), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...settings, enableAi: false });
      }),
    );
    const { offices } = setup('access-1');
    await expect(offices.profile()).resolves.toEqual(profile);
    await expect(offices.updateProfile({ name: 'New' })).resolves.toMatchObject({ name: 'New' });
    await expect(offices.settings()).resolves.toEqual(settings);
    await expect(offices.updateSettings({ enableAi: false })).resolves.toMatchObject({
      enableAi: false,
    });
    expect(bodies).toEqual([{ name: 'New' }, { enableAi: false }]);
  });
});

describe('clientsApi', () => {
  const id = '01920000-0000-7000-8000-0000000000c1';
  const contactId = '01920000-0000-7000-8000-0000000000d1';
  const row = {
    id,
    clientType: 'INDIVIDUAL',
    displayName: 'Omar Khalil',
    fullName: 'Omar Khalil',
    companyName: null,
    phone: '+970599000000',
    email: null,
    isActive: true,
    primaryLawyer: null,
    openFiles: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
  const contact = {
    id: contactId,
    fullName: 'Sara Khalil',
    position: null,
    email: null,
    phone: null,
    isPrimary: true,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
  const detail = {
    ...row,
    nationalId: null,
    taxId: null,
    address: null,
    industry: null,
    closedFiles: 0,
    contacts: [contact],
  };
  const pagination = { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false };

  it('should list with the filters and create, get and update a client', async () => {
    let query = '';
    const bodies: unknown[] = [];
    server.use(
      http.get(url('clients'), ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ success: true, data: [row], meta: { ...meta, pagination } });
      }),
      http.post(url('clients'), async ({ request }) => {
        bodies.push(await request.json());
        return ok(detail, 201);
      }),
      http.get(url(`clients/${id}`), () => ok(detail)),
      http.patch(url(`clients/${id}`), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...detail, isActive: false });
      }),
    );
    const { clients } = setup('access-1');
    await expect(clients.list({ search: 'omar', isActive: 'true' })).resolves.toEqual({
      items: [row],
      pagination,
    });
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      search: 'omar',
      isActive: 'true',
    });
    await expect(
      clients.create({ clientType: 'INDIVIDUAL', displayName: 'Omar Khalil' }),
    ).resolves.toEqual(detail);
    await expect(clients.get(id)).resolves.toEqual(detail);
    await expect(clients.update(id, { isActive: false })).resolves.toMatchObject({
      isActive: false,
    });
    expect(bodies).toEqual([
      { clientType: 'INDIVIDUAL', displayName: 'Omar Khalil' },
      { isActive: false },
    ]);
  });

  it('should add, update and remove a contact person', async () => {
    const seen: string[] = [];
    server.use(
      http.post(url(`clients/${id}/contacts`), () => ok(contact, 201)),
      http.patch(url(`clients/${id}/contacts/${contactId}`), () =>
        ok({ ...contact, position: 'CFO' }),
      ),
      http.delete(url(`clients/${id}/contacts/${contactId}`), ({ request }) => {
        seen.push(request.method);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { clients } = setup('access-1');
    await expect(clients.addContact(id, { fullName: 'Sara Khalil' })).resolves.toEqual(contact);
    await expect(clients.updateContact(id, contactId, { position: 'CFO' })).resolves.toMatchObject({
      position: 'CFO',
    });
    await expect(clients.removeContact(id, contactId)).resolves.toBeUndefined();
    expect(seen).toEqual(['DELETE']);
  });

  it('should refuse a client that breaks the contract as SYS-001', async () => {
    server.use(http.get(url(`clients/${id}`), () => ok({ ...detail, contacts: undefined })));
    await expect(setup('access-1').clients.get(id)).rejects.toMatchObject({ code: 'SYS-001' });
  });
});

describe('usersApi team management', () => {
  const id = '01920000-0000-7000-8000-0000000000a1';
  const member = {
    id,
    fullName: 'Adel Lawyer',
    email: 'adel@example.test',
    role: 'LAWYER',
    isActive: true,
    openFiles: 1,
    lastLoginAt: null,
  };

  it('should list the team, read open files and send role, deactivate and reactivate', async () => {
    const bodies: unknown[] = [];
    const record = async ({ request }: { request: Request }) => {
      bodies.push(
        request.method === 'POST' && !request.url.endsWith('reactivate')
          ? await request.json()
          : request.method,
      );
      return ok({ ...member, isActive: !request.url.endsWith('deactivate') });
    };
    server.use(
      http.get(url('users'), () => ok([member])),
      http.get(url(`users/${id}/open-files`), () =>
        ok([{ id, fileNumber: '2026-LIT-00001', title: 'Land' }]),
      ),
      http.patch(url(`users/${id}/role`), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...member, role: 'SENIOR_LAWYER' });
      }),
      http.post(url(`users/${id}/deactivate`), record),
      http.post(url(`users/${id}/reactivate`), record),
    );
    const { users } = setup('access-1');
    await expect(users.team()).resolves.toEqual([member]);
    await expect(users.openFiles(id)).resolves.toHaveLength(1);
    await expect(users.changeRole(id, { role: 'SENIOR_LAWYER' })).resolves.toMatchObject({
      role: 'SENIOR_LAWYER',
    });
    await expect(users.deactivate(id, { reassignments: [] })).resolves.toMatchObject({
      isActive: false,
    });
    await expect(users.reactivate(id)).resolves.toMatchObject({ isActive: true });
    expect(bodies).toEqual([{ role: 'SENIOR_LAWYER' }, { reassignments: [] }, 'POST']);
  });
});
