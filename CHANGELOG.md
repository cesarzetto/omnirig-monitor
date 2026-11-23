# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e este projeto adere ao [Versionamento Semântico (SemVer)](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-11-23

### Adicionado (Added)
- **Motor Nativo Ultra-Leve (Rust + Tauri v2):** Binário único portable (`OmniRig-Portable.exe` com ~3.1 MB) sem necessidade de instalação.
- **Arquitetura Zero-Allocation Polling:**
  - Estruturas do sistema (`sysinfo`) reutilizadas em memória via `Mutex` sem realocação por ciclo.
  - Buffers circulares tipados (`Float32Array`) no frontend com renderização Canvas 2D nativa (zero overhead de Garbage Collection).
  - Pausa automática de renderização quando a janela está minimizada (`0.0% CPU`).
- **Layout Responsivo All-in-One:**
  - Barra lateral esquerda com navegação rápida e controle de frequência de polling (`500ms`, `1000ms`, `2500ms`, `Pausado`).
  - Dashboard principal à direita com grade de cards interativos que podem ser maximizados individualmente (`⛶` / `🗗`) para ocupar toda a área de trabalho.
- **Módulos Integrados:**
  1. **CPU-Z & Processador:** Uso global, clock médio, pico recente, carga por thread lógica e especificações de arquitetura.
  2. **Memória RAM & Processos:** Alocação física/virtual e listagem sob demanda dos Top 15 processos consumidores de recursos.
  3. **HWiNFO & Sensores:** Monitoramento térmico com rastreamento de valores Atual, Mínimo, Máximo e Crítico.
  4. **Afterburner & Performance:** Monitoramento de FPS/Frametime, simulador de OSD Overlay (estilo RivaTuner) e perfis rápidos (*Gaming*, *Eco*, *Benchmark*).
  5. **CrystalDiskMark & Armazenamento:** Saúde de partições e motor de benchmark real de leitura/escrita sequencial (`SEQ1M`) e blocos aleatórios (`RND4K` + `IOPS`).
  6. **WinDirStat / Analisador de Espaço:** Scanner recursivo em Rust com visualização Treemap proporcional e ranking de diretórios/arquivos.
  7. **IP & Port Scanner (LAN):** Monitoramento de tráfego RX/TX em tempo real e scanner assíncrono (`tokio`) de sub-rede `/24` (254 hosts em paralelo) com detecção de latência e portas abertas.
- **Exportação:** Geração de snapshot completo de telemetria em formato `.json`.
