const assert = require("node:assert/strict");
const { test } = require("node:test");

for (const scenario of [
  { name: "configured service takes priority", ip: "http://104.234.63.144:3000/", number: "5500000000000", service: true },
  { name: "missing IP uses CallMeBot", ip: "", number: "5500000000000", service: false },
  { name: "missing number uses CallMeBot", ip: "http://104.234.63.144:3000", number: " ", service: false },
  { name: "service failure does not send through CallMeBot", ip: "http://104.234.63.144:3000", number: "5500000000000", service: true, fails: true },
  { name: "service HTTP failure alerts Discord", ip: "http://104.234.63.144:3000", number: "5500000000000", service: true, httpFailure: true },
  { name: "CallMeBot connection failure alerts Discord", ip: "", number: "", service: false, fails: true },
  { name: "CallMeBot HTTP failure alerts Discord", ip: "", number: "", service: false, httpFailure: true },
  { name: "WhatsApp timeout alerts Discord", ip: "http://104.234.63.144:3000", number: "5500000000000", service: true, timeout: true },
]) {
  test(scenario.name, async (t) => {
    process.env.API_KEY = "local-test-key";
    process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";
    process.env.CALLMEBOT = "https://callmebot.test/whatsapp.php?phone=123&apikey=test-key";
    process.env.WHATSAPP_IP = scenario.ip;
    process.env.WHATSAPP_TO_NUMBER = scenario.number;
    process.env.WHATSAPP_API_KEY = "whatsapp-test-key";
    delete require.cache[require.resolve("./server")];
    const server = require("./server");
    const originalFetch = global.fetch;
    const sent = [];
    const discordMessages = [];
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args));
    t.mock.method(global, "fetch", async (url, options) => {
      if (String(url) === "https://discord.test/webhook") {
        discordMessages.push(JSON.parse(options.body).content);
        return new Response("{}");
      }
      sent.push({ url: String(url), options });
      if (scenario.fails) throw new Error("Service unavailable");
      if (scenario.timeout) throw new DOMException("Timed out", "TimeoutError");
      if (scenario.httpFailure) return new Response("{}", { status: 503 });
      return new Response("{}");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const heartbeat = () => originalFetch(`${baseUrl}/consultar-maquina/notification-test`);
      await (await heartbeat()).json();
      const release = await originalFetch(`${baseUrl}/liberar-racao`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "local-test-key" },
        body: JSON.stringify({ machine: "notification-test", tempoMs: 1500 }),
      });
      assert.equal(release.status, 200);
      await release.json();
      assert.equal((await (await heartbeat()).json()).retorno, "0001");
      assert.equal(sent.length, 1);
      const { url, options } = sent[0];
      if (scenario.service) {
        assert.equal(url, "http://104.234.63.144:3000/enviar");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-api-key"], "whatsapp-test-key");
        assert.equal(options.headers["Content-Type"], "application/json");
        const payload = JSON.parse(options.body);
        assert.equal(payload.numero, "5500000000000");
        assert.match(payload.texto, /Racao dispensada para notification-test/);
      } else {
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://callmebot.test");
        assert.equal(options.method, "GET");
        assert.match(parsed.searchParams.get("text"), /Racao dispensada para notification-test/);
      }
      const failed = scenario.fails || scenario.httpFailure || scenario.timeout;
      assert.equal(errors.length, failed ? 1 : 0);
      assert.equal(discordMessages.length, failed ? 2 : 1);
      if (failed) {
        assert.equal(discordMessages[1], `Falha ao enviar mensagem pelo WhatsApp.\n\n${discordMessages[0]}`);
      }
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  });
}
