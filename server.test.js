const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");

// Isolate credentials and disable external notifications during HTTP tests.
process.env.API_KEY = "local-test-key";
process.env.DISCORD_WEBHOOK_URL = "";
process.env.CALLMEBOT = "";
process.env.WHATSAPP_IP = "http://whatsapp.test/";
process.env.WHATSAPP_TO_NUMBER = "";
process.env.SCHEDULE_TIMEZONE_OFFSET = "-03:00";
const server = require("./server");
let baseUrl;
const originalFetch = global.fetch;
let healthResponse = async () => new Response(JSON.stringify({
  status: "ok", whatsapp: { ready: true },
}));

before(async () => {
  mock.method(global, "fetch", (url, options) => {
    if (url === "http://whatsapp.test/health") {
      assert.ok(options.signal instanceof AbortSignal);
      return healthResponse();
    }
    return originalFetch(url, options);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  mock.restoreAll();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

async function request(route, method = "GET", body, authenticated = true) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { "x-api-key": "local-test-key" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function assertAbsent(machine) {
  const result = await request("/devices");
  assert.equal(result.status, 200);
  assert.equal(result.body.devices.some((device) => device.machine === machine), false);
}

test("devices appends bot-whatsapp and handles health failures", async () => {
  const defaultHealthResponse = healthResponse;
  const cases = [
    [() => new Response(JSON.stringify({ status: "ok", whatsapp: { ready: true } })), true],
    [() => new Response(JSON.stringify({ status: "ok", whatsapp: { ready: false } })), false],
    [() => new Response(JSON.stringify({ status: "error", whatsapp: { ready: true } })), false],
    [() => new Response(JSON.stringify({ status: "ok", whatsapp: { ready: "true" } })), false],
    [() => new Response('{}'), false],
    [() => new Response('null'), false],
    [() => new Response('invalid json'), false],
    [() => new Response('{}', { status: 503 }), false],
    [() => { throw new TypeError("Connection failed"); }, false],
    [() => { throw new DOMException("Timed out", "TimeoutError"); }, false],
  ];
  try {
    await request("/consultar-maquina/health-test");
    for (const [respond, online] of cases) {
      healthResponse = respond;
      const result = await request("/devices", "GET", undefined, false);
      assert.equal(result.status, 200);
      assert.equal(result.body.total, result.body.devices.length);
      assert.equal(result.body.devices[0].machine, "health-test");
      const bot = result.body.devices.at(-1);
      assert.equal(bot.machine, "bot-whatsapp");
      assert.equal(bot.online, online);
      assert.equal(bot.status, online ? "online" : "offline");
      assert.equal(bot.lastSeenAt !== null, online);
    }
  } finally {
    healthResponse = defaultHealthResponse;
    await request("/devices?machine=health-test", "DELETE");
  }
});

test("deleted device stays absent after dashboard refresh and failed deletes", async () => {
  const machine = "delete-device-test";
  await request(`/consultar-maquina/${machine}`);
  const scheduled = await request("/agendar-racao", "POST", {
    machine, data: "2099-01-01", hora: "12:00", tempoMs: 1500, repeat: true,
  });
  assert.equal(scheduled.status, 200);
  assert.equal((await request("/liberar-racao", "POST", { machine, tempoMs: 1500 })).status, 200);
  assert.equal((await request(`/devices?machine=${machine}`, "DELETE", undefined, false)).status, 401);
  const removed = await request(`/devices?machine=${machine}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removido, true);
  await assertAbsent(machine);

  const status = await request(`/status?machine=${machine}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.online, false);
  assert.equal(status.body.pendingReleaseCount, 0);
  assert.equal(status.body.scheduledReleaseCount, 0);
  await assertAbsent(machine);
  assert.deepEqual((await request(`/agendamentos?machine=${machine}`)).body.agendamentos, []);
  await assertAbsent(machine);
  assert.equal((await request(`/agendamentos?machine=${machine}&id=missing`, "DELETE")).status, 404);
  await assertAbsent(machine);
  assert.equal((await request(`/devices?machine=${machine}`, "DELETE")).status, 404);
  assert.equal((await request("/devices", "DELETE")).status, 400);

  // A real device heartbeat still registers it again, with its old queues cleared.
  assert.equal((await request(`/consultar-maquina/${machine}`)).body.retorno, "0001");
  const devices = (await request("/devices")).body.devices;
  assert.equal(devices.find((device) => device.machine === machine).online, true);
  assert.equal((await request(`/status?machine=${machine}`)).body.scheduledReleaseCount, 0);
  await request(`/devices?machine=${machine}`, "DELETE");
});

test("schedule DELETE removes only the selected schedule", async () => {
  const machine = "delete-schedule-test";
  const ids = [];
  for (const hora of ["12:00", "13:00"]) {
    const result = await request("/agendar-racao", "POST", {
      machine, data: "2099-01-01", hora, tempoMs: 1500, repeat: true,
    });
    assert.equal(result.status, 200);
    ids.push(result.body.agendamentosCriados[0].id);
  }
  const removed = await request(`/agendamentos?machine=${machine}&id=${ids[0]}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.totalAgendamentosAtivos, 1);
  const remaining = (await request(`/agendamentos?machine=${machine}`)).body.agendamentos;
  assert.deepEqual(remaining.map((schedule) => schedule.id), [ids[1]]);
  assert.equal((await request(`/agendamentos?machine=${machine}&id=${ids[0]}`, "DELETE")).status, 404);
  await request(`/devices?machine=${machine}`, "DELETE");
});
