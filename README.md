# Backend do alimentador

Backend Node.js simples para hospedar no Render.

## Rotas

### `GET /consulta?machine=nome-da-maquina`

Rota chamada pela maquina.

- Atualiza o `lastSeenAt` da maquina.
- Se existir racao pendente, responde `true` uma unica vez.
- Depois volta a responder `false`.

Exemplo de resposta:

```txt
false
```

### `GET /liberar-racao?machine=nome-da-maquina`

Enfileira uma liberacao de racao para a maquina informada.

Se a maquina estiver offline, a rota retorna erro e nao cria liberacao pendente.

Exemplo de resposta:

```json
{
  "machine": "esp32-sala",
  "online": true,
  "releasePending": true,
  "lastSeenAt": "2026-05-28T12:00:00.000Z",
  "mensagem": "Liberacao de racao enfileirada."
}
```

Exemplo quando a maquina estiver offline:

```json
{
  "machine": "esp32-sala",
  "online": false,
  "mensagem": "maquina offline"
}
```

### `GET /agendar-racao?machine=nome-da-maquina&data=2026-05-29&hora=21:30`

Agenda uma liberacao futura de racao para a maquina informada.

O parametro `hora` aceita `HH:mm` ou `HH:mm:ss`.

O backend interpreta o agendamento usando o offset configurado em `SCHEDULE_TIMEZONE_OFFSET`.
Se a variavel nao for definida, o padrao e `-03:00`.

Exemplo de resposta:

```json
{
  "machine": "esp32-sala",
  "agendado": true,
  "scheduledReleaseAt": "2026-05-30T00:30:00.000Z",
  "tempoRestante": "1h 12m 4s",
  "timezoneOffset": "-03:00",
  "mensagem": "Liberacao de racao agendada."
}
```

### `GET /status?machine=nome-da-maquina`

Consulta se a maquina esta online. Uma maquina e considerada online quando a ultima chamada em `/consulta` aconteceu nos ultimos 30 segundos.

Exemplo de resposta:

```json
{
  "machine": "esp32-sala",
  "online": true,
  "lastSeenAt": "2026-05-29T00:15:38.868Z",
  "releasePending": false,
  "hasScheduledRelease": true,
  "scheduledReleaseAt": "2026-05-30T00:30:00.000Z",
  "scheduledReleaseReady": false,
  "tempoRestanteParaProximaLiberacao": "1h 12m 4s",
  "timezoneOffset": "-03:00"
}
```

## Deploy no Render

- Environment: `Node`
- Build Command: deixar vazio
- Start Command: `npm start`

## Observação

Os dados ficam em memoria. Se o servico reiniciar, o estado das maquinas e filas de liberacao sera perdido.
