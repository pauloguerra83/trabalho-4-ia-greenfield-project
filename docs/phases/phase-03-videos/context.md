---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T18:16:55-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-10-02T15:35:44-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-02T15:35:44-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-02T15:35:44-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-02T15:35:44-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-02T15:35:43-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literais, de `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Não especificado no plano._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _Nenhum citado explicitamente na seção da Fase 03._
**Deferred subprojects:** _Nenhum._
**Sequencing notes:** > Depende de: Fase 01, Fase 02 — frase de abertura: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "> Depende de: Fase 01"
- **Phase 04:** Gerenciamento de Vídeos e Canal — "> Depende de: Fase 02, Fase 03"

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia da Fila de Mensagens | decided | A (BullMQ sobre Redis) | — |
| phase-03-videos/TD-02 | phase | Repo-wide | Imagem Local do Servidor de Storage Compatível com S3 | decided | A (`pgsty/minio`, tag `RELEASE.*` fixada) | — |
| phase-03-videos/TD-03 | phase | Backend | Biblioteca Cliente de S3 | decided | A (AWS SDK v3) | — |
| phase-03-videos/TD-04 | phase | Backend | Layout de Buckets e Chaves de Objeto | decided | A (um bucket privado, prefixo) | — |
| phase-03-videos/TD-05 | phase | Cross-layer | Estratégia de Upload para Arquivos de até 10GB | decided | A (multipart pré-assinado orquestrado pela API) | — |
| phase-03-videos/TD-06 | phase | Backend | Gatilho de Conclusão do Upload para o Processamento | decided | A (conclusão orientada pela API) | — |
| phase-03-videos/TD-07 | phase | Backend | Topologia de Execução do Worker de Vídeo | decided | A (mesmo código, entrypoint e container separados) | — |
| phase-03-videos/TD-08 | phase | Backend | Extração de Metadados e Geração de Thumbnail | decided | A (FFmpeg do sistema sobre URL pré-assinada) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Endpoint de Storage (Host Interno vs. Navegador) | decided | A (endpoints interno + público) | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Identificador de URL Única do Vídeo | decided | A (ID aleatório base64url de 11 caracteres, único) | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Entrega de Streaming e Download, e Quem Pode Acessá-los | decided | A (GETs pré-assinados, só o dono na Fase 03) | — |
| phase-03-videos/TD-12 | phase | Backend | Ciclo de Status do Vídeo e Política de Falha | decided | A (enum `status` draft→processing→ready\|failed, retentativas limitadas, `failed` terminal) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-05, phase-03-videos/TD-09 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-08, phase-03-videos/TD-12 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-03, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-03, phase-03-videos/TD-09, phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** **Opção A (BullMQ sobre Redis)**. É o caminho documentado pelo NestJS, traz retentativa, backoff e deduplicação por id de job prontos (necessários no TD-12) e adiciona um único container de fila pequeno e dedicado, o que atende o requisito do Compose. As Opções B e D evitam o container, mas colocam a carga dos jobs no banco da aplicação, e a B é nova demais. A Opção C exige montar a retentativa à mão para um único tipo de job. Fixar a versão major do BullMQ no `plan-resolve`; preferir a 5.x, a menos que a 6.x seja verificada com o `@nestjs/bullmq` 12.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** **Opção A (`pgsty/minio`, com tag `RELEASE.*` fixada)**. É a única opção que mantém exatamente a configuração "MinIO local" do projeto (mesmas variáveis de ambiente, `mc`, console) e permite fixar a versão, deixando o Compose reproduzível. Como a aplicação só fala S3 através do TD-03, trocar para o RustFS depois é uma mudança em um único serviço do Compose.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** **Opção A (AWS SDK v3)**. O TD-05 precisa de URLs pré-assinadas por parte (`UploadPart`), e o SDK oficial pré-assina qualquer comando tanto no servidor local quanto no S3 real, o que mantém a promessa de "trocar MinIO por S3 em produção" restrita a configuração. Parâmetros do cliente a fixar no plano: `endpoint` (TD-09), `forcePathStyle: true` e `requestChecksumCalculation: 'WHEN_REQUIRED'` + `responseChecksumValidation: 'WHEN_REQUIRED'`. Sem isso, as URLs de parte pré-assinadas podem exigir checksums que o cliente do navegador não envia.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** **Opção A (um bucket privado, prefixo `videos/{videoId}/…`)**. A Fase 03 ainda não tem conceito de visibilidade pública (ele chega na Fase 04), então um único bucket privado com leituras pré-assinadas é o layout mais simples que não vaza rascunhos. Regras de lifecycle por prefixo ainda permitem políticas diferentes por artefato, se necessário. As chaves usam o `videoId` (PK UUID), nunca o slug público (TD-10), então o slug não interfere no storage.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** **Opção A (multipart pré-assinado orquestrado pela API)**. É a única opção que mantém os bytes fora da API, atende os 10GB dentro dos limites do S3 e oferece retomada por parte, como o plano do projeto exige. Parâmetros a fixar no plano: tamanho máximo de `10 GiB`, validado no início pelo tamanho declarado e conferido de novo via `HeadObject` na conclusão; partes de `64 MiB`; tipos de conteúdo `video/*`; regra de lifecycle abortando uploads incompletos após 1 dia; URLs de parte pré-assinadas com validade curta (por exemplo, 1h).
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** **Opção A (conclusão orientada pela API)**. Com o multipart orquestrado pelo cliente (TD-05), a API precisa chamar `CompleteMultipartUpload` de qualquer forma, então enfileirar ali não custa nada, é portável e fica transacional com a mudança de status. A Opção B só adiciona infraestrutura que se comporta de forma diferente em cada ambiente.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** **Opção A (mesmo código, entrypoint e container separados)**. Atende a arquitetura de container separado reaproveitando todos os blocos já existentes, e o worker fica dentro do pipeline único de DoD do `nestjs-project` (testes + `tsc` + lint). O FFmpeg roda como processo filho (TD-08), então o event loop do Node não é bloqueado e os sandboxed processors são desnecessários.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** **Opção A (FFmpeg do sistema executado diretamente sobre uma URL pré-assinada)**. Segue a orientação do próprio upstream após a descontinuação do `fluent-ffmpeg`, mantém os binários fora do `node_modules` compartilhado e deixa o FFmpeg ler o original por Range via HTTP, de modo que um arquivo de 10GB nunca é copiado para o worker. Saída: thumbnail em `videos/{id}/thumbnail.jpg` (JPEG, 1280px de largura, proporção preservada). Os metadados mantêm `duration_seconds` como coluna tipada, mais um JSON curado (resumos de `format`, stream de `video` e stream de `audio`).
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** **Opção A (endpoints interno + público)**. É a única opção que mantém os bytes fora da API e obedece à regra de nome de serviço do Compose em todo o tráfego entre containers. O valor `localhost` aparece apenas no `S3_PUBLIC_ENDPOINT`, voltado ao navegador, e isso precisa estar documentado no CLAUDE.md para não ser confundido com uma violação da regra de rede do Docker.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** **Opção A (ID aleatório base64url de 11 caracteres com restrição de unicidade)**. Atende o "curto e sem conflito" sem dependência e, ao contrário do Sqids, não é enumerável, o que importa para a visibilidade unlisted (acesso só por link) das Fases 04 e 05. Coluna `slug varchar(11) UNIQUE`, gerada no pré-cadastro e imutável.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** **Opção A (URLs GET pré-assinadas, acesso só do dono na Fase 03)**. O suporte nativo a Range do S3 entrega streaming sem tocar na API, e URLs pré-assinadas são o único mecanismo que funciona com `<video src>` sem cookies. Acesso: na Fase 03, só o dono autenticado pode obter URLs de stream e de download, e só com status `ready`. A Fase 05 adiciona acesso anônimo para vídeos publicados como regra aditiva, então nunca será preciso adaptar uma restrição depois. A validade das URLs é parâmetro do plano (ex.: 1h para stream, 15 min para download).
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** **Opção A (enum único `draft | processing | ready | failed`, com 3 tentativas e backoff exponencial, `failed` terminal + mensagem de erro)**. Bate com o ciclo exigido, mantém a Fase 03 livre de conceitos da Fase 04, e as retentativas limitadas evitam que o usuário tenha de reenviar 10GB por causa de um erro transitório. O plano da Fase 04 precisa adicionar a publicação como campo separado; registrar essa passagem nas notas de fora de escopo do plano da Fase 03. Sem endpoint de reprocessamento manual na Fase 03.
**Libraries:** —

## Inherited Decisions Detail

_(Traduzido para pt-BR a partir dos documentos de origem, escritos em inglês. O texto original continua nos arquivos citados em `sources_mtime`.)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Opção A (`@nestjs/config`). É oficial, mantida pelo time do NestJS e tem compatibilidade garantida com o NestJS 11. O padrão de factory `registerAs()` resolve o compartilhamento de configuração com a CLI do TypeORM: a função pode ser importada como função comum pelo `data-source.ts` e também serve de token de injeção dentro do NestJS. Construir um módulo próprio recriaria algo já resolvido, e pacotes de terceiros trazem risco de manutenção.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Opção A (Joi). Integração nativa com o `@nestjs/config` via `validationSchema`, sem nenhuma ligação manual. Converte strings em números nativamente. Usar uma ferramenta para validar env e outra para validar requisições é razoável: o env é validado uma vez na inicialização, e os DTOs a cada requisição. O Zod é elegante, mas acrescentaria um terceiro paradigma de validação ao projeto.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Opção B (configuração por namespace com `registerAs`). O roadmap do projeto prevê explicitamente auth, e-mail e storage nas fases seguintes. Configurações por namespace dão fronteiras claras de arquivo por domínio, injeção tipada via `ConfigType<typeof databaseConfig>` e escalam naturalmente. A factory `registerAs()` tem duplo papel: token de DI dentro do NestJS e função importável pelo `data-source.ts`. Arquivos iniciais da Fase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Opção A (factory `registerAs` compartilhada). É consequência natural de escolher `@nestjs/config` com `registerAs`: a factory já pode ser chamada por construção. O `data-source.ts` a importa, chama `dotenv.config()` e depois a factory. Zero duplicação, código mínimo, nenhuma abstração extra.

**Libraries:** `dotenv` (transitiva via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id. Para um projeto novo em 2026, o Argon2id é a escolha recomendada pela OWASP. A dependência de compilação nativa é um custo único de configuração no Docker. O projeto não tem restrições legadas que favoreçam o bcrypt. Mínimo da OWASP: 19MiB de memória, 2 iterações.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Opção A (`@nestjs/passport`). O plano do projeto só prevê autenticação por e-mail e senha por enquanto, mas a arquitetura de plugins custa pouco e fases futuras podem adicionar login social. Segue a documentação oficial do NestJS, o que facilita onboarding e manutenção.

**Note:** A decisão divergiu de propósito da recomendação durante a implementação: guards próprios foram preferidos ao `@nestjs/passport` para manter menor a superfície de dependências. Login social não está no roadmap próximo, então o benefício da arquitetura de plugins não justificava a camada extra de abstração.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Opção A (rotação de refresh token). Oferece o modelo de segurança mais forte, com detecção automática de roubo. O custo de escrita no banco é aceitável para uma plataforma de vídeos (refresh de autenticação é raro perto das operações de vídeo). O PostgreSQL já está na stack, então não é preciso infraestrutura nova. Condições de corrida podem ser mitigadas com um curto período de tolerância para o token antigo.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Opção B (tokens opacos aleatórios no banco). Poder revogar é importante: quando o usuário pede uma nova redefinição de senha, os tokens anteriores precisam ser invalidados. A tabela é trivial de implementar e pode atender necessidades futuras (ex.: chaves de API). Mantém os tokens de e-mail desacoplados do sistema de autenticação JWT.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Opção A (`@nestjs-modules/mailer`). Melhor integração com o NestJS com o mínimo de código. Suporta SMTP (como no diagrama de arquitetura), funciona com MailHog/Mailpit em desenvolvimento local sem dependências externas e escala para qualquer provedor SMTP em produção. O suporte a template (Handlebars) simplifica a formatação dos e-mails. Sem dependência de fornecedor.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Opção A (`class-validator` + `class-transformer`). É um projeto só de backend (sem schemas compartilhados com o frontend), então a vantagem do Zod de ter uma única fonte de verdade pesa menos. O `class-validator` é a abordagem documentada pelo NestJS, e o projeto já usa decorators em todo lugar (entidades TypeORM, DI do NestJS). Menos surpresas de integração com o NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Opção A (filtro de exceções de domínio próprio). Fornece códigos de erro legíveis por máquina, que o frontend Next.js pode tratar caso a caso, sem o custo do sistema de tipos por URI da RFC 9457. O projeto tem um único consumidor (o frontend próprio), então o formato simples `{ statusCode, error, message }` com códigos de domínio equilibra clareza e simplicidade. O custo do filtro é baixo: dois arquivos pequenos.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Opção A (`@nestjs/throttler`). A integração nativa com o NestJS é decisiva: o sistema de guards permite limitar o rate limiting ao `AuthModule` via `APP_GUARD` no módulo, com `@SkipThrottle()` para exceções. O projeto roda em uma única instância, sem requisitos distribuídos, então o armazenamento em memória basta. Usar `express-rate-limit` contornaria a DI e o ciclo de vida de guards do NestJS sem benefício claro.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Opção B (token opaco). Como a consulta ao banco é obrigatória (TD-03), a assinatura JWT não acrescenta segurança. Tokens opacos são menores, não vazam dados e são mais simples de gerar.

**Note:** A decisão divergiu de propósito da recomendação: o JWT foi mantido para reaproveitar a infraestrutura de assinatura e verificação do access token (`@nestjs/jwt`), trocando tamanho do token e legibilidade em base64 por um formato único de token em todo o código.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Opção A. A plataforma é um serviço de vídeos com identificadores de canal na URL. Uma lista restrita `[a-z0-9_]` é a escolha mais simples e portável: sem dependências extras, sem casos-limite de posição do hífen, e o fallback `user_<random>` garante um identificador válido mesmo para prefixos de e-mail extremos. Hífens podem ser adicionados numa iteração futura, se o retorno dos usuários justificar.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Três motivos. (1) **Encaixe arquitetural.** O modelo de BFF estrito em `next-frontend-config-base/TD-03` já define o Route Handler como único chamador do NestJS; sessão baseada em cookie é o encaixe natural, e as camadas do Auth.js entre o BFF e o cookie não acrescentam nada, porque o backend é a autoridade de autenticação. O que o Auth.js oferece (adaptadores de banco, provedores OAuth, magic link, helpers `getServerSession`) fica quase todo sem uso nessa configuração. (2) **Menor raio de impacto.** Um helper de sessão de ~50 linhas é fácil de buscar, depurar e testar com o padrão MSW+BFF já existente; um callback mal configurado do Auth.js leva mais tempo para isolar. (3) **Compatibilidade com Next.js 16 / React 19.** O `cookies()` nativo de `next/headers` é a primitiva que os dois runtimes já usam; as versões do Auth.js v5 acompanham as majors do Next.js com atraso, o que traz um risco de compatibilidade que a Opção A não tem. A Opção C é rejeitada por ser insegura (`localStorage` para refresh tokens) e por ser um retrocesso arquitetural (perde a personalização via RSC).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Três motivos. (1) **Defesa em profundidade no conteúdo do cookie**: `httpOnly` bloqueia o JS e a criptografia bloqueia inspeção acidental em logs ou proxies; o custo extra é uma dependência de ~3KB. (2) **Um único cookie para gerenciar** simplifica o logout (uma chamada `session.destroy()`) e evita o problema de cookies órfãos da Opção A. (3) **Espaço para metadados mínimos do usuário** (`userId`, `email`, `channelSlug`) permite que o RSC de `app/layout.tsx` renderize a interface autenticada (avatar, nome do canal) sem ida e volta a `/auth/me` a cada renderização; o ganho cresce a partir da Fase 04. A Opção A é um rebaixamento viável se o time rejeitar o `iron-session`; a migração A→B (ou B→A) é a refatoração de um único Route Handler, sem mudança de testes, porque a interface do BFF não muda. A Opção C é rejeitada: resolve um problema (revogação no servidor) que o projeto não tem, ao custo de infraestrutura que o projeto não possui.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** O detalhe de single-flight não é trivial e entra no helper desde o início, testado com MSW por uma asserção do tipo "duas chamadas upstream interceptadas em paralelo; um único refresh esperado". O padrão orientado pelo cliente da Opção B é rejeitado porque não substitui a Opção A (o RSC ainda precisa de refresh no servidor), e adotá-lo significaria fazer os dois. O timer preventivo da Opção C é rejeitado porque os modos de falha (várias abas, suspensão e retomada) pesam mais que o ganho de latência e forçam um shell `"use client"` perto da raiz.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Três motivos. (1) **Desacoplado do TD-05**: funciona com Route Handlers ou com Server Actions, e o código do formulário não muda se o TD-05 for revisto. (2) **Alinhado com a primitiva de formulário padrão do shadcn**: o projeto já usa o shadcn `radix-nova` (`components.json`), e `npx shadcn@latest add form` gera wrappers de react-hook-form; escolher o react-hook-form é usar a primitiva suportada em vez de contorná-la. (3) **A ergonomia Zod-first combina com o resto da base do frontend**: `next-frontend-config-base/TD-01` escolheu o Zod 4 para o env, e o mesmo padrão de schema como fonte de verdade vale para formulários, sem novo paradigma de validação. A Opção B é rejeitada pelo atrito com a primitiva do shadcn e por investir demais em progressive enhancement, que o BFF estrito não exige. A Opção C é rejeitada pelo código repetitivo por campo e pela perda de feedback no cliente num projeto que valoriza iteração rápida e tipada em formulários.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Três motivos. (1) **Alinhamento com o BFF estrito.** `next-frontend-config-base/TD-03` definiu os Route Handlers como superfície do BFF; a Opção A mantém toda mutação visível em `app/api/**`. (2) **A estrutura de testes já existe**: o `next-frontend/CLAUDE.md` § Testing e o `next-frontend-msw-foundation` foram escritos para Route Handlers como funções; a Opção A os reaproveita sem inventar nada. (3) **Uma única superfície de mutação**: a Fase 02 define o precedente para as Fases 03 a 07; uniformidade vence escolher um idioma por mutação quando o custo da inconsistência se acumula (Opção C). A Opção B tem apelo ergonômico real para os formulários mais simples, mas fragmenta a superfície do BFF e obriga a reinventar o padrão de testes. Se o time quiser progressive enhancement em formulários específicos depois, a migração A→B é por formulário e não mexe em rotas não relacionadas; a A é o padrão mais seguro e o ponto de partida mais barato.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Dois motivos que se reforçam. (1) **Sem piscar na primeira renderização e sem ida e volta**: a sessão chega na mesma resposta do HTML da página, o Client Provider hidrata com o estado inicial correto, e o usuário nunca vê "Login" virar o avatar. (2) **Nenhum endpoint novo no BFF**: o cookie é a fonte de verdade, o RSC o lê e o Provider o distribui, mantendo mínima a superfície do BFF. A exigência de `router.refresh()` após mutações no meio da sessão é um preço pequeno (uma linha no handler da mutação) pelos benefícios estruturais. A Opção B é rejeitada pela leitura dupla e pelo piscar; a Opção C é dominada pela B e rejeitada.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Três motivos. (1) **Correto já na primeira pintura**: o usuário vê o resultado certo de imediato, sem skeleton e sem piscar. (2) **Um único padrão de integração nos dois fluxos**: a confirmação é só RSC; a redefinição é RSC + formulário cliente (padrões do TD-04 e TD-05 reaproveitados), e os dois seguem a divisão "o RSC cuida do token, o Client Component cuida da entrada". (3) **A pré-busca de links por clientes de e-mail** é resolvida pela confirmação idempotente no backend (uma nota para o `/plan-build` confirmar, não um TD à parte). O Route Handler como destino do link da Opção B acrescenta redirecionamentos sem ganho claro. A Opção C é dominada.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Opção A (`@nestjs/swagger`)**. É a única opção que preserva as decisões anteriores (`class-validator` no TD-06 de phase-02-auth) sem trocar de plataforma; o plugin da CLI com `classValidatorShim: true` aproveita os decorators do `class-validator` existentes para inferir os schemas, mantendo pouco código repetitivo. O Nestia tem mérito técnico real, mas o custo de migrar a stack de validação o inviabiliza sem uma decisão anterior que substitua o TD-06. A escrita manual do spec é descartada.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o plugin da CLI (`classValidatorShim: true`) cobre apenas a inferência de schemas de DTOs a partir do `class-validator`; a documentação de operações, as respostas tipadas por status code, os contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e os exemplos exigem decorators explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Justificativa:_ o openapi.json gerado pelo bootstrap atual está genérico (sem detalhes de parâmetros, schemas de retorno por status nem contratos de erro) porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que o enriquecimento com decorators explícitos faz parte da Opção A escolhida, e não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Opção C (as duas)**. O custo a mais em relação à Opção A é só um script npm (~15 linhas), e o benefício é uma base correta para a futura integração com o frontend (codegen offline) sem perder a interface interativa que dev e QA usam. A Opção B sozinha prejudica a experiência de desenvolvimento local; a Opção A sozinha compromete o pipeline de codegen futuro. Combinar as duas é a opção dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Opção B (só em dev/staging)**. Segue a postura defensiva já estabelecida na Fase 02 e não prejudica consumidores legítimos (o `openapi.json` commitado no TD-02 cumpre o papel de "spec consultável fora da interface"). Reabrir como Opção A ou C no futuro é trivial, se surgir um caso de uso de API pública.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** **Opção A (Zod 4)**. Três motivos convergentes: (1) **A inferência de tipos combina com a cultura de TS estrito do frontend**: `lib/env.ts` exporta um objeto `env` tipado sem casts `as`, atendendo ao princípio de "Type Safety" do projeto. (2) **Força do ecossistema em Next.js / React 19**: o Zod é a linguagem de schema padrão de fato no App Router (entradas de Server Actions, resolvers de formulário, validação futura de contratos), então introduzi-lo uma vez na camada de env rende mais a partir dos formulários da Fase 02. (3) **Viabiliza diretamente a Opção A do TD-02 (`@t3-oss/env-nextjs`)**, cujo validador principal é o Zod. A paridade com o Joi do backend não é essencial: os schemas de env não são compartilhados entre frontend e backend (runtimes e chaves diferentes), e ter dois validadores em dois subprojetos é um custo limitado.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** **Opção A (`@t3-oss/env-nextjs`)**. É a única opção que combina (i) **exigência do prefixo NEXT_PUBLIC_ em nível de tipo**, (ii) **detecção de vazamento em tempo de execução via Proxy** e (iii) **ergonomia de um único arquivo e um único caminho de import** para quem consome. A Opção B chega a um resultado _estrutural_ parecido com custo maior de implementação e manutenção, e com garantia mais fraca (sem exigência de prefixo, sem proxy). A Opção C é insegura em qualquer time que não seja minúsculo. O custo a mais em relação à B é uma dependência de ~3KB, bem gasta pela fronteira mais forte entre as três.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** **Opção A (BFF estrito: uma única `API_URL`, só no servidor)**. Alinhada com a estratégia de testes do BFF e com o compromisso arquitetural já documentado em `next-frontend/CLAUDE.md` (Route Handlers como único chamador do NestJS; testes do BFF simulam `fetch` via MSW). Elimina CORS, elimina a exposição pública da URL do backend e produz a menor base correta. A `NEXT_PUBLIC_API_URL` da Opção B é uma concessão de "preparação para o futuro" sem consumidor atual; adicionar uma chave pública depois não quebra nada, mas removê-la quebra. A Opção C amarra uma decisão de base a trabalho de infraestrutura adiado explicitamente para depois. A lacuna de rede no Docker (como o servidor dentro do container resolve o backend) é uma decisão separada e independente, tratada no próprio documento de origem.
**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** **Opção B (módulos por domínio + barrel)**. Três motivos. (1) **A própria boa prática do MSW recomenda isso**: o projeto não deve inventar um esquema próprio quando o oficial está documentado e combina com a orientação por domínio do código. (2) **A posse por domínio acompanha o código**, não o plano do projeto: `components/`, `app/api/` e futuras pastas de funcionalidade serão organizadas por domínio (auth, videos, channels), então os arquivos de handlers seguem esse vocabulário e ficam estáveis ao longo das fases. (3) **Crescimento só por acréscimo, com poucos conflitos de merge**: cada fase toca um arquivo novo mais uma linha no barrel, o menor impacto prático entre PRs concorrentes. A Opção A serve até a Fase 02 (~5 a 7 endpoints), mas acumula custos que a B evita desde o início; começar direto na B custa um arquivo e um barrel a mais e se paga até a Fase 03. O acoplamento por fase da Opção C é rejeitado de cara: organizar domínio por fase é um erro de categoria.
**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** **Opção A (só testes, apenas `setupServer` na base)**. O worker no navegador é uma capacidade futura sem consumidor atual documentado; ligá-lo agora (Opção B) é investimento especulativo, e ligá-lo de forma incoerente (Opção C) engana os desenvolvedores, fazendo-os achar que a interceptação funciona quando ela não funciona com BFF estrito. A Opção A mantém a base mínima, segue 1:1 o que o CLAUDE.md e as regras atuais documentam e pode ser estendida sem quebrar nada.
**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** **Opção D (valores padrão escritos à mão + faker com seed, opcional, para coleções grandes)**. Motivos: (1) **O determinismo e a legibilidade da Opção B são a base certa**: toda fixture da Fase 02 (5 a 7 endpoints, quase sempre um único registro) é naturalmente escrita à mão, e o padrão de sobrescrita que evidencia diferenças é o benefício de maior valor. (2) **Coleções grandes vão aparecer (grade da home na Fase 07, threads de comentários na Fase 06), e listas de 20+ itens escritas à mão são realmente tediosas**: manter o faker disponível como ferramenta de uso restrito é pragmático. (3) **Seed local por fixture elimina a armadilha do cursor global** que torna a Opção C frágil: chamar `faker.seed(N)` logo antes de gerar uma coleção restringe o determinismo àquela fixture e a isola de mudanças em outras factories.
**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** **Opção A (conjunto universal de handlers + sobrescritas com `server.use(...)` + `onUnhandledRequest: "error"`)**. A exigência de "importar só o necessário" é atendida na camada de *escrita* pelo TD-01 (arquivos por domínio; cada fase adiciona um arquivo). Na camada de *execução*, carregar todos os handlers é o modelo padrão do MSW v2 e não custa nada para testes que não acessam as outras URLs. O `onUnhandledRequest: "error"` garante que o teste de uma fase não chame por acidente uma rota fora do seu escopo (o fetch falha de forma clara com "no handler matched"), a forma mais forte de "ficar dentro da sua fase". A composição por suíte da Opção B paga um custo real de código repetitivo por uma explicitude que o TD-01 já oferece em outra camada. A Opção C inventa um problema no formato dos projetos do Vitest para uma questão que é de fase.
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** **Opção A (`openapi-typescript` + `openapi-fetch`)**. Três motivos que se reforçam. (1) **Com BFF estrito, um SDK no cliente não tem valor.** Só os Route Handlers chamam o Nest upstream, e eles já usam `fetch` (as extensões de cache do Next 16 ficam em cima do `fetch` nativo); um SDK gerado acrescenta um terceiro estilo de cliente para aprender sem ganho funcional. (2) **Tipos primeiro combina com o resto da base do frontend.** A validação de env gera tipos via Zod; as variantes de componentes são tipos `cva`; ambos são TS-first sem runtime gerado. O `paths` é a extensão natural: um único arquivo `.d.ts` importado onde o contrato é usado. (3) **A tipagem do MSW se resolve com o mesmo símbolo `paths`.** Handlers escritos à mão em `mocks/handlers.ts` tipam o retorno a partir de `paths["/videos"]["get"]["responses"][200]`, garantindo o contrato sem os handlers verbosos gerados por orval/kubb (que seriam sobrescritos por teste de qualquer forma). O custo de adicionar o `openapi-fetch` (~6KB, só no servidor) é pequeno o bastante para recomendar o par **tipos + cliente fino**, e não só os tipos: o `openapi-fetch` elimina o código repetitivo `fetch(API_URL + path, { method, headers, body })` em cada Route Handler, sem sair do modelo BFF. As Opções B/C/D podem ser revistas se (a) o carregamento de dados no cliente entrar na stack com TanStack Query e houver interesse em hooks por endpoint, ou (b) a API passar de ~20 operações e o código repetitivo por chamada começar a pesar.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** **Opção B (cópia local commitada + script de sincronização na raiz do repositório)**. Três motivos. (1) **Preserva a independência entre as stacks do Compose** que o Context de `next-frontend-config-base/TD-03` descreve como arquitetura atual: nenhum arquivo compose de um subprojeto referencia o outro. (2) **A divergência é eliminada estruturalmente quando combinada com a checagem de atualização em CI do TD-03**: a checagem roda o script de sincronização e exige que não haja diferença no `openapi.json` nem no `types.gen.ts`, então um PR de backend que esquecer de sincronizar falha no CI com uma mensagem clara. (3) **O arquivo local commitado é um artefato real na revisão de PR**: os revisores veem a mudança de contrato no diff de `next-frontend/openapi.json` junto com a mudança no backend, o que dobra a visibilidade (um diff só de `openapi.json` num PR de funcionalidade indica divergência acidental). A Opção A é aceitável como alternativa enquanto não há CI; a Opção C é rejeitada porque a dependência de arquivos entre stacks no `docker-compose.yaml` cria um acoplamento que a arquitetura atual evita explicitamente, e o ganho de "zero divergência" sobre a B é pequeno depois que o TD-03 entra.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** **Opção C (commitado + checagem de atualização no CI)**. É a única opção que torna a divergência de contrato _visível_ (nos diffs de PR) _e_ impossível de mesclar por acidente (falha no CI). O custo a mais em relação à Opção A é um passo de CI. A pureza de "nenhum artefato commitado" da Opção B sai cara num monorepo, onde o acoplamento de build entre subprojetos vira um custo ergonômico real, e desperdiça a visibilidade em PR que o `openapi.json` commitado da Opção B do TD-02 foi feito para dar. A Opção A é aceitável como estado temporário até o pipeline de CI existir; rebaixar de C para A é reversível (basta remover o passo de CI), mas subir para C depois exige explicar o histórico do `types.gen.ts` num commit separado. Começar pela C. Aplicar o mesmo padrão de script + checagem a qualquer artefato gerado no futuro (ex.: se o `openapi-fetch` for encapsulado, o wrapper é escrito à mão e o único artefato gerado continua sendo o `types.gen.ts`).
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** **Opção A (um único `lib/api/contracts.ts` com aliases explícitos)**. É a única opção que (i) trata repasse e reformatação com o mesmo mecanismo, (ii) dá um único alvo de busca para "que formato o BFF expõe" e (iii) desacopla os imports dos componentes dos caminhos de arquivo do App Router (os componentes importam `from "@/lib/api/contracts"`, não `from "@/app/api/videos/route"`). A Opção B é teoricamente mínima, mas frágil diante da tipagem real de RSC/Client/Route Handler do Next; a Opção C espalha a superfície do contrato e abre espaço para divergência. A preocupação com "arquivo longo" é limitada: no escopo do StreamTube, o BFF deve ter menos de 30 aliases de contrato no pico, e separar por comentários de cabeçalho por funcionalidade basta. Fazer do `lib/api/contracts.ts` o único arquivo que importa `paths` de `types.gen.ts` (verificável por lint depois); todo outro consumidor importa de `contracts.ts`.
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** **Opção A (escritos à mão, tipados via `paths`)**. Motivos: (1) **Determinismo em vez de geração automática**: os testes de integração do BFF verificam valores específicos, e fixtures aleatórias atrapalham. (2) **Coerência com a recomendação do TD-01**: o tipo `paths` do `openapi-typescript` é a âncora única do contrato, e reaproveitá-lo nos handlers do MSW forma uma única cadeia de tipos "spec ↔ handler ↔ asserção". (3) **Adequado à escala**: a Fase 02 introduz poucos endpoints, e o custo manual é desprezível nesta etapa. Se a API crescer para dezenas de endpoints e o esforço de escrita pesar, este TD pode ser substituído por um plugin MSW do Kubb ou do hey-api sem mexer nos pontos de import de `paths` do TD-01 (o gerador só produz arquivos de handler adicionais, e os handlers manuais continuam válidos). A Opção B prende o projeto a uma escolha mais pesada no TD-01 em troca de pouca economia na escrita de mocks; a Opção C é a Opção A com um desvio desnecessário.
**Libraries:** —

## Inherited Conventions

- A configuração do backend usa `@nestjs/config` com factories `registerAs(name, () => ({...}))` por namespace, um arquivo por domínio em `src/config/`. _(from phase 01)_
- As variáveis de ambiente são validadas por um schema Joi em `src/config/env.validation.ts`, passado ao `ConfigModule.forRoot({ validationSchema, ...})`. _(from phase 01)_
- A configuração é injetada nos módulos via `ConfigType<typeof xxxConfig>` e `@Inject(xxxConfig.KEY)`; a mesma factory pode ser importada como função comum. _(from phase 01)_
- O `data-source.ts` carrega o `.env` com `import 'dotenv/config'` no topo, depois importa o `databaseConfig` e o chama como função comum. _(from phase 01)_
- Os parâmetros de conexão do banco (host, porta etc.) vêm de uma única factory `databaseConfig`, nunca duplicados entre o `AppModule` e a CLI. _(from phase 01)_
- Usa-se `TypeOrmModule.forRootAsync` (não `forRoot`), com `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]` e `useFactory` retornando a configuração. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | O `next-frontend/` não é inicializado nesta fase; as telas começam numa fase posterior. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | O `next-frontend/` não é inicializado nesta fase; as telas começam numa fase posterior. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | Adiada para a próxima fase: a tela de destino foi retirada do escopo em 2026-05-14; o fluxo de confirmação no frontend (TD-07) fica para uma fase futura. O lado do backend não mudou em `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Adiada para a próxima fase: o botão de logout fica dentro da interface autenticada (normalmente na Fase 04). A Fase 02 já implementa o POST `/api/auth/logout` (route handler do BFF + `session.destroy()`), então o contrato está pronto quando essa interface chegar. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | Adiada para a próxima fase: o `/forgot-password` sai nesta fase enviando o e-mail; a tela de destino para definir a nova senha não existe no Figma, então o link continua levando a um 404 até uma fase posterior entregar a tela via uma nova execução do `/screen-inventory`. Registrado como lacuna conhecida. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | A tela de confirmação da conta não será implementada nesta fase e foi adiada. A cobertura completa desse item exige as telas de confirmação e de redefinição de senha, ambas adiadas nas linhas acima. As 3 telas entregues nesta fase (cadastro, login, esqueci a senha) estão inventariadas e cobertas pelos próprios verbos; o item como um todo fica para a fase que entregar as telas que faltam. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context 03 to activate UI checks._

(Inventário de telas não aplicável: a interface de vídeo está fora do escopo da Fase 03. A detecção de UI foi um falso positivo, causado pela palavra "arquivos".)

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entidade (`*.entity.ts`) | Integração: restrições, valores padrão, `select: false` |
| Service com ramificações + banco | Unitário: lógica das ramificações (repositório mockado) + Integração: contrato com o banco |
| Service só com banco (sem ramificações) | Integração: contrato com o banco |
| Service com lib configurada (JWT, cache) | Unitário: lib real com configuração de teste |
| Service com dependência de efeito colateral (e-mail, storage) | Integração: serviço real de captura (Mailpit) ou adaptador local |
| Módulo com imports configurados | Unitário: teste de compilação |
| Controller | Apenas E2E (não escrever testes unitários) |
| DTO | E2E: um teste de ligação da validação por endpoint |
| Guard (delega a lógica de negócio a um service) | E2E + Unitário se houver lógica interna complexa |
| Guard (simples, delega ao Passport) | Apenas E2E |
| Strategy (Passport) | E2E via guard |
| Pipe (transformação/validação própria) | Unitário |
| Interceptor (transformação de resposta, log) | Unitário e/ou E2E |
| Exception Filter | Unitário + E2E |
| Middleware | E2E |
