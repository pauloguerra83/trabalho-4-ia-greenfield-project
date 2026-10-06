---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-05T19:10:29-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T19:08:04-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Título do vídeo no pré-cadastro não definido (obrigatório? nome do arquivo?)"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Superfície de leitura do vídeo na Fase 03 indefinida (slug, status, thumbnail)"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Destino do registro draft quando o lifecycle aborta o multipart não definido"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "Onde rodam os testes que dependem de FFmpeg (worker) não está decidido"
    resolved_by: phase-03-videos/TD-13
  - id: ICC-1
    status: resolved
    summary: "Acesso direto navegador↔storage vs BFF estrito (next-frontend-config-base/TD-03)"
    resolved_by: phase-03-videos/TD-09
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory adiado: check não aplicável.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-13)_ — Onde rodam os testes que dependem de FFmpeg (worker) não estava decidido. Resolvido com a pesquisa adicional registrada no próprio arquivo de decisões da Fase 03: TD-13 (FFmpeg na imagem de dev comum), TD-14 (worker no processo de teste com prefixo de fila exclusivo) e TD-15 (MinIO real com bucket exclusivo de testes).
- **AMB-1** _(resolved_by clarification)_ — Título do vídeo no pré-cadastro. Escolha do usuário (b): o título é **opcional** no início do upload; quando ausente, o padrão é o **nome do arquivo sem extensão**. A coluna `title` é **NOT NULL**, então todo vídeo tem título desde o pré-cadastro. A edição de título fica para a Fase 04.
- **AMB-2** _(resolved_by clarification)_ — Superfície de leitura do vídeo na Fase 03. Escolha do usuário (a): a fase expõe **`GET /videos/{id}`** (JWT, só o dono) com status, duração, metadados, `slug` e **URL pré-assinada da thumbnail** (bucket privado, TD-04). O cliente acompanha `processing → ready` por **polling** desse endpoint. A consulta pela URL única (`slug`) e o acesso anônimo ficam para a Fase 05.
- **AMB-3** _(resolved_by clarification)_ — Registro `draft` com upload abortado pelo lifecycle. Escolha do usuário (a): ao detectar que o `uploadId` não existe mais no storage (na retomada ou na conclusão), o vídeo passa a **`failed`** com motivo **`upload_expired`**. Não há job agendado na Fase 03.
- **ICC-1** _(resolved_by phase-03-videos/TD-09)_ — Acesso direto navegador ↔ storage vs BFF estrito. Escolha do usuário (a): revisão anexada ao TD-09 (mesma letra A) confirmando a exceção consciente. O BFF estrito vale para a API NestJS; o storage é uma origem separada, com CORS restrito à origem do frontend (métodos PUT e GET, expondo o header ETag).
