const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadEnvFile();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const CALLMEBOT = process.env.CALLMEBOT || "";
const ACTIVE_MACHINE_LABEL = process.env.ACTIVE_MACHINE_LABEL || "dog1";
const ONLINE_WINDOW_MS = 30 * 1000;
const SCHEDULE_TIMEZONE_OFFSET =
  process.env.SCHEDULE_TIMEZONE_OFFSET || "-03:00";
const SCHEDULE_GRACE_MS = 60 * 1000;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

const machines = new Map();
const CALLMEBOT_CONFIG = parseCallMeBotConfig(CALLMEBOT);

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function createMachineState() {
  return {
    lastSeenAt: null,
    pendingReleases: [],
    schedules: [],
  };
}

function parseCallMeBotConfig(callMeBotUrl) {
  if (!callMeBotUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(callMeBotUrl);
    const phone = parsedUrl.searchParams.get("phone") || "";
    const apikey = parsedUrl.searchParams.get("apikey") || "";
    const pathname = parsedUrl.pathname || "/whatsapp.php";

    if (!phone || !apikey) {
      return null;
    }

    return {
      origin: parsedUrl.origin,
      pathname,
      phone,
      apikey,
    };
  } catch (error) {
    console.error("CALLMEBOT invalida:", error);
    return null;
  }
}

function getMachineState(machine) {
  if (!machines.has(machine)) {
    machines.set(machine, createMachineState());
  }

  return machines.get(machine);
}

function isOnline(lastSeenAt) {
  return Boolean(lastSeenAt) && Date.now() - lastSeenAt <= ONLINE_WINDOW_MS;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(text);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function sortSchedules(state) {
  state.schedules.sort((a, b) => a.scheduledReleaseAt - b.scheduledReleaseAt);
}

function getNextSchedule(state) {
  sortSchedules(state);
  return state.schedules[0] || null;
}

function getTimezoneOffsetMinutes() {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(SCHEDULE_TIMEZONE_OFFSET);

  if (!match) {
    return -180;
  }

  const [, sign, hoursText, minutesText] = match;
  const totalMinutes = Number(hoursText) * 60 + Number(minutesText);
  return sign === "-" ? -totalMinutes : totalMinutes;
}

function getLocalDateTimeParts(timestamp) {
  const shiftedDate = new Date(
    timestamp + getTimezoneOffsetMinutes() * 60 * 1000
  );
  const year = shiftedDate.getUTCFullYear();
  const month = String(shiftedDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shiftedDate.getUTCDate()).padStart(2, "0");
  const hour = String(shiftedDate.getUTCHours()).padStart(2, "0");
  const minute = String(shiftedDate.getUTCMinutes()).padStart(2, "0");
  const second = String(shiftedDate.getUTCSeconds()).padStart(2, "0");

  return {
    data: `${year}-${month}-${day}`,
    hora: `${hour}:${minute}:${second}`,
  };
}

function getLocalWeekdayName(timestamp) {
  const shiftedDate = new Date(
    timestamp + getTimezoneOffsetMinutes() * 60 * 1000
  );
  const weekdayNames = [
    "domingo",
    "segunda-feira",
    "terca-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sabado",
  ];

  return weekdayNames[shiftedDate.getUTCDay()];
}

function formatDurationForDiscord(durationMs) {
  if (durationMs % 1000 === 0) {
    const totalSeconds = durationMs / 1000;
    return `${totalSeconds} segundo${totalSeconds === 1 ? "" : "s"}`;
  }

  return `${durationMs} ms`;
}

function formatRemainingTime(targetTimestamp) {
  if (!targetTimestamp) {
    return null;
  }

  const remainingMs = targetTimestamp - Date.now();

  if (remainingMs <= 0) {
    return "0s";
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function parseScheduledDateTime(data, hora) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return { scheduledAt: null, hasExplicitSeconds: false };
  }

  const hasExplicitSeconds = /^\d{2}:\d{2}:\d{2}$/.test(hora);
  const hasOnlyHourAndMinute = /^\d{2}:\d{2}$/.test(hora);
  const normalizedHour = hasOnlyHourAndMinute ? `${hora}:00` : hora;

  if (!/^\d{2}:\d{2}:\d{2}$/.test(normalizedHour)) {
    return { scheduledAt: null, hasExplicitSeconds: false };
  }

  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(
    SCHEDULE_TIMEZONE_OFFSET
  );

  if (!offsetMatch) {
    return { scheduledAt: null, hasExplicitSeconds: false };
  }

  const [, signal, offsetHoursText, offsetMinutesText] = offsetMatch;
  const [year, month, day] = data.split("-").map(Number);
  const [hours, minutes, seconds] = normalizedHour.split(":").map(Number);
  const offsetMinutes =
    Number(offsetHoursText) * 60 + Number(offsetMinutesText);
  const signedOffsetMinutes =
    signal === "-" ? -offsetMinutes : offsetMinutes;
  const utcTimestamp =
    Date.UTC(year, month - 1, day, hours, minutes, seconds) -
    signedOffsetMinutes * 60 * 1000;

  return {
    scheduledAt: new Date(utcTimestamp),
    hasExplicitSeconds,
  };
}

function isPublicRoute(method, pathname) {
  return (
    method === "GET" &&
    (
      pathname === "/consulta" ||
      pathname === "/status" ||
      pathname === "/agendamentos"
    )
  );
}

function getApiKeyFromRequest(req) {
  const headerValue = req.headers["x-api-key"];

  if (typeof headerValue === "string") {
    return headerValue;
  }

  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return "";
}

function isAuthorized(req, pathname) {
  if (req.method === "OPTIONS" || isPublicRoute(req.method, pathname)) {
    return true;
  }

  return Boolean(API_KEY) && getApiKeyFromRequest(req) === API_KEY;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 1024 * 1024) {
        reject(new Error("Payload muito grande."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error("JSON invalido."));
      }
    });

    req.on("error", reject);
  });
}

function getMachineFromRequest(req, url, body) {
  if (req.method === "GET" || req.method === "DELETE") {
    return url.searchParams.get("machine");
  }

  return typeof body.machine === "string" ? body.machine.trim() : "";
}

function parsePositiveInteger(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return false;
}

function createSchedule({
  machine,
  scheduledReleaseAt,
  durationMs,
  repeat,
  chainId,
}) {
  const localDateTime = getLocalDateTimeParts(scheduledReleaseAt);

  return {
    id: `${scheduledReleaseAt}-${Math.random().toString(36).slice(2, 10)}`,
    machine,
    scheduledReleaseAt,
    durationMs,
    repeat,
    chainId,
    data: localDateTime.data,
    hora: localDateTime.hora,
  };
}

function enqueueSchedule(state, schedule) {
  state.schedules.push(schedule);
  sortSchedules(state);
  return schedule;
}

function hasScheduleForChainAt(state, chainId, timestamp) {
  return state.schedules.some(
    (schedule) =>
      schedule.chainId === chainId &&
      schedule.scheduledReleaseAt === timestamp
  );
}

function scheduleNextRepeatIfNeeded(state, schedule) {
  if (!schedule.repeat || !schedule.chainId) {
    return null;
  }

  const nextTimestamp = schedule.scheduledReleaseAt + DAY_IN_MS;

  if (hasScheduleForChainAt(state, schedule.chainId, nextTimestamp)) {
    return null;
  }

  return enqueueSchedule(
    state,
    createSchedule({
      machine: schedule.machine,
      scheduledReleaseAt: nextTimestamp,
      durationMs: schedule.durationMs,
      repeat: true,
      chainId: schedule.chainId,
    })
  );
}

function formatScheduleForResponse(schedule) {
  return {
    id: schedule.id,
    machine: schedule.machine,
    tempoMs: schedule.durationMs,
    repeat: schedule.repeat,
    chainId: schedule.chainId,
    data: schedule.data,
    hora: schedule.hora,
    scheduledReleaseAt: new Date(schedule.scheduledReleaseAt).toISOString(),
    tempoRestante: formatRemainingTime(schedule.scheduledReleaseAt),
  };
}

function updateScheduledReleases(state) {
  const now = Date.now();
  const movedToPending = [];

  sortSchedules(state);

  while (
    state.schedules.length > 0 &&
    state.schedules[0].scheduledReleaseAt <= now
  ) {
    const dueSchedule = state.schedules.shift();
    const nextRepeatSchedule = scheduleNextRepeatIfNeeded(state, dueSchedule);

    const pendingRelease = {
      durationMs: dueSchedule.durationMs,
      source: "scheduled",
      scheduledAt: dueSchedule.scheduledReleaseAt,
      repeat: dueSchedule.repeat,
      chainId: dueSchedule.chainId,
      rescheduledNext: Boolean(nextRepeatSchedule),
      nextScheduledAt: nextRepeatSchedule
        ? nextRepeatSchedule.scheduledReleaseAt
        : null,
      data: dueSchedule.data,
      hora: dueSchedule.hora,
    };

    state.pendingReleases.push(pendingRelease);
    movedToPending.push(pendingRelease);
  }

  return movedToPending;
}

async function notifyDiscord(machine, release) {
  const now = Date.now();
  const localDateTime = getLocalDateTimeParts(now);
  const localWeekdayName = getLocalWeekdayName(now);
  const sourceLabel =
    release.source === "manual" ? "manual" : "agendamento";

  const message = [
    `Racao dispensada para ${machine}.`,
    `Origem: ${sourceLabel}.`,
    `Liberado em: ${localWeekdayName}`,
    `Hora: ${localDateTime.hora.slice(0, 5)}`,
    `Tempo: ${formatDurationForDiscord(release.durationMs)}`,
    `Repete dia seguinte: ${release.rescheduledNext ? "Sim" : "Nao"}`,
  ].join("\n");

  await sendReleaseNotifications(message);
}

async function sendDiscordMessage(content) {
  if (!DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      console.error(
        `Falha ao enviar webhook do Discord: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    console.error("Falha ao enviar webhook do Discord:", error);
  }
}

async function sendWhatsAppMessage(text) {
  if (!CALLMEBOT_CONFIG) {
    return;
  }

  try {
    const requestUrl = new URL(
      `${CALLMEBOT_CONFIG.origin}${CALLMEBOT_CONFIG.pathname}`
    );

    requestUrl.searchParams.set("phone", CALLMEBOT_CONFIG.phone);
    requestUrl.searchParams.set("apikey", CALLMEBOT_CONFIG.apikey);
    requestUrl.searchParams.set("text", text);

    const response = await fetch(requestUrl, {
      method: "GET",
    });

    if (!response.ok) {
      console.error(
        `Falha ao enviar mensagem pelo WhatsApp: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    console.error("Falha ao enviar mensagem pelo WhatsApp:", error);
  }
}

async function sendReleaseNotifications(message) {
  await sendDiscordMessage(message);
  await sendWhatsAppMessage(message);
}

async function notifyServerRestart() {
  const localDateTime = getLocalDateTimeParts(Date.now());
  const message = [
    "Servidor reiniciado.",
    "Agendamentos perdidos.",
    "Ainda nao estamos usando banco de dados pra guardar os agendamentos.",
    "Lembre de reprogramar para manter seu doguinho alimentado nos momentos corretos!",
    `Horario local do reinicio: ${localDateTime.data} ${localDateTime.hora} (${SCHEDULE_TIMEZONE_OFFSET}).`,
  ].join("\n");

  await sendReleaseNotifications(message);
}

function getStatusResponse(machine, state) {
  const nextSchedule = getNextSchedule(state);

  return {
    machine,
    online: isOnline(state.lastSeenAt),
    lastSeenAt: state.lastSeenAt
      ? new Date(state.lastSeenAt).toISOString()
      : null,
    pendingReleaseCount: state.pendingReleases.length,
    pendingDurationMs:
      state.pendingReleases.length > 0
        ? state.pendingReleases[0].durationMs
        : 0,
    hasScheduledRelease: state.schedules.length > 0,
    scheduledReleaseCount: state.schedules.length,
    scheduledReleaseAt: nextSchedule
      ? new Date(nextSchedule.scheduledReleaseAt).toISOString()
      : null,
    scheduledDurationMs: nextSchedule ? nextSchedule.durationMs : 0,
    nextScheduleRepeat: nextSchedule ? nextSchedule.repeat : false,
    tempoRestanteParaProximaLiberacao: nextSchedule
      ? formatRemainingTime(nextSchedule.scheduledReleaseAt)
      : null,
    timezoneOffset: SCHEDULE_TIMEZONE_OFFSET,
  };
}

function buildOpenApiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Doguinho",
      version: "1.0.0",
      description:
        "Controle a liberacao da racao agora ou programe o proximo horario.\n\nUm projeto open source para liberar ração para animais desenvolvido por Lucas Carvalho @br.lcsistemas.",
    },
    servers: [
      {
        url: "/",
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: {
              type: "string",
            },
          },
        },
        ReleaseRequest: {
          type: "object",
          required: ["machine", "tempoMs"],
          properties: {
            machine: {
              type: "string",
              example: "esp32-sala",
            },
            tempoMs: {
              type: "integer",
              example: 1500,
            },
          },
        },
        ScheduleRequest: {
          type: "object",
          required: ["machine", "data", "hora", "tempoMs"],
          properties: {
            machine: {
              type: "string",
              example: "esp32-sala",
            },
            data: {
              type: "string",
              example: "2026-05-29",
            },
            hora: {
              type: "string",
              example: "21:30",
            },
            tempoMs: {
              type: "integer",
              example: 1500,
            },
            repeat: {
              type: "boolean",
              example: true,
            },
          },
        },
      },
    },
    paths: {
      "/consulta": {
        get: {
          summary: "Consulta da maquina",
          description:
            "Atualiza o ultimo contato da maquina e retorna o proximo tempo pendente em milissegundos. Se nao houver liberacao pendente, retorna 0.",
          parameters: [
            {
              name: "machine",
              in: "query",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            200: {
              description: "Tempo pendente em milissegundos.",
              content: {
                "text/plain": {
                  schema: {
                    type: "string",
                    example: "1500",
                  },
                },
              },
            },
          },
        },
      },
      "/liberar-racao": {
        post: {
          summary: "Enfileira liberacao imediata",
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ReleaseRequest",
                },
              },
            },
          },
          responses: {
            200: {
              description: "Liberacao enfileirada.",
            },
          },
        },
      },
      "/agendar-racao": {
        post: {
          summary: "Agenda liberacao futura",
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ScheduleRequest",
                },
              },
            },
          },
          responses: {
            200: {
              description: "Liberacao agendada.",
            },
          },
        },
      },
      "/agendamentos": {
        get: {
          summary: "Lista agendamentos ativos da maquina",
          parameters: [
            {
              name: "machine",
              in: "query",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            200: {
              description: "Lista retornada com sucesso.",
            },
          },
        },
        delete: {
          summary: "Remove um agendamento pelo id",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: "machine",
              in: "query",
              required: true,
              schema: {
                type: "string",
              },
            },
            {
              name: "id",
              in: "query",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            200: {
              description: "Agendamento removido com sucesso.",
            },
            404: {
              description: "Agendamento nao encontrado.",
            },
          },
        },
      },
      "/status": {
        get: {
          summary: "Consulta status da maquina",
          parameters: [
            {
              name: "machine",
              in: "query",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            200: {
              description: "Status retornado com sucesso.",
            },
          },
        },
      },
    },
  };
}

function buildSwaggerHtml(spec) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Doguinho</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
    />
    <style>
      .swagger-ui .opblock[data-path="/agendar-racao"] .opblock-summary {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .swagger-ui .doguinho-machine-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 72px;
        padding: 4px 10px;
        border-radius: 999px;
        background: #fff2e2;
        border: 1px solid #f0b36c;
        color: #9a5518;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      function replaceTextInNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || "";

          if (text.includes("Repeat")) {
            node.textContent = text.replaceAll("Repeat", "Repetir");
          }

          if (text.includes("Maquina")) {
            node.textContent = node.textContent.replaceAll("Maquina", "Máquina");
          }

          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }

        for (const child of node.childNodes) {
          replaceTextInNode(child);
        }
      }

      function localizeSwaggerUi() {
        replaceTextInNode(document.body);
      }

      function attachActiveMachineBadge() {
        const scheduleBlock = document.querySelector(
          '.swagger-ui .opblock[data-path="/agendar-racao"] .opblock-summary'
        );

        if (!scheduleBlock) {
          return;
        }

        let badge = scheduleBlock.querySelector(".doguinho-machine-badge");

        if (!badge) {
          badge = document.createElement("span");
          badge.className = "doguinho-machine-badge";
          scheduleBlock.appendChild(badge);
        }

        badge.textContent = "${ACTIVE_MACHINE_LABEL}";
      }

      window.onload = function () {
        window.ui = SwaggerUIBundle({
          spec: ${JSON.stringify(spec)},
          dom_id: "#swagger-ui",
          persistAuthorization: true
        });

        const observer = new MutationObserver(() => {
          localizeSwaggerUi();
          attachActiveMachineBadge();
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });

        localizeSwaggerUi();
        attachActiveMachineBadge();
      };
    </script>
  </body>
</html>`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/docs") {
    return sendHtml(res, 200, buildSwaggerHtml(buildOpenApiSpec()));
  }

  if (req.method === "GET" && pathname === "/openapi.json") {
    return sendJson(res, 200, buildOpenApiSpec());
  }

  if (!isAuthorized(req, pathname)) {
    return sendJson(res, 401, {
      error: "API key invalida ou nao informada.",
    });
  }

  let body = {};

  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, {
        error: error.message,
      });
    }
  }

  const machine = getMachineFromRequest(req, url, body);

  if (
    pathname !== "/docs" &&
    pathname !== "/openapi.json" &&
    !machine
  ) {
    return sendJson(res, 400, {
      error:
        req.method === "GET"
          ? 'Informe a query string "machine". Exemplo: ?machine=esp32-sala'
          : 'Informe "machine" no corpo JSON.',
    });
  }

  if (req.method === "GET" && pathname === "/consulta") {
    const state = getMachineState(machine);
    updateScheduledReleases(state);
    state.lastSeenAt = Date.now();

    if (state.pendingReleases.length > 0) {
      const release = state.pendingReleases.shift();

      res.on("finish", () => {
        notifyDiscord(machine, release).catch((error) => {
          console.error("Falha ao disparar notificacao do Discord:", error);
        });
      });

      return sendText(res, 200, String(release.durationMs));
    }

    return sendText(res, 200, "0");
  }

  if (req.method === "POST" && pathname === "/liberar-racao") {
    const state = getMachineState(machine);
    updateScheduledReleases(state);
    const online = isOnline(state.lastSeenAt);
    const tempoMs = parsePositiveInteger(body.tempoMs);

    if (!tempoMs) {
      return sendJson(res, 400, {
        error: 'Informe "tempoMs" como inteiro positivo.',
      });
    }

    if (!online) {
      return sendJson(res, 409, {
        machine,
        online: false,
        mensagem: "maquina offline",
      });
    }

    state.pendingReleases.push({
      durationMs: tempoMs,
      source: "manual",
      scheduledAt: null,
      repeat: false,
      chainId: null,
      rescheduledNext: false,
      nextScheduledAt: null,
      data: null,
      hora: null,
    });

    return sendJson(res, 200, {
      machine,
      online,
      releasePending: true,
      tempoMs,
      pendingReleaseCount: state.pendingReleases.length,
      lastSeenAt: state.lastSeenAt
        ? new Date(state.lastSeenAt).toISOString()
        : null,
      mensagem: "Liberacao de racao enfileirada.",
    });
  }

  if (req.method === "POST" && pathname === "/agendar-racao") {
    const state = getMachineState(machine);
    const data = body.data;
    const hora = body.hora;
    const tempoMs = parsePositiveInteger(body.tempoMs);
    const repeat = parseBoolean(body.repeat);

    if (!data || !hora) {
      return sendJson(res, 400, {
        error:
          'Informe "data", "hora" e "tempoMs". Exemplo: {"machine":"esp32-sala","data":"2026-05-29","hora":"21:30","tempoMs":1500,"repeat":true}',
      });
    }

    if (!tempoMs) {
      return sendJson(res, 400, {
        error: 'Informe "tempoMs" como inteiro positivo.',
      });
    }

    const { scheduledAt, hasExplicitSeconds } = parseScheduledDateTime(
      data,
      hora
    );

    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
      return sendJson(res, 400, {
        error: "Data ou hora invalida.",
      });
    }

    const now = Date.now();
    let scheduledTimestamp = scheduledAt.getTime();

    if (!hasExplicitSeconds && scheduledTimestamp <= now) {
      const withinGraceWindow = now - scheduledTimestamp <= SCHEDULE_GRACE_MS;

      if (withinGraceWindow) {
        scheduledTimestamp = now + 1000;
      }
    }

    if (scheduledTimestamp <= now) {
      return sendJson(res, 400, {
        error: "O agendamento deve estar no futuro.",
      });
    }

    const chainId = repeat
      ? `repeat-${machine}-${scheduledTimestamp}`
      : `single-${machine}-${scheduledTimestamp}`;
    const createdSchedule = enqueueSchedule(
      state,
      createSchedule({
        machine,
        scheduledReleaseAt: scheduledTimestamp,
        durationMs: tempoMs,
        repeat,
        chainId,
      })
    );

    return sendJson(res, 200, {
      machine,
      agendado: true,
      tempoMs,
      repeat,
      totalAgendamentosAtivos: state.schedules.length,
      agendamentosCriados: [formatScheduleForResponse(createdSchedule)],
      timezoneOffset: SCHEDULE_TIMEZONE_OFFSET,
      mensagem: repeat
        ? "Liberacao de racao agendada com recorrencia diaria. O proximo agendamento sera criado quando esta liberacao for executada."
        : "Liberacao de racao agendada.",
    });
  }

  if (req.method === "GET" && pathname === "/agendamentos") {
    const state = getMachineState(machine);
    updateScheduledReleases(state);

    return sendJson(res, 200, {
      machine,
      total: state.schedules.length,
      agendamentos: state.schedules.map(formatScheduleForResponse),
    });
  }

  if (req.method === "DELETE" && pathname === "/agendamentos") {
    const scheduleId = url.searchParams.get("id");

    if (!scheduleId) {
      return sendJson(res, 400, {
        error: 'Informe a query string "id". Exemplo: ?machine=esp32-sala&id=abc123',
      });
    }

    const state = getMachineState(machine);
    const scheduleIndex = state.schedules.findIndex(
      (schedule) => schedule.id === scheduleId
    );

    if (scheduleIndex === -1) {
      return sendJson(res, 404, {
        error: "Agendamento nao encontrado.",
      });
    }

    const [removedSchedule] = state.schedules.splice(scheduleIndex, 1);

    return sendJson(res, 200, {
      machine,
      removido: true,
      agendamento: formatScheduleForResponse(removedSchedule),
      totalAgendamentosAtivos: state.schedules.length,
    });
  }

  if (req.method === "GET" && pathname === "/status") {
    const state = getMachineState(machine);
    updateScheduledReleases(state);

    return sendJson(res, 200, getStatusResponse(machine, state));
  }

  return sendJson(res, 404, { error: "Rota nao encontrada." });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: "Erro interno do servidor." });
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Swagger: http://localhost:${PORT}/docs`);
  console.log(`OpenAPI: http://localhost:${PORT}/openapi.json`);

  notifyServerRestart().catch((error) => {
    console.error(
      "Falha ao disparar notificacao de reinicio do servidor:",
      error
    );
  });
});
