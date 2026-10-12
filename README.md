# Métricas das redes do criador

Instagram, TikTok, YouTube e X. Métrica atrasada ou contada duas vezes muda o ranking do criador. Este serviço sincroniza os posts de uma conexão, tenta de novo quando o provedor falha e nunca soma a mesma janela duas vezes.

Comece a leitura por [`src/sync.ts`](src/sync.ts).

- `SocialProvider.listPosts` (em `src/provider.ts`) é a única borda com a rede social. Falha é `ProviderFailure` com `timeout`, `unavailable` ou `rate_limited` (+ `retryAfterSeconds`).
- O relógio é injetado (`src/clock.ts`). O teste usa um relógio cujo `wait` só avança o instante e guarda os segundos.
- O token é fictício. Não há OAuth.

## Regras do sync

Laço `for` até `maxAttempts`, sem `while (true)`.

- Sucesso: grava e sai do laço.
- Timeout ou indisponível: espera `2 ** (attempt - 1)` segundos, limitado a `maxWaitSeconds`.
- 429: espera `min(retryAfterSeconds, maxWaitSeconds)`.
- Falha na última tentativa: `503 {"error":"provedor indisponível","attempts":<teto>}`. Não espera depois da última.

- Cada tentativa tem prazo (`attemptTimeoutSeconds`, padrão 10 s). No prazo, o `AbortSignal` passado a `listPosts` é abortado e a tentativa conta como timeout.

Padrão: 4 tentativas, teto de espera de 30 s, prazo de 10 s por tentativa. Variáveis `MAX_ATTEMPTS`, `MAX_WAIT_SECONDS` e `ATTEMPT_TIMEOUT_SECONDS`.

Idempotência: `UNIQUE (connection_id, external_id, captured_at)` no banco e `ON CONFLICT DO NOTHING`; `result.changes` diz se a linha entrou ou era duplicata. A leitura devolve a janela de maior `captured_at` de cada post, não a soma das janelas. `fetched_at` é o instante da primeira inserção daquela janela.

Validação: o lote do provedor é conferido inteiro antes de gravar. `external_id` vazio, views negativas, fracionárias ou acima do inteiro seguro e `captured_at` ilegível dão `502 resposta inválida do provedor`, sem retry e sem gravar nada. `captured_at` vira ISO UTC canônico, então `09:00-03:00` e `12:00Z` são a mesma captura e a mais recente é decidida pelo instante, não pelo texto. A mesma captura com views diferentes é `409` e desfaz o lote. Erro do adaptador fora do contrato (que não é `ProviderFailure`) é `502 falha inesperada do provedor`, sem retry e sem a mensagem original, que pode carregar o token. Capturas gravadas antes da normalização são convertidas ao abrir o banco; se colidirem com uma já canônica, ficam intactas e o app avisa.

**Entrada:** corpo precisa ser `application/json` (senão 415), JSON válido e objeto (senão 400) e ter até 64 KB (senão 413). Campo fora do contrato da rota → 400 com o nome do campo. Erro inesperado vira `500 {"error":"erro interno"}`, sem stack na resposta.

## Como rodar

Node 22.13 ou maior (primeira versão com `node:sqlite` sem flag).

```bash
npm install
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:43122`. No `npm run dev` o provedor é um demo que devolve um post fixo.

## Exemplo

O teste `janela repetida não conta duas vezes: p2 vira duplicata, p3 entra, soma 35` executa estes requests, com o provedor devolvendo `p1=10, p2=20` na primeira janela e `p2=20, p3=5` na segunda.

```bash
curl -s -X POST http://127.0.0.1:43122/connections \
  -H 'content-type: application/json' \
  -d '{"platform":"instagram","creator_id":"crt_ana"}'
# guarde o "id" em ID

curl -s -X POST "http://127.0.0.1:43122/connections/$ID/sync"   # 1ª janela
curl -s -X POST "http://127.0.0.1:43122/connections/$ID/sync"   # 2ª janela
curl -s "http://127.0.0.1:43122/connections/$ID/posts"
```

Respostas reais do teste (o id varia):

```text
201 {"id":"con_d9ff415f-…","platform":"instagram","creator_id":"crt_ana"}
200 {"connection_id":"con_d9ff415f-…","attempts":1,"inserted":2,"duplicates":0}
200 {"connection_id":"con_d9ff415f-…","attempts":1,"inserted":1,"duplicates":1}
```

```json
{
  "connection_id": "con_d9ff415f-26d7-49a0-9505-1a296a4ce5bf",
  "total_views": 35,
  "posts": [
    { "external_id": "p1", "views": 10, "captured_at": "2026-06-01T10:00:00.000Z", "fetched_at": "2026-06-01T12:00:00.000Z" },
    { "external_id": "p2", "views": 20, "captured_at": "2026-06-01T10:00:00.000Z", "fetched_at": "2026-06-01T12:00:00.000Z" },
    { "external_id": "p3", "views": 5, "captured_at": "2026-06-01T11:00:00.000Z", "fetched_at": "2026-06-01T12:00:00.000Z" }
  ]
}
```

## Ficou de fora

Paginação do provedor, refresh de token e stories.

## Nota da entrega

Comece por `src/sync.ts`. O sync é um laço `for` limitado por `maxAttempts`: timeout e indisponibilidade esperam `2^(n-1)` segundos, 429 espera o `Retry-After`, e as duas esperas param no teto. Na última falha devolve 503 `provedor indisponível` sem esperar de novo. A espera passa por um relógio injetado, então o teste confere os segundos sem dormir: Retry-After 7 grava `[7]`, Retry-After 90 com teto 30 grava `[30]`, timeout com teto 3 faz 3 chamadas e espera `[1, 2]`. A mesma janela não entra duas vezes por causa de `UNIQUE (connection_id, external_id, captured_at)` no banco; a leitura pega a janela mais recente de cada post, então p1=10, p2=20 e p3=5 somam 35, e não 55.

Testes: `npm test` com 25 passando, `npm run typecheck` sem erro. O exemplo deste README é o request do teste da janela repetida.

Ficou de fora: paginação do provedor, refresh de token e stories.

IA: código, testes e README escritos com assistente de código (Claude Code), a partir de um plano com as regras do desafio. A validação do lote, os instantes canônicos e o prazo por tentativa vieram de programação em pares: o Codex auditou a entrega e escreveu os testes que reproduziam os defeitos; o Claude Code implementou, validou e publicou.
