---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-05T18:59:14-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T18:55:25-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Título do vídeo no pré-cadastro não definido (obrigatório? nome do arquivo?)"
  - id: AMB-2
    status: open
    summary: "Superfície de leitura do vídeo na Fase 03 indefinida (slug, status, thumbnail)"
  - id: AMB-3
    status: open
    summary: "Destino do registro draft quando o lifecycle aborta o multipart não definido"
  - id: MD-1
    status: resolved
    summary: "Onde rodam os testes que dependem de FFmpeg (worker) não está decidido"
    resolved_by: phase-03-videos/TD-13
  - id: ICC-1
    status: open
    summary: "Acesso direto navegador↔storage vs BFF estrito (next-frontend-config-base/TD-03)"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — A capacidade "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" cria o registro do vídeo antes de existir qualquer edição de informações, mas a edição de título e descrição só chega na Fase 04 ("Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"). Não está definido qual título o vídeo recebe no pré-cadastro: se o cliente envia um título obrigatório no início do upload, se ele deriva do nome do arquivo ou se a coluna fica nula até a Fase 04. Isso afeta o Data Model (nulidade e tamanho da coluna) e o contrato do endpoint de início do upload. Escolha explícita: (a) título obrigatório no início do upload, validado no DTO; (b) título opcional, com padrão = nome do arquivo sem extensão; (c) título nulo até a Fase 04.

- **AMB-2** — As capacidades "URL única por vídeo, sem conflito com outros vídeos" e "Geração automática de thumbnail a partir de um frame do vídeo" geram dados (o `slug` do TD-10 e a chave `videos/{id}/thumbnail.jpg` do TD-08), mas nenhum TD define como a Fase 03 os expõe. O TD-11 cobre só `GET /videos/{id}/stream` e `GET /videos/{id}/download`. Ficam em aberto: (1) se existe nesta fase um endpoint de consulta do vídeo (por `id` e/ou por `slug`) que devolva status, duração, metadados e URL da thumbnail; (2) como o cliente acompanha a passagem `processing → ready` antes de pedir o stream; (3) como a thumbnail é lida, já que o bucket é privado (TD-04). A fronteira com a Fase 04 (painel de gerenciamento) e a Fase 05 (página de visualização) pode cair dos dois lados. Escolha explícita: (a) a Fase 03 expõe `GET /videos/{id}` (dono) com status, metadados, `slug` e URL pré-assinada da thumbnail, e a consulta por `slug` fica para a Fase 05; (b) a Fase 03 expõe também `GET /videos/by-slug/{slug}`; (c) a Fase 03 só gera os dados, e toda leitura fica para as Fases 04/05 (o status passa a ser verificável apenas no banco).

- **AMB-3** — O TD-12 afirma que "uploads `draft` abandonados são recuperados pela regra de lifecycle do storage (TD-05)", mas a regra `AbortIncompleteMultipartUpload` (1 dia, TD-05) só libera as partes no storage. A linha do vídeo continua `draft` no banco, apontando para um `uploadId` que deixa de existir: uma retomada posterior falha e o registro fica órfão para sempre. Não está definido o que acontece com esse registro. Escolha explícita: (a) ao detectar `uploadId` inexistente (na retomada ou na conclusão), marcar o vídeo como `failed` com motivo `upload_expired`; (b) job agendado que marca ou remove `draft` mais antigos que o prazo do lifecycle; (c) aceitar o registro órfão na Fase 03 e deixar a limpeza para o painel da Fase 04 (registrar como fora do escopo).

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — O TD herdado `next-frontend-config-base/TD-03` (BFF estrito) diz: "Route Handlers as the only NestJS caller … Eliminates CORS, eliminates public exposure of the backend URL". Os TDs atuais `phase-03-videos/TD-05`, `TD-09` e `TD-11` fazem o navegador falar **diretamente com o storage**: PUT das partes do upload e GET de stream/download via URLs pré-assinadas. Isso exige CORS no serviço de storage (expondo `ETag`) e um endpoint de storage público (`S3_PUBLIC_ENDPOINT`). Os bytes não passam pela API nem pelo BFF, e o NestJS continua sendo chamado só pelo BFF, mas o contexto não registra que o tráfego navegador ↔ storage é uma exceção consciente ao princípio "sem CORS / sem exposição pública". Escolha explícita: (a) confirmar a compatibilidade, registrando nos TDs atuais (via revisão) que o BFF estrito vale para a API NestJS e que o storage é uma origem separada, com CORS restrito à origem do frontend; (b) rever o TD-05/TD-11 para passar os bytes pelo BFF (contraria a justificativa do TD-05 e o enunciado no caso do upload).

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory adiado: check não aplicável.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-13)_ — Onde rodam os testes que dependem de FFmpeg (worker) não estava decidido. Resolvido com a pesquisa adicional registrada no próprio arquivo de decisões da Fase 03: TD-13 (FFmpeg na imagem de dev comum), TD-14 (worker no processo de teste com prefixo de fila exclusivo) e TD-15 (MinIO real com bucket exclusivo de testes).
