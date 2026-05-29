const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ONLINE_WINDOW_MS = 30 * 1000;
const SCHEDULE_TIMEZONE_OFFSET =
  process.env.SCHEDULE_TIMEZONE_OFFSET || "-03:00";
const SCHEDULE_GRACE_MS = 60 * 1000;

// Armazena o ultimo contato e se ha liberacao pendente por maquina.
const machines = new Map();

function getMachineState(machine) {
  if (!machines.has(machine)) {
    machines.set(machine, {
      lastSeenAt: null,
      releasePending: false,
      scheduledReleaseAt: null,
      scheduledReleaseReady: false,
    });
  }

  return machines.get(machine);
}

function isOnline(lastSeenAt) {
  return Boolean(lastSeenAt) && Date.now() - lastSeenAt <= ONLINE_WINDOW_MS;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(text);
}

function updateScheduledRelease(state) {
  if (
    state.scheduledReleaseAt &&
    !state.scheduledReleaseReady &&
    state.scheduledReleaseAt <= Date.now()
  ) {
    state.releasePending = true;
    state.scheduledReleaseReady = true;
  }
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
  const horaNormalizada = hasOnlyHourAndMinute ? `${hora}:00` : hora;

  if (!/^\d{2}:\d{2}:\d{2}$/.test(horaNormalizada)) {
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
  const [hours, minutes, seconds] = horaNormalizada.split(":").map(Number);
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

function hasScheduledRelease(state) {
  return Boolean(state.scheduledReleaseAt) || state.scheduledReleaseReady;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const machine = url.searchParams.get("machine");

  if (!machine) {
    return sendJson(res, 400, {
      error: 'Informe a query string "machine". Exemplo: ?machine=esp32-sala',
    });
  }

  if (req.method === "GET" && pathname === "/consulta") {
    const state = getMachineState(machine);
    updateScheduledRelease(state);
    state.lastSeenAt = Date.now();

    if (state.releasePending) {
      state.releasePending = false;
      state.scheduledReleaseAt = null;
      state.scheduledReleaseReady = false;
      return sendText(res, 200, "true");
    }

    return sendText(res, 200, "false");
  }

  if (req.method === "GET" && pathname === "/liberar-racao") {
    const state = getMachineState(machine);
    updateScheduledRelease(state);
    const online = isOnline(state.lastSeenAt);

    if (!online) {
      return sendJson(res, 409, {
        machine,
        online: false,
        mensagem: "maquina offline",
      });
    }

    state.releasePending = true;
    state.scheduledReleaseAt = null;
    state.scheduledReleaseReady = false;

    return sendJson(res, 200, {
      machine,
      online,
      releasePending: true,
      lastSeenAt: state.lastSeenAt
        ? new Date(state.lastSeenAt).toISOString()
        : null,
      mensagem: "Liberacao de racao enfileirada.",
    });
  }

  if (req.method === "GET" && pathname === "/agendar-racao") {
    const state = getMachineState(machine);
    const data = url.searchParams.get("data");
    const hora = url.searchParams.get("hora");

    if (!data || !hora) {
      return sendJson(res, 400, {
        error: 'Informe "data" e "hora". Exemplo: ?machine=esp32-sala&data=2026-05-29&hora=21:30 ou 21:30:05',
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

    // Quando o cliente envia apenas HH:mm, aceitamos ate 60s de tolerancia
    // para evitar falha por atraso de rede ou diferenca de relogio no deploy.
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

    state.scheduledReleaseAt = scheduledTimestamp;
    state.scheduledReleaseReady = false;
    state.releasePending = false;

    return sendJson(res, 200, {
      machine,
      agendado: true,
      scheduledReleaseAt: new Date(scheduledTimestamp).toISOString(),
      tempoRestante: formatRemainingTime(state.scheduledReleaseAt),
      timezoneOffset: SCHEDULE_TIMEZONE_OFFSET,
      mensagem: "Liberacao de racao agendada.",
    });
  }

  if (req.method === "GET" && pathname === "/status") {
    const state = getMachineState(machine);
    updateScheduledRelease(state);

    return sendJson(res, 200, {
      machine,
      online: isOnline(state.lastSeenAt),
      lastSeenAt: state.lastSeenAt
        ? new Date(state.lastSeenAt).toISOString()
        : null,
      releasePending: state.releasePending,
      hasScheduledRelease: hasScheduledRelease(state),
      scheduledReleaseAt: state.scheduledReleaseAt
        ? new Date(state.scheduledReleaseAt).toISOString()
        : null,
      scheduledReleaseReady: state.scheduledReleaseReady,
      tempoRestanteParaProximaLiberacao:
        state.scheduledReleaseReady && state.releasePending
          ? "0s"
          : state.scheduledReleaseAt
            ? formatRemainingTime(state.scheduledReleaseAt)
            : null,
      timezoneOffset: SCHEDULE_TIMEZONE_OFFSET,
    });
  }

  return sendJson(res, 404, { error: "Rota não encontrada." });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
