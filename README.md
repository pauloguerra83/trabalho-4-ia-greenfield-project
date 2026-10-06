# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API. A única exceção é o storage: o navegador envia as partes do vídeo e faz o streaming direto nele, sempre por URLs pré-assinadas que a API gera.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails, acesso ao banco, orquestração do upload (assina as URLs; nenhum byte de vídeo passa pela API) e publicação dos jobs de processamento.
- **Database** (PostgreSQL 17) — usuários, canais, tokens de autenticação e vídeos.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg) — container `video-worker`, que consome a fila e roda `ffprobe`/`ffmpeg` para extrair duração e metadados e gerar a thumbnail.
- **Object Storage** (S3-compatível; `pgsty/minio` em dev) — um bucket privado com os vídeos e as thumbnails, acessado por URLs pré-assinadas; o upload é multipart, direto do navegador para o storage.
- **Message Queue** (BullMQ sobre Redis) — fila `video-processing`, com um job `video.process` por vídeo.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + worker de vídeo + PostgreSQL + Redis + MinIO + Mailpit)

```bash
cd nestjs-project

# Cria o .env a partir do exemplo (obrigatório: o Compose e a API leem as credenciais do storage dele)
cp .env.example .env

# Sobe API, worker de vídeo, banco, Redis, storage e Mailpit
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Redis (fila BullMQ) | `localhost:6379` |
| Storage S3 (MinIO) | API em `localhost:9000`; console em http://localhost:9001 (credenciais `S3_ACCESS_KEY`/`S3_SECRET_KEY` do `.env`) |
| Worker de vídeo | sem porta; acompanhe com `docker compose logs video-worker` |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com serviços reais: Postgres, Redis, MinIO e FFmpeg), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`. Os testes usam fila e bucket próprios (`streamtube-test` e `streamtube-media-test`), então o `video-worker` pode continuar ligado durante a suíte.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). **Fase 03 — Upload e processamento de vídeos** está concluída no backend; a interface de vídeo fica para as próximas fases.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Upload e processamento de vídeos (Fase 03)

Upload de vídeos de até **10 GB** sem passar pela API: ao iniciar, o vídeo é pré-cadastrado como **rascunho** no canal do usuário, com uma **URL única** (`slug`), e o navegador envia as partes (64 MiB) **direto ao storage**, por URLs pré-assinadas de multipart. Ao concluir o upload, a API enfileira o processamento; o **worker** extrai duração e metadados com `ffprobe`, gera a **thumbnail** com `ffmpeg` e marca o vídeo como pronto. Depois disso, o dono pode fazer **streaming** (Range/206 servido pelo storage) e **download** do original.

Ciclo de status: `draft → processing → ready | failed` (`failed` é terminal, com o motivo em `processing_error`). O vídeo pertence ao **canal** do usuário, e só o dono acessa os endpoints nesta fase.

Endpoints da API (`nestjs-project`, todos autenticados):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload: cria o rascunho e abre o multipart no storage |
| `POST /videos/:id/upload/part-urls` | URLs pré-assinadas para enviar um lote de partes |
| `GET /videos/:id/upload/parts` | Partes já recebidas, para retomar um upload interrompido |
| `DELETE /videos/:id/upload` | Aborta o upload em andamento |
| `POST /videos/:id/upload/complete` | Conclui o upload e enfileira o processamento |
| `GET /videos/:id` | Consulta do dono (status, duração, metadados, thumbnail), usada por polling |
| `GET /videos/:id/stream` | URL pré-assinada para reprodução via streaming |
| `GET /videos/:id/download` | URL pré-assinada para download do arquivo original |

Detalhes (erros, posse e fluxo) na seção "Videos" do `nestjs-project/CLAUDE.md`; decisões, plano e progresso em `docs/decisions/technical-decisions-phase-03-videos.md` e `docs/phases/phase-03-videos/`.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   ├── core/                        # Config + TypeORM compartilhados pela API e pelo worker
│   │   ├── database/                    # data-source, migrations e seeds
│   │   ├── videos/                      # Entidade Video, endpoints de upload/consulta/stream/download
│   │   │   └── processing/              # Producer da fila (API) e processor do job (worker)
│   │   ├── storage/                     # Cliente S3 (interno + público), multipart e URLs pré-assinadas
│   │   ├── queue/                       # Conexão BullMQ com o Redis
│   │   ├── media/                       # ffprobe/ffmpeg (metadados e thumbnail)
│   │   └── worker.ts                    # Entrypoint do worker de vídeo
│   ├── test/                            # Testes e2e (+ fixtures de vídeo)
│   ├── compose.yaml                     # Docker Compose (API + worker + PostgreSQL + Redis + MinIO + Mailpit)
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars), BullMQ, AWS SDK v3 (S3), FFmpeg |
| Banco de Dados | PostgreSQL 17 |
| Fila e storage (dev) | Redis 8, MinIO (`pgsty/minio`) |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
