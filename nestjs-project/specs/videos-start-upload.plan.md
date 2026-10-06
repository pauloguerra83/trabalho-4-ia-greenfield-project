---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-start-upload.e2e-spec.ts
---

# POST /videos (início do upload) — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo. A API pré-cadastra o vídeo como rascunho (`draft`), gera o `slug` da URL única e abre o multipart no storage compatível com S3. A resposta traz o necessário para o cliente enviar as partes direto ao storage: `videoId`, `uploadId`, `slug`, `title`, `status`, `partSize` e `partCount`. Nenhum byte de vídeo passa pela API. O título é opcional; quando ausente, vira o nome do arquivo sem extensão. Arquivos declarados acima de 10 GiB são recusados antes de qualquer gravação.

## Test Scenarios

### 1. Pré-cadastrar o vídeo e abrir o upload

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` com a configuração global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `beforeEach` com `cleanAllTables`, `emptyBucket()` do bucket de testes e limpeza do storage do throttler; usuário confirmado criado com o seu canal (como no registro) e autenticado via `POST /auth/login` (mesmo padrão de `test/auth.e2e-spec.ts`); `QUEUE_PREFIX` e `S3_BUCKET` de teste vindos de `src/test/setup-test-env.ts`.

#### 1.1. iniciar-upload-cria-rascunho-e-multipart

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos com JWT e body `{ "fileName": "aula.mp4", "fileSize": 150000000, "contentType": "video/mp4", "title": "Minha aula" }`
    - expect: status 201
    - expect: body com `videoId` (uuid), `uploadId` (string não vazia), `slug` com 11 caracteres de `[A-Za-z0-9_-]`, `title: "Minha aula"`, `status: "draft"`, `partSize: 67108864` e `partCount: 3`
  2. Consultar a tabela `videos` pelo `videoId` devolvido
    - expect: a linha existe com `status = 'draft'`, `channel_id` igual ao canal do usuário do token, `source_key = 'videos/{videoId}/source'`, `upload_id` igual ao `uploadId` devolvido e `size_bytes = 150000000` (emenda SI-03.14)
  3. Chamar `ListParts` no storage para a chave `videos/{videoId}/source` com o `uploadId`
    - expect: o multipart existe (sem erro `NoSuchUpload`) e ainda não tem partes

#### 1.2. titulo-padrao-e-nome-do-arquivo-sem-extensao

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos com JWT e body `{ "fileName": "ferias.2024.mp4", "fileSize": 1000, "contentType": "video/mp4" }` (sem `title`)
    - expect: status 201
    - expect: `title: "ferias.2024"` no body
    - expect: a linha em `videos` tem `title = 'ferias.2024'` e `original_filename = 'ferias.2024.mp4'`

#### 1.3. slugs-distintos-entre-videos

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos duas vezes seguidas com o mesmo body válido
    - expect: as duas respostas são 201
    - expect: os dois `slug` são diferentes e os dois `videoId` são diferentes

### 2. Rejeitar inícios de upload inválidos

**Setup:** igual ao grupo 1.

#### 2.1. arquivo-acima-de-10-gib-retorna-413

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos com JWT e body `{ "fileName": "grande.mp4", "fileSize": 10737418241, "contentType": "video/mp4" }`
    - expect: status 413
    - expect: body `{ statusCode: 413, error: "VIDEO_TOO_LARGE", message: "Video exceeds the 10 GiB limit" }`
  2. Contar as linhas em `videos`
    - expect: nenhuma linha foi criada

#### 2.2. content-type-que-nao-e-video-retorna-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos com JWT e body `{ "fileName": "foto.png", "fileSize": 1000, "contentType": "image/png" }`
    - expect: status 400
    - expect: body com `error: "VALIDATION_ERROR"` e `message` como array citando `contentType`
  2. POST /videos com JWT e body sem `fileSize`
    - expect: status 400 com `error: "VALIDATION_ERROR"`

#### 2.3. sem-token-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status 401
    - expect: nenhuma linha criada em `videos`

#### 2.4. usuario-sem-canal-retorna-404

**Covers AC:** SI-03.14 #3
**Source:** manual (emenda SI-03.14)
**Last sync:** 2026-10-06T00:00:00Z

**Steps:**
  1. Criar um usuário confirmado **sem** canal e autenticá-lo via `POST /auth/login`
  2. POST /videos com o JWT desse usuário e body `{ "fileName": "aula.mp4", "fileSize": 1000, "contentType": "video/mp4" }`
    - expect: status 404
    - expect: body `{ statusCode: 404, error: "CHANNEL_NOT_FOUND", message: "Channel not found" }`
  3. Contar as linhas em `videos`
    - expect: nenhuma linha foi criada
