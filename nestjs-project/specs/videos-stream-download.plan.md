---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-stream-download.e2e-spec.ts
---

# GET /videos/:id/stream e GET /videos/:id/download — Test Plan

## Application Overview

Os dois endpoints entregam ao dono URLs `GetObject` pré-assinadas para o arquivo original em `videos/{videoId}/source`. Nenhum byte de vídeo passa pela API.

| Endpoint | Validade da URL | Comportamento |
|---|---|---|
| `GET /videos/:id/stream` | 1h | Funciona direto em `<video src>`; o storage atende `Range` com 206 |
| `GET /videos/:id/download` | 15 min | Força o download com `Content-Disposition: attachment` e o nome original do arquivo |

Os dois só respondem para vídeos em `ready` e só para o dono. A resposta é `{ url, expiresAt }`.

## Test Scenarios

### 1. Assistir e baixar um vídeo pronto

**Setup:**

- `Test.createTestingModule({ imports: [AppModule] })` com a configuração global do `main.ts`.
- `beforeEach`: `cleanAllTables`, `emptyBucket()` do bucket de testes e limpeza do storage do throttler.
- Usuário confirmado e autenticado via `POST /auth/login`.
- Vídeo criado por `POST /videos` com `fileName: "minha aula.mp4"`.
- O teste grava 1000 bytes conhecidos em `videos/{videoId}/source` com `putObject` e atualiza a linha para `status = 'ready'` via repositório. O processamento real fica no pipeline e2e do SI-03.12.

#### 1.1. stream-de-video-pronto-atende-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id/stream com JWT do dono
    - expect: status 200
    - expect: body `{ url, expiresAt }`, com `expiresAt` entre 55 e 65 minutos à frente do horário da requisição
  2. `fetch(url, { headers: { Range: 'bytes=0-99' } })`
    - expect: status 206
    - expect: `Content-Range: bytes 0-99/1000` e corpo igual aos 100 primeiros bytes gravados

#### 1.2. download-de-video-pronto-forca-anexo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id/download com JWT do dono
    - expect: status 200
    - expect: body `{ url, expiresAt }`, com `expiresAt` entre 14 e 16 minutos à frente do horário da requisição
  2. `fetch(url)`
    - expect: status 200 com os 1000 bytes gravados
    - expect: header `Content-Disposition` começando com `attachment` e contendo o nome `minha aula.mp4`

### 2. Recusar acesso indevido

**Setup:** igual ao grupo 1, com um segundo usuário confirmado e autenticado e um segundo vídeo do dono que permanece em `draft`.

#### 2.1. video-fora-de-ready-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id/stream com JWT do dono, para o vídeo em `draft`
    - expect: status 409
    - expect: body `{ statusCode: 409, error: "VIDEO_NOT_READY", message: "Video is not ready" }`
  2. GET /videos/:id/download com JWT do dono, para o mesmo vídeo
    - expect: status 409 com `error: "VIDEO_NOT_READY"`

#### 2.2. outro-usuario-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id/stream com JWT do segundo usuário, para o vídeo `ready`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:id/download com JWT do segundo usuário, para o vídeo `ready`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/:id/stream sem header `Authorization`
    - expect: status 401
