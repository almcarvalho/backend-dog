# Backend do alimentador

Backend Node.js simples para hospedar no Render.

## Configuracao

Crie um arquivo `.env` na raiz com:

```env
API_KEY=sua-chave-api
SCHEDULE_TIMEZONE_OFFSET=-03:00
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
CALLMEBOT=https://api.callmebot.com/whatsapp.php?phone=5579911112222&text=This+is+a+test&apikey=11223344
```

## Autenticacao

Todas as rotas exigem o header `x-api-key`, exceto as rotas publicas da maquina:

```txt
x-api-key: sua-chave-api
```

## Rotas

### `GET /consulta?machine=nome-da-maquina`

Rota chamada pela maquina.

- Atualiza o `lastSeenAt` da maquina.
- Se existir uma liberacao pendente, responde com o tempo em milissegundos configurado.
- Depois volta a responder `0`.

Exemplo de resposta:

```txt
1500
```

### `POST /liberar-racao`

Enfileira uma liberacao imediata de racao para a maquina informada.

Body:

```json
{
  "machine": "esp32-sala",
  "tempoMs": 1500
}
```

Se a maquina estiver offline, a rota retorna erro e nao cria liberacao pendente.

### `POST /agendar-racao`

Agenda uma liberacao futura de racao para a maquina informada.

Body:

```json
{
  "machine": "esp32-sala",
  "data": "2026-05-29",
  "hora": "21:30",
  "tempoMs": 1500,
  "repeat": true
}
```

O parametro `hora` aceita `HH:mm` ou `HH:mm:ss`.
O campo `repeat` e opcional. Quando vier `true`, o backend mantem a recorrencia diaria nesse mesmo horario.

O backend interpreta o agendamento usando o offset configurado em `SCHEDULE_TIMEZONE_OFFSET`.
Se a variavel nao for definida, o padrao e `-03:00`.
Quando `hora` for enviada sem segundos, o backend aplica uma tolerancia de ate 60 segundos para evitar erro por atraso de rede ou diferenca de relogio no servidor.

Agora uma maquina pode ter varios agendamentos ativos ao mesmo tempo.

### `GET /agendamentos?machine=nome-da-maquina`

Lista os agendamentos ativos da maquina.

Essa rota e publica.

### `DELETE /agendamentos?machine=nome-da-maquina&id=ID_DO_AGENDAMENTO`

Remove um agendamento especifico pelo `id`.

Essa rota exige o header `x-api-key`.

### `GET /status?machine=nome-da-maquina`

Consulta se a maquina esta online. Uma maquina e considerada online quando a ultima chamada em `/consulta` aconteceu nos ultimos 30 segundos.

## Swagger

- Documentacao interativa: `GET /docs`
- Especificacao OpenAPI JSON: `GET /openapi.json`

## Webhook do Discord

Quando a maquina consumir uma liberacao em `/consulta`, o backend tenta enviar um webhook para o Discord com:

- hora do disparo
- tempo escolhido em milissegundos
- informacao se foi criado um novo agendamento da recorrencia

Quando o backend sobe, ele tambem envia um aviso de reinicio informando que os agendamentos em memoria foram perdidos e precisam ser reprogramados.

## Deploy no Render

- Environment: `Node`
- Build Command: deixar vazio
- Start Command: `npm start`

## Observacao

Os dados ficam em memoria. Se o servico reiniciar, o estado das maquinas e filas de liberacao sera perdido.
