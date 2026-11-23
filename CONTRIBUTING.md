# Guia de Contribuição (Contributing)

Obrigado pelo interesse em contribuir com o **OmniRig Monitor**! Este documento define os padrões de arquitetura, performance e versionamento que mantêm o projeto rápido, leve e 100% portable.

---

## ⚡ Princípios Inegociáveis de Performance

Qualquer nova funcionalidade ou ferramenta adicionada ao OmniRig deve respeitar estas 4 diretrizes:

1. **Portabilidade Absoluta:** O build final deve continuar sendo um único arquivo `.exe` estático (sem instaladores obrigatórios ou pastas externas de runtime).
2. **Orçamento de Memória e CPU:** O loop de monitoramento padrão (`1000ms`) deve consumir **< 0.5% de CPU** e manter alocação constante de RAM (zero *memory leaks*).
3. **Sem Bibliotecas Pesadas no Frontend:** Utilize Vanilla JS (`Float32Array`, `CanvasRenderingContext2D`) e CSS Grid/Flexbox nativos. Evite importar frameworks pesados que aumentem o uso de RAM do WebView2.
4. **Execução Assíncrona em Rust:** Operações de I/O de disco ou rede (como benchmark ou scan de IPs) devem sempre rodar em threads assíncronas (`tokio::spawn` ou `async fn`) para nunca bloquear a thread principal da interface.

---

## 🔀 Padrão de Commits (Conventional Commits)

Utilizamos o padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/) para manter o histórico limpo e facilitar a geração do `CHANGELOG.md`:

- `feat:` Nova funcionalidade ou novo módulo de ferramenta (ex: `feat(gpu): add NVML temperature sensor support`)
- `fix:` Correção de bug (ex: `fix(ipscan): handle subnet prefix with trailing dot`)
- `perf:` Melhoria de performance ou redução de consumo de RAM/CPU
- `docs:` Alterações apenas na documentação (`README.md`, `CHANGELOG.md`, etc.)
- `refactor:` Refatoração de código sem alteração de comportamento
- `ci:` Ajustes nos workflows do GitHub Actions

---

## 🏷️ Versionamento (SemVer)

Seguimos o **Semantic Versioning (`MAJOR.MINOR.PATCH`)**:
1. Atualize a versão em `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`.
2. Documente as novidades no `CHANGELOG.md`.
3. Crie uma tag anotada (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`) e envie para o GitHub (`git push origin vX.Y.Z`).
