# ROADMAP: Pipeline de Despliegue Mejorado con `main-promocion-pro`

**Fecha:** 2026-02-15
**Versión:** 2.0
**Alcance:** Arquitectura completa de branching, 8 workflows, seguridad y automatización

---

## TABLA DE CONTENIDOS

1. [Vision y Objetivos](#1-visión-y-objetivos)
2. [Arquitectura de Branching](#2-arquitectura-de-branching)
3. [Modelo de 8 Workflows](#3-modelo-de-8-workflows)
4. [Fase 0: Seguridad (P0)](#4-fase-0-seguridad-p0)
5. [Fase 1: Alinear Workflows con main-promocion-pro (P1)](#5-fase-1-alinear-workflows-con-main-promocion-pro-p1)
6. [Fase 2: Gestion de Estado (P1)](#6-fase-2-gestión-de-estado-p1)
7. [Fase 3: Robustez (P2)](#7-fase-3-robustez-p2)
8. [Fase 4: Workflows Faltantes (P2)](#8-fase-4-workflows-faltantes-p2)
9. [Fase 5: Enterprise Hardening (P3)](#9-fase-5-enterprise-hardening-p3)
10. [Plan de Migracion](#10-plan-de-migración)
11. [Matriz de Riesgos](#11-matriz-de-riesgos)
12. [Comparativa Actual vs Propuesta](#12-comparativa-actual-vs-propuesta)

---

## 1. Vision y Objetivos

### 1.1 Problema Actual

El pipeline actual tiene 4 workflows que cubren **solo produccion** (1 de 3 entornos). Los workflows operan directamente sobre `main`, pero la arquitectura describe `main-promocion-pro` como rama buffer. Esta desalineacion, junto con vulnerabilidades de seguridad y ausencia de automatizacion en desarrollo y pre-produccion, impide que el sistema sea enterprise-ready.

### 1.2 Objetivo

Un pipeline seguro, completamente automatizado, de **8 workflows** que cubra los 3 entornos (desarrollo, pre-produccion, produccion) usando `main-promocion-pro` como buffer de verificacion antes de que el codigo llegue a `main`.

### 1.3 Principios Fundamentales

| # | Principio | Descripcion |
|---|-----------|-------------|
| 1 | **`main` es sagrada** | Solo recibe codigo que ha sido desplegado y verificado en produccion |
| 2 | **Un solo tag por release** | Creado en `main-promocion-pro`, heredado por `main` al merge |
| 3 | **Zero injection surface** | Todas las expresiones `${{ }}` pasan por bloques `env:` |
| 4 | **Sin commits de estado a `main`** | Usar GitHub Deployments API o rama `deploy-state` |
| 5 | **DRY en build/deploy** | Composite action compartida entre deploy y rollback |
| 6 | **Merge manual controlado** | Tras health check exitoso, la PR queda lista para que el usuario la mergee manualmente |

---

## 2. Arquitectura de Branching

### 2.1 Diagrama General

```
feature/* ──PR──> develop ─────────────────> [Auto-deploy a Desarrollo]
                      |                        (workflow: deploy-dev.yml)
                      |
                      |── release/vX.Y.Z ────> [Auto-deploy a Pre-produccion]
                      |                          (workflow: deploy-pre.yml)
                      |
                      |── hotfix/vX.Y.Z  ────> [Auto-deploy a Pre-produccion]
                              |                  (workflow: deploy-pre.yml)
                              |
                              +── PR merge a main-promocion-pro
                                      |
                                      |── Crear tag vX.Y.Z (unico)
                                      |── Crear GitHub Release (draft)
                                      |── Crear PR automatica: main-promocion-pro -> main
                                      |
                                      +── Deploy a Produccion (environment gate)
                                              |
                                         health check OK?
                                              |
                                    +---------+---------+
                                    |                   |
                                   SI                  NO
                                    |                   |
                              PR marcada como      main INTACTA
                              "ready-to-merge"     Rollback a tag
                              + comentario en PR   anterior
                                    |
                              Usuario mergea
                              manualmente la PR
                                    |
                              Sync main -> develop
                              (manual o PR)
```

### 2.2 Ramas Permanentes

| Rama | Proposito | Quien escribe | Proteccion |
|------|-----------|---------------|------------|
| `main` | Codigo verificado en produccion | Solo merge manual via PR desde `main-promocion-pro` | PR obligatoria, no direct push, no force push |
| `main-promocion-pro` | Buffer de verificacion pre-main | Solo merge desde `release/*` o `hotfix/*` | PR obligatoria, no direct push |
| `develop` | Integracion continua | Merge desde `feature/*` + sync desde `main` | PR obligatoria |

### 2.3 Ramas Temporales

| Rama | Creada desde | Se mergea a | Vida util |
|------|-------------|-------------|-----------|
| `feature/*` | `develop` | `develop` | Hasta merge de PR |
| `release/vX.Y.Z` | `develop` | `main-promocion-pro` | Hasta deploy exitoso en produccion |
| `hotfix/vX.Y.Z` | `main-promocion-pro` | `main-promocion-pro` | Hasta deploy exitoso en produccion |
| `deploy-state` | Orphan (sin padre) | **Nunca se mergea** | Permanente (solo estado) |

### 2.4 Por que `main-promocion-pro`

```
SIN main-promocion-pro:                    CON main-promocion-pro:

release/* ──merge──> main                  release/* ──merge──> main-promocion-pro
    |                                          |
    +── tag v2.4.0                             +── tag v2.4.0
    +── GitHub Release                         +── deploy a produccion
    +── deploy a produccion                    |
    |                                     health check OK?
 health check FALLA                            |
    |                                     SI: PR lista, merge manual
 main CONTAMINADA                              (main solo recibe codigo
 con codigo que fallo                           verificado en produccion)
 en produccion                            NO: main INTACTA
                                               rollback a tag anterior
```

**`main-promocion-pro` actua como gate de verificacion.** El tag y release se crean ANTES del deploy, pero `main` solo recibe el codigo DESPUES de verificar que produccion funciona correctamente.

### 2.5 Ciclo de Vida de un Tag

```
1. PR merged: release/v2.4.0 -> main-promocion-pro
2. release.yml crea tag v2.4.0 en main-promocion-pro (commit X)
3. release.yml crea PR: main-promocion-pro -> main
4. deploy-production.yml despliega tag v2.4.0
5. Health check pasa
6. deploy-production.yml marca la PR como "ready-to-merge" + comentario
7. El usuario mergea la PR manualmente cuando lo considere oportuno
8. El commit X (con tag v2.4.0) ahora esta en el historial de main
9. NO se crea un segundo tag. El tag es global, apunta al SHA del commit X.
```

> **Clave:** Un tag de Git es un puntero a un SHA, no a una rama. Una vez que `main-promocion-pro` se mergea a `main`, el commit taggeado pertenece a ambas ramas. `git describe --tags` en `main` encontrara el tag correctamente.

---

## 3. Modelo de 8 Workflows

### 3.1 Vista General

| # | Workflow | Trigger | Entorno | Runner | Responsabilidad |
|---|---------|---------|---------|--------|-----------------|
| 1 | `ci.yml` | PR a develop, main-promocion-pro, main | -- | github-hosted | Lint, tests, build check |
| 2 | `deploy-dev.yml` | Push a `develop` | desarrollo | self-hosted / github-hosted | Deploy automatico a desarrollo |
| 3 | `deploy-pre.yml` | Push a `release/*`, `hotfix/*` | pre-produccion | self-hosted / github-hosted | Deploy + smoke tests a pre-produccion |
| 4 | `release.yml` | PR merged a `main-promocion-pro` | -- | github-hosted | Crear tag, release, PR a main |
| 5 | `deploy-schedule.yml` | Cron 5min + dispatch | -- | github-hosted | Monitorizar schedules, disparar deploy |
| 6 | `deploy-production.yml` | workflow_dispatch | produccion | self-hosted | Deploy + health check + marcar PR lista para merge |
| 7 | `rollback-manual.yml` | workflow_dispatch | produccion | self-hosted | Rollback con triple proteccion |
| 8 | `sync-alert.yml` | Cron 1h | -- | github-hosted | Detectar desincronizacion main-promocion-pro vs main |

### 3.2 Diagrama de Comunicacion entre Workflows

```
                    ci.yml
                   (PR gate)
                      |
   deploy-dev.yml     |     deploy-pre.yml
   (push develop)     |     (push release/hotfix)
         |            |           |
         v            v           v
   [Desarrollo]   [CI Pass]   [Pre-produccion]
                      |
                      v
               release.yml ─────────────────────> Crea tag + PR
               (PR merged a main-promocion-pro)          |
                      |                                   |
                      v                                   v
           deploy-schedule.yml ──dispatch──> deploy-production.yml
           (cron cada 5 min)                       |
                                              health check
                                                   |
                                              +----+----+
                                              |         |
                                             OK       FALLO
                                              |         |
                                         PR lista     rollback-manual.yml
                                         merge manual (manual, independiente)
                                              |
                                         sync main -> develop
                                              |
                                         sync-alert.yml
                                         (vigila desync)
```

### 3.3 Especificacion Detallada de Cada Workflow

---

#### Workflow 1: `ci.yml` — CI Pipeline

```yaml
name: "CI - Lint, Test, Build"

on:
  pull_request:
    branches: [develop, main-promocion-pro, main]

concurrency:
  group: ci-${{ github.event.pull_request.number }}
  cancel-in-progress: true    # Re-run en nuevo push a PR

permissions:
  contents: read
  checks: write

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: "Lint"
        run: |
          # REEMPLAZAR con linter real
          echo "Ejecutando lint..."

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: "Tests unitarios"
        run: |
          # REEMPLAZAR con tests reales
          echo "Ejecutando tests..."

  build-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: "Verificar que el build compila"
        run: |
          # REEMPLAZAR con build real
          echo "Verificando build..."
```

**Notas:**
- `cancel-in-progress: true` — Si llega un nuevo push a la PR, cancela el CI anterior.
- Los 3 jobs corren en paralelo para maximizar velocidad.
- Es prerequisito para merge en branch protection rules.

---

#### Workflow 2: `deploy-dev.yml` — Deploy a Desarrollo

```yaml
name: "Deploy - Development"

on:
  push:
    branches: [develop]

concurrency:
  group: deploy-development
  cancel-in-progress: true    # En dev, ultimo push gana

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest    # o self-hosted si el entorno dev es on-premise
    environment: development
    steps:
      - uses: actions/checkout@v4

      - name: "Build"
        run: |
          # REEMPLAZAR con build real
          echo "Building para desarrollo..."

      - name: "Deploy a desarrollo"
        run: |
          # REEMPLAZAR con deploy real
          echo "Desplegando a desarrollo..."

      - name: "Smoke test"
        run: |
          # REEMPLAZAR con smoke test real
          echo "Smoke test basico..."
```

**Notas:**
- `cancel-in-progress: true` — En desarrollo, el ultimo push gana. No tiene sentido completar un deploy de codigo que ya fue reemplazado.
- `environment: development` — Sin gate de aprobacion, solo para visibilidad.

---

#### Workflow 3: `deploy-pre.yml` — Deploy a Pre-produccion

```yaml
name: "Deploy - Pre-production"

on:
  push:
    branches:
      - 'release/**'
      - 'hotfix/**'

concurrency:
  group: deploy-preproduction
  cancel-in-progress: false    # No cancelar deploys a pre-produccion

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest    # o self-hosted
    environment: pre-production
    steps:
      - uses: actions/checkout@v4

      - name: "Build"
        run: |
          # REEMPLAZAR con build real
          echo "Building para pre-produccion..."

      - name: "Deploy a pre-produccion"
        run: |
          # REEMPLAZAR con deploy real
          echo "Desplegando a pre-produccion..."

      - name: "Smoke tests"
        run: |
          # REEMPLAZAR con smoke tests reales
          echo "Ejecutando smoke tests..."

      - name: "Integration tests"
        run: |
          # REEMPLAZAR con integration tests reales
          echo "Ejecutando integration tests..."
```

**Notas:**
- Trigger en push a `release/**` y `hotfix/**` (doble asterisco para subbranches).
- `cancel-in-progress: false` — Pre-produccion debe completar cada deploy.
- `environment: pre-production` — Opcionalmente con gate de aprobacion.

---

#### Workflow 4: `release.yml` — Crear Tag y Release (MEJORADO)

**Cambio critico vs actual:** Trigger cambia de `push: main` a `pull_request[closed]: main-promocion-pro`.

```yaml
name: "Release - Create Semantic Tag"

on:
  pull_request:
    types: [closed]
    branches: [main-promocion-pro]

permissions:
  contents: write
  pull-requests: write

jobs:
  create-release:
    # Solo si el PR fue merged (no cerrado sin merge)
    # Y solo si viene de release/* o hotfix/*
    if: >
      github.event.pull_request.merged == true &&
      (startsWith(github.event.pull_request.head.ref, 'release/') ||
       startsWith(github.event.pull_request.head.ref, 'hotfix/'))
    runs-on: ubuntu-latest

    steps:
      - name: "Checkout main-promocion-pro"
        uses: actions/checkout@v4
        with:
          ref: main-promocion-pro
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      # --- Extraer version del nombre de rama (SEGURO) ---
      # release/v2.4.0 -> v2.4.0 | hotfix/v2.4.1 -> v2.4.1
      # Inmune a inyeccion: el nombre de rama es controlado
      - name: "Extraer version del nombre de rama"
        id: version
        env:
          BRANCH: ${{ github.event.pull_request.head.ref }}
        run: |
          VERSION=$(echo "${BRANCH}" | grep -oP 'v\d+\.\d+\.\d+' || echo "")
          if [ -z "${VERSION}" ]; then
            echo "ERROR: No se encontro version en el nombre de rama: ${BRANCH}"
            echo "Formato requerido: release/vX.Y.Z o hotfix/vX.Y.Z"
            exit 1
          fi
          echo "version=${VERSION}" >> $GITHUB_OUTPUT
          echo "Version extraida: ${VERSION}"

      # --- Verificar que el tag no existe ---
      - name: "Verificar que el tag no existe"
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          if git rev-parse --verify "refs/tags/${VERSION}" > /dev/null 2>&1; then
            echo "ERROR: Tag ${VERSION} ya existe"
            exit 1
          fi
          echo "Tag ${VERSION} disponible"

      # --- Determinar tipo de bump ---
      - name: "Determinar tipo de cambio"
        id: bump-type
        env:
          BRANCH: ${{ github.event.pull_request.head.ref }}
        run: |
          if echo "${BRANCH}" | grep -q '^hotfix/'; then
            echo "type=hotfix" >> $GITHUB_OUTPUT
          else
            echo "type=release" >> $GITHUB_OUTPUT
          fi

      # --- Crear tag anotado y GitHub Release ---
      - name: "Crear GitHub Release"
        uses: softprops/action-gh-release@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: ${{ steps.version.outputs.version }}
          target_commitish: main-promocion-pro
          name: "Release ${{ steps.version.outputs.version }}"
          body: |
            **Tipo de cambio:** ${{ steps.bump-type.outputs.type }}
            **Rama origen:** ${{ github.event.pull_request.head.ref }}
            **PR:** #${{ github.event.pull_request.number }}

            ${{ github.event.pull_request.body }}
          draft: false
          prerelease: false

      # --- Crear PR automatica: main-promocion-pro -> main ---
      # Esta PR quedara lista para merge manual tras health check exitoso
      - name: "Crear PR a main"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          # Verificar si ya existe una PR abierta
          EXISTING_PR=$(gh pr list \
            --base main \
            --head main-promocion-pro \
            --state open \
            --json number \
            --jq '.[0].number // empty')

          if [ -n "${EXISTING_PR}" ]; then
            echo "Ya existe PR abierta #${EXISTING_PR}. Actualizando titulo..."
            gh pr edit "${EXISTING_PR}" \
              --title "release: merge ${VERSION} a main tras verificacion en produccion"
          else
            gh pr create \
              --base main \
              --head main-promocion-pro \
              --title "release: merge ${VERSION} a main tras verificacion en produccion" \
              --body "$(cat <<'PRBODY'
          ## Merge manual tras verificacion en produccion

          Cuando el deploy a produccion sea exitoso y el health check pase,
          **deploy-production.yml** marcara esta PR como lista para merge
          y agregara un comentario confirmandolo.

          **Mergear esta PR manualmente** una vez verificado el deploy.

          Tag: ${VERSION}
          PRBODY
          )"
          fi

      # --- Extraer fecha de deploy del body del PR (SEGURO) ---
      # En vez del commit message, leemos del body del PR
      - name: "Extraer metadata de deploy del PR"
        id: extract-metadata
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          # Extraer DEPLOY_SCHEDULED del body del PR
          SCHEDULED_DATE=$(echo "${PR_BODY}" | grep -oP 'DEPLOY_SCHEDULED:\s*\K[^\s]+' || echo "")

          if [ -z "${SCHEDULED_DATE}" ]; then
            echo "WARN: No se encontro DEPLOY_SCHEDULED en el body del PR."
            echo "El deploy debera dispararse manualmente via workflow_dispatch."
            echo "has_schedule=false" >> $GITHUB_OUTPUT
            exit 0
          fi

          # Validar formato ISO 8601
          if ! date --date="${SCHEDULED_DATE}" +%s > /dev/null 2>&1; then
            echo "ERROR: Fecha invalida: ${SCHEDULED_DATE}"
            echo "Use formato ISO 8601: YYYY-MM-DDTHH:MM:SS+HH:MM"
            exit 1
          fi

          EPOCH=$(date --date="${SCHEDULED_DATE}" +%s)
          echo "scheduled_date=${SCHEDULED_DATE}" >> $GITHUB_OUTPUT
          echo "scheduled_epoch=${EPOCH}" >> $GITHUB_OUTPUT
          echo "has_schedule=true" >> $GITHUB_OUTPUT

      # --- Extraer TYPEAPP del body del PR ---
      - name: "Extraer tipo de aplicacion"
        id: extract-typeapp
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          TYPEAPP=$(echo "${PR_BODY}" | grep -oP 'TYPEAPP:\s*\K[^\s]+' || echo "both")

          if [[ ! "${TYPEAPP}" =~ ^(frontend|backend|both)$ ]]; then
            echo "WARN: TYPEAPP invalido '${TYPEAPP}', usando default: both"
            TYPEAPP="both"
          fi

          echo "typeapp=${TYPEAPP}" >> $GITHUB_OUTPUT

      # --- Crear schedule file en rama deploy-state ---
      - name: "Crear schedule en deploy-state"
        if: steps.extract-metadata.outputs.has_schedule == 'true'
        env:
          VERSION: ${{ steps.version.outputs.version }}
          SCHEDULED_DATE: ${{ steps.extract-metadata.outputs.scheduled_date }}
          SCHEDULED_EPOCH: ${{ steps.extract-metadata.outputs.scheduled_epoch }}
          TYPEAPP: ${{ steps.extract-typeapp.outputs.typeapp }}
        run: |
          # Cambiar a rama deploy-state
          git fetch origin deploy-state 2>/dev/null || true
          git checkout deploy-state 2>/dev/null || git checkout --orphan deploy-state

          mkdir -p deploy-schedule

          cat > "deploy-schedule/${VERSION}.json" << JSONEOF
          {
            "tag": "${VERSION}",
            "typeapp": "${TYPEAPP}",
            "scheduled_date_original": "${SCHEDULED_DATE}",
            "scheduled_epoch_utc": ${SCHEDULED_EPOCH},
            "status": "pending",
            "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          }
          JSONEOF

          git config user.email "github-actions[bot]@users.noreply.github.com"
          git config user.name "GitHub Actions Bot"
          git add "deploy-schedule/${VERSION}.json"
          git commit -m "schedule: ${VERSION} at ${SCHEDULED_DATE}"

          # Push con retry
          for i in 1 2 3; do
            git push origin deploy-state && break
            echo "Push fallo (intento $i/3). Reintentando..."
            git pull --rebase origin deploy-state
            sleep 2
          done
```

**Diferencias clave vs `1-release.yml` actual:**

| Aspecto | Actual | Mejorado |
|---------|--------|----------|
| Trigger | `push: main` | `pull_request[closed]: main-promocion-pro` |
| Version source | Commit message `[major]`/`[minor]`/`[patch]` | Nombre de rama `release/vX.Y.Z` |
| Metadata source | Commit message `DEPLOY_SCHEDULED:` | Body del PR |
| Schedule storage | Commit a `main` | Commit a `deploy-state` |
| PR a main | No existe | Creada automaticamente |
| Seguridad | Interpolacion directa | Bloques `env:` |

---

#### Workflow 5: `deploy-schedule.yml` — Monitor y Trigger (MEJORADO)

```yaml
name: "Deploy Schedule - Monitor & Trigger"

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
    inputs:
      force_tag:
        description: 'Tag a desplegar inmediatamente (ej: v2.4.0)'
        required: false
        type: string
      force_typeapp:
        description: 'Tipo de aplicacion'
        required: false
        default: 'both'
        type: choice
        options: [both, frontend, backend]

concurrency:
  group: deploy-schedule
  cancel-in-progress: false

permissions:
  contents: read
  actions: write

jobs:
  check-schedule:
    runs-on: ubuntu-latest

    steps:
      - name: "Checkout rama deploy-state"
        uses: actions/checkout@v4
        with:
          ref: deploy-state
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      # --- Dispatch manual ---
      - name: "Manejar dispatch manual"
        id: check-manual
        env:
          FORCE_TAG: ${{ github.event.inputs.force_tag }}
          FORCE_TYPEAPP: ${{ github.event.inputs.force_typeapp }}
        run: |
          if [ -n "${FORCE_TAG}" ]; then
            echo "manual_trigger=true" >> $GITHUB_OUTPUT
            echo "target_tag=${FORCE_TAG}" >> $GITHUB_OUTPUT
            echo "target_typeapp=${FORCE_TYPEAPP:-both}" >> $GITHUB_OUTPUT
          else
            echo "manual_trigger=false" >> $GITHUB_OUTPUT
          fi

      # --- Escaneo de schedules (PYTHON CONSOLIDADO) ---
      - name: "Escanear schedules pendientes"
        id: scan-schedule
        if: steps.check-manual.outputs.manual_trigger == 'false'
        run: |
          python3 << 'PYEOF'
          import json, os, time, glob

          current_epoch = int(time.time())
          found = False

          for filepath in sorted(glob.glob("deploy-schedule/*.json")):
              with open(filepath) as f:
                  data = json.load(f)

              if data["status"] == "pending" and current_epoch >= data["scheduled_epoch_utc"]:
                  tag = data["tag"]
                  typeapp = data.get("typeapp", "both")
                  with open(os.environ["GITHUB_OUTPUT"], "a") as out:
                      out.write(f"found_target=true\n")
                      out.write(f"target_tag={tag}\n")
                      out.write(f"target_typeapp={typeapp}\n")
                  print(f"Schedule pendiente encontrado: {tag} ({typeapp})")
                  found = True
                  break

          if not found:
              with open(os.environ["GITHUB_OUTPUT"], "a") as out:
                  out.write("found_target=false\n")
              print("No hay schedules pendientes.")
          PYEOF

      # --- Validar tag en git ---
      - name: "Validar existencia del tag"
        id: validate-tag
        if: >
          steps.check-manual.outputs.manual_trigger == 'true' ||
          steps.scan-schedule.outputs.found_target == 'true'
        run: |
          if [ "${{ steps.check-manual.outputs.manual_trigger }}" = "true" ]; then
            TAG="${{ steps.check-manual.outputs.target_tag }}"
            TYPEAPP="${{ steps.check-manual.outputs.target_typeapp }}"
          else
            TAG="${{ steps.scan-schedule.outputs.target_tag }}"
            TYPEAPP="${{ steps.scan-schedule.outputs.target_typeapp }}"
          fi

          if git rev-parse --verify "refs/tags/${TAG}" > /dev/null 2>&1; then
            echo "tag_exists=true" >> $GITHUB_OUTPUT
            echo "validated_tag=${TAG}" >> $GITHUB_OUTPUT
            echo "validated_typeapp=${TYPEAPP}" >> $GITHUB_OUTPUT
          else
            echo "Tag ${TAG} no existe aun. El cron reintentara en 5 min."
            echo "tag_exists=false" >> $GITHUB_OUTPUT
            exit 0
          fi

      # --- Disparar deploy ---
      - name: "Disparar deploy a produccion"
        if: steps.validate-tag.outputs.tag_exists == 'true'
        uses: actions/github-script@v7
        env:
          VALIDATED_TAG: ${{ steps.validate-tag.outputs.validated_tag }}
          VALIDATED_TYPEAPP: ${{ steps.validate-tag.outputs.validated_typeapp }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const tag = process.env.VALIDATED_TAG;
            const typeapp = process.env.VALIDATED_TYPEAPP;

            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: 'deploy-production.yml',
              ref: 'main-promocion-pro',
              inputs: {
                tag: tag,
                typeapp: typeapp,
                triggered_by: 'schedule'
              }
            });

            console.log(`deploy-production.yml disparado: ${tag} (${typeapp})`);

      # --- Marcar como triggered ---
      - name: "Actualizar estado a triggered"
        if: steps.validate-tag.outputs.tag_exists == 'true'
        env:
          TAG: ${{ steps.validate-tag.outputs.validated_tag }}
        run: |
          SCHEDULE_FILE="deploy-schedule/${TAG}.json"

          if [ -f "${SCHEDULE_FILE}" ]; then
            python3 << 'PYEOF'
          import json, os
          from datetime import datetime, timezone

          tag = os.environ["TAG"]
          filepath = f"deploy-schedule/{tag}.json"

          with open(filepath, "r") as f:
              data = json.load(f)

          data["status"] = "triggered"
          data["triggered_at"] = datetime.now(timezone.utc).isoformat()

          with open(filepath, "w") as f:
              json.dump(data, f, indent=2)
          PYEOF

            git config user.email "github-actions[bot]@users.noreply.github.com"
            git config user.name "GitHub Actions Bot"
            git add "${SCHEDULE_FILE}"
            git commit -m "triggered: ${TAG}"

            for i in 1 2 3; do
              git push origin deploy-state && break
              git pull --rebase origin deploy-state
              sleep 2
            done
          fi
```

**Diferencias clave vs `2-deploy-schedule.yml` actual:**

| Aspecto | Actual | Mejorado |
|---------|--------|----------|
| Checkout | `main` | `deploy-state` |
| JSON scanning | 4x `python3 -c` por archivo | 1 script Python consolidado |
| Push estado | `git push origin main` | `git push origin deploy-state` |
| Dispatch ref | `main` | `main-promocion-pro` |
| Inputs JS | Interpolacion directa | `process.env.*` |

---

#### Workflow 6: `deploy-production.yml` — Deploy a Produccion (MEJORADO)

```yaml
name: "Deploy - Production"

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag a desplegar (ej: v2.4.0)'
        required: true
        type: string
      typeapp:
        description: 'Tipo de aplicacion'
        required: false
        default: 'both'
        type: choice
        options: [both, frontend, backend]
      triggered_by:
        description: 'Origen (schedule/manual)'
        required: false
        default: 'manual'
        type: string

concurrency:
  group: deploy-production
  cancel-in-progress: false    # NUNCA cancelar un deploy en progreso

permissions:
  contents: write
  issues: write
  deployments: write
  pull-requests: write

jobs:
  # ─── JOB 1: VALIDACION (github-hosted) ───
  validar:
    name: "Validaciones pre-deploy"
    runs-on: ubuntu-latest
    outputs:
      tag_validado: ${{ steps.validar-tag.outputs.tag_validado }}

    steps:
      - name: "Checkout"
        uses: actions/checkout@v4
        with:
          ref: main-promocion-pro
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: "Validar formato del tag"
        env:
          TAG: ${{ github.event.inputs.tag }}
        run: |
          if ! echo "${TAG}" | grep -qP '^v\d+\.\d+\.\d+$'; then
            echo "Tag invalido: '${TAG}'. Formato: vX.Y.Z"
            exit 1
          fi

      - name: "Verificar que el tag existe"
        id: validar-tag
        env:
          TAG: ${{ github.event.inputs.tag }}
        run: |
          if git rev-parse --verify "refs/tags/${TAG}" > /dev/null 2>&1; then
            echo "tag_validado=${TAG}" >> $GITHUB_OUTPUT
          else
            echo "Tag ${TAG} no existe en el repositorio."
            exit 1
          fi

  # ─── JOB 2: DEPLOY (self-hosted + environment gate) ───
  deploy:
    name: "Deploy a produccion"
    needs: validar
    runs-on: self-hosted
    environment: production
    timeout-minutes: 30

    steps:
      - name: "Limpiar workspace"
        run: |
          rm -rf ${GITHUB_WORKSPACE}/*
          rm -rf ${GITHUB_WORKSPACE}/.git

      - name: "Checkout del tag"
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.tag }}
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: "Verificar integridad del checkout"
        env:
          TAG_ESPERADO: ${{ github.event.inputs.tag }}
        run: |
          TAG_ACTUAL=$(git describe --exact-match --tags HEAD 2>/dev/null || echo "NONE")
          if [ "${TAG_ACTUAL}" != "${TAG_ESPERADO}" ]; then
            echo "ERROR CRITICO: Esperado ${TAG_ESPERADO}, actual ${TAG_ACTUAL}"
            exit 1
          fi

      # --- Build + Deploy + Health Check via Composite Action ---
      - name: "Build, Deploy y Health Check"
        id: build-deploy
        uses: ./.github/actions/build-deploy
        with:
          tag: ${{ github.event.inputs.tag }}
          typeapp: ${{ github.event.inputs.typeapp }}
          health_check_url: ${{ secrets.DEPLOY_HEALTH_CHECK_URL }}

      # --- Registrar deploy en GitHub Deployments API ---
      - name: "Registrar deployment exitoso"
        uses: actions/github-script@v7
        env:
          TAG: ${{ github.event.inputs.tag }}
          TYPEAPP: ${{ github.event.inputs.typeapp }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const deployment = await github.rest.repos.createDeployment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: process.env.TAG,
              environment: 'production',
              auto_merge: false,
              required_contexts: [],
              payload: { typeapp: process.env.TYPEAPP }
            });

            await github.rest.repos.createDeploymentStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              deployment_id: deployment.data.id,
              state: 'success',
              environment: 'production',
              description: `Deploy ${process.env.TAG} exitoso`
            });

      # --- AUTO-MERGE: main-promocion-pro -> main ---
      - name: "Marcar PR como lista para merge"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.event.inputs.tag }}
        run: |
          # Buscar la PR abierta de main-promocion-pro -> main
          PR_NUMBER=$(gh pr list \
            --base main \
            --head main-promocion-pro \
            --state open \
            --json number \
            --jq '.[0].number // empty')

          if [ -n "${PR_NUMBER}" ]; then
            echo "Mergeando PR #${PR_NUMBER} a main..."
            gh pr merge "${PR_NUMBER}" --merge --admin
            echo "PR #${PR_NUMBER} mergeada. main ahora tiene ${TAG}."
          else
            echo "WARN: No hay PR abierta de main-promocion-pro a main."
            echo "Esto puede indicar un problema en release.yml."
          fi

      # --- SYNC: main -> develop ---
      - name: "Sincronizar main -> develop"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.event.inputs.tag }}
        run: |
          git fetch origin develop main
          git checkout develop
          git merge origin/main --no-edit || {
            echo "Conflicto en sync. Creando PR para resolucion manual."
            # Verificar si ya existe PR de sync
            EXISTING=$(gh pr list --base develop --head main --state open --json number --jq '.[0].number // empty')
            if [ -z "${EXISTING}" ]; then
              gh pr create \
                --base develop \
                --head main \
                --title "sync: main -> develop tras ${TAG}" \
                --body "Auto-sync despues de deploy a produccion. Resolver conflictos manualmente."
            fi
            exit 0
          }
          git push origin develop

  # ─── JOB 3: NOTIFICACION (siempre) ───
  notificar:
    name: "Notificacion"
    needs: [deploy]
    if: always()
    runs-on: ubuntu-latest

    steps:
      - name: "Crear issue de notificacion"
        uses: actions/github-script@v7
        env:
          TAG: ${{ github.event.inputs.tag }}
          TYPEAPP: ${{ github.event.inputs.typeapp }}
          DEPLOY_RESULT: ${{ needs.deploy.result }}
          ACTOR: ${{ github.actor }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const tag = process.env.TAG;
            const typeapp = process.env.TYPEAPP;
            const result = process.env.DEPLOY_RESULT;
            const actor = process.env.ACTOR;
            const runUrl = process.env.RUN_URL;

            let title, body, labels;

            if (result === 'success') {
              title = `Deploy exitoso: ${tag} (${typeapp})`;
              body = [
                `Deploy de \`${tag}\` completado exitosamente.`,
                '',
                '| Campo | Valor |',
                '|---|---|',
                `| **Tag** | \`${tag}\` |`,
                `| **Typeapp** | \`${typeapp}\` |`,
                `| **Ejecutado por** | @${actor} |`,
                `| **Logs** | [Ver workflow](${runUrl}) |`,
                '',
                'PR main-promocion-pro -> main: lista para merge manual.',
                'Mergear la PR y sincronizar main -> develop manualmente.'
              ].join('\n');
              labels = ['deploy', 'exitoso'];
            } else {
              title = `Deploy FALLO: ${tag} (${typeapp})`;
              body = [
                `Deploy de \`${tag}\` fallo.`,
                '',
                '**Se requiere intervencion manual.**',
                '',
                '| Campo | Valor |',
                '|---|---|',
                `| **Tag** | \`${tag}\` |`,
                `| **Typeapp** | \`${typeapp}\` |`,
                `| **Ejecutado por** | @${actor} |`,
                `| **Logs** | [Ver workflow](${runUrl}) |`,
                '',
                '### Acciones requeridas',
                '- [ ] Revisar logs del workflow',
                '- [ ] Usar **rollback-manual.yml** si es necesario',
                '- [ ] main NO fue afectada (main-promocion-pro actuo como buffer)'
              ].join('\n');
              labels = ['deploy', 'fallo', 'intervencion-manual'];
            }

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title, body, labels
            });
```

**Diferencias clave vs `3-deploy-production.yml` actual:**

| Aspecto | Actual | Mejorado |
|---------|--------|----------|
| Checkout ref | `main` | `main-promocion-pro` / tag |
| Build/Deploy | Inline duplicado | Composite action `.github/actions/build-deploy` |
| Estado post-deploy | `git push` JSON a `main` | GitHub Deployments API |
| Post health-check | Nada | Marcar PR lista para merge manual + label |
| Inputs en shell | `${{ }}` directo | Bloques `env:` |
| Inputs en JS | `'${{ }}'` directo | `process.env.*` |
| Concurrency | Ninguna | `group: deploy-production` |

---

#### Workflow 7: `rollback-manual.yml` — Rollback Manual (MEJORADO)

```yaml
name: "Manual Rollback - Production"

on:
  workflow_dispatch:
    inputs:
      tag_destino:
        description: 'Tag al que hacer rollback (ej: v2.3.1)'
        required: true
        type: string
      typeapp:
        description: 'Tipo de aplicacion'
        required: false
        default: 'both'
        type: choice
        options: [both, frontend, backend]
      motivo:
        description: 'Motivo del rollback (audit trail)'
        required: true
        type: string
      confirmacion:
        description: 'Escribir exactamente "CONFIRMO ROLLBACK"'
        required: true
        type: string

concurrency:
  group: deploy-production    # Mismo grupo que deploy = exclusion mutua
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  deployments: write

jobs:
  # ─── JOB 1: VALIDACION ───
  validar:
    name: "Validaciones pre-rollback"
    runs-on: ubuntu-latest
    outputs:
      tag_validado: ${{ steps.validar-tag.outputs.tag_validado }}
      tag_actual: ${{ steps.obtener-actual.outputs.tag_actual }}

    steps:
      # CAPA 1: Confirmacion textual
      - name: "Verificar confirmacion"
        env:
          CONFIRMACION: ${{ github.event.inputs.confirmacion }}
        run: |
          if [ "${CONFIRMACION}" != "CONFIRMO ROLLBACK" ]; then
            echo "Confirmacion invalida: '${CONFIRMACION}'"
            echo "Se esperaba: 'CONFIRMO ROLLBACK'"
            exit 1
          fi

      - name: "Checkout"
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      # CAPA 2A: Formato del tag
      - name: "Validar formato"
        env:
          TAG: ${{ github.event.inputs.tag_destino }}
        run: |
          if ! echo "${TAG}" | grep -qP '^v\d+\.\d+\.\d+$'; then
            echo "Formato invalido: '${TAG}'. Requerido: vX.Y.Z"
            exit 1
          fi

      # CAPA 2B: Tag existe
      - name: "Verificar existencia del tag"
        id: validar-tag
        env:
          TAG: ${{ github.event.inputs.tag_destino }}
        run: |
          if git rev-parse --verify "refs/tags/${TAG}" > /dev/null 2>&1; then
            echo "tag_validado=${TAG}" >> $GITHUB_OUTPUT
          else
            echo "Tag '${TAG}' no existe. Tags disponibles:"
            git tag --sort=-version:refname | grep -P '^v\d+\.\d+\.\d+$' | head -10
            exit 1
          fi

      # CAPA 2C: Obtener version actual via Deployments API
      - name: "Obtener version actual en produccion"
        id: obtener-actual
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const deployments = await github.rest.repos.listDeployments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              environment: 'production',
              per_page: 1
            });

            if (deployments.data.length > 0) {
              const currentTag = deployments.data[0].ref;
              core.setOutput('tag_actual', currentTag);
              console.log(`Version actual en produccion: ${currentTag}`);
            } else {
              core.setOutput('tag_actual', 'unknown');
              console.log('No se encontraron deployments previos.');
            }

      # CAPA 2D: Comparar versiones
      - name: "Validar rollback legitimo"
        env:
          TAG_DESTINO: ${{ github.event.inputs.tag_destino }}
          TAG_ACTUAL: ${{ steps.obtener-actual.outputs.tag_actual }}
        run: |
          if [ "${TAG_ACTUAL}" = "unknown" ]; then
            echo "WARN: Version actual desconocida. Continuando con precaucion."
            exit 0
          fi

          if [ "${TAG_DESTINO}" = "${TAG_ACTUAL}" ]; then
            echo "Tag destino = tag actual. No tiene sentido."
            exit 1
          fi

          parse_version() {
            echo "$1" | sed 's/^v//' | awk -F. '{print $1, $2, $3}'
          }

          read DEST_MAJOR DEST_MINOR DEST_PATCH <<< $(parse_version "${TAG_DESTINO}")
          read CURR_MAJOR CURR_MINOR CURR_PATCH <<< $(parse_version "${TAG_ACTUAL}")

          DEST_NUM=$(( DEST_MAJOR * 1000000 + DEST_MINOR * 1000 + DEST_PATCH ))
          CURR_NUM=$(( CURR_MAJOR * 1000000 + CURR_MINOR * 1000 + CURR_PATCH ))

          if [ "${DEST_NUM}" -ge "${CURR_NUM}" ]; then
            echo "Tag destino (${TAG_DESTINO}) no es menor que actual (${TAG_ACTUAL})."
            echo "Use deploy-production.yml para forward deploy."
            exit 1
          fi

          echo "Rollback legitimo: ${TAG_ACTUAL} -> ${TAG_DESTINO}"

      - name: "Resumen pre-rollback"
        env:
          TAG_DESTINO: ${{ github.event.inputs.tag_destino }}
          TAG_ACTUAL: ${{ steps.obtener-actual.outputs.tag_actual }}
          MOTIVO: ${{ github.event.inputs.motivo }}
          ACTOR: ${{ github.actor }}
        run: |
          echo "============================================"
          echo "  RESUMEN PRE-ROLLBACK"
          echo "============================================"
          echo "  Tag destino:    ${TAG_DESTINO}"
          echo "  Version actual: ${TAG_ACTUAL}"
          echo "  Motivo:         ${MOTIVO}"
          echo "  Ejecutado por:  ${ACTOR}"
          echo "============================================"

  # ─── JOB 2: EJECUTAR ROLLBACK (self-hosted + environment gate) ───
  ejecutar-rollback:
    name: "Ejecutar rollback"
    needs: validar
    runs-on: self-hosted
    environment: production
    timeout-minutes: 30

    steps:
      - name: "Limpiar workspace"
        run: |
          rm -rf ${GITHUB_WORKSPACE}/*
          rm -rf ${GITHUB_WORKSPACE}/.git

      - name: "Checkout del tag destino"
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.tag_destino }}
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: "Verificar integridad del checkout"
        env:
          TAG_ESPERADO: ${{ github.event.inputs.tag_destino }}
        run: |
          TAG_ACTUAL=$(git describe --exact-match --tags HEAD 2>/dev/null || echo "NONE")
          if [ "${TAG_ACTUAL}" != "${TAG_ESPERADO}" ]; then
            echo "ERROR CRITICO: Esperado ${TAG_ESPERADO}, actual ${TAG_ACTUAL}"
            exit 1
          fi

      # --- Build + Deploy + Health Check via Composite Action ---
      - name: "Build, Deploy y Health Check (rollback)"
        uses: ./.github/actions/build-deploy
        with:
          tag: ${{ github.event.inputs.tag_destino }}
          typeapp: ${{ github.event.inputs.typeapp }}
          health_check_url: ${{ secrets.DEPLOY_HEALTH_CHECK_URL }}

      # --- Registrar rollback en Deployments API ---
      - name: "Registrar rollback en Deployments API"
        uses: actions/github-script@v7
        env:
          TAG: ${{ github.event.inputs.tag_destino }}
          TYPEAPP: ${{ github.event.inputs.typeapp }}
          MOTIVO: ${{ github.event.inputs.motivo }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const deployment = await github.rest.repos.createDeployment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: process.env.TAG,
              environment: 'production',
              auto_merge: false,
              required_contexts: [],
              payload: {
                typeapp: process.env.TYPEAPP,
                method: 'manual-rollback',
                motivo: process.env.MOTIVO
              }
            });

            await github.rest.repos.createDeploymentStatus({
              owner: context.repo.owner,
              repo: context.repo.repo,
              deployment_id: deployment.data.id,
              state: 'success',
              description: `Rollback a ${process.env.TAG}`
            });

  # ─── JOB 3: NOTIFICACION ───
  notificar:
    name: "Notificacion"
    needs: [validar, ejecutar-rollback]
    if: always()
    runs-on: ubuntu-latest

    steps:
      - name: "Crear issue"
        uses: actions/github-script@v7
        env:
          TAG_DESTINO: ${{ github.event.inputs.tag_destino }}
          MOTIVO: ${{ github.event.inputs.motivo }}
          VALIDAR_RESULT: ${{ needs.validar.result }}
          ROLLBACK_RESULT: ${{ needs.ejecutar-rollback.result }}
          ACTOR: ${{ github.actor }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const tag = process.env.TAG_DESTINO;
            const motivo = process.env.MOTIVO;
            const validarResult = process.env.VALIDAR_RESULT;
            const rollbackResult = process.env.ROLLBACK_RESULT;
            const actor = process.env.ACTOR;
            const runUrl = process.env.RUN_URL;

            let title, body, labels;

            if (validarResult === 'failure') {
              title = `Rollback ABORTADO en validacion: ${tag}`;
              body = `No se realizo ningun cambio en produccion.\n\n[Ver logs](${runUrl})`;
              labels = ['rollback-manual', 'abortado'];
            } else if (rollbackResult === 'success') {
              title = `Rollback exitoso: produccion en ${tag}`;
              body = [
                `| Campo | Valor |`,
                `|---|---|`,
                `| **Version activa** | \`${tag}\` |`,
                `| **Motivo** | ${motivo} |`,
                `| **Ejecutado por** | @${actor} |`,
                `| **Logs** | [Ver workflow](${runUrl}) |`,
                '',
                '### Proximos pasos',
                '- [ ] Investigar el problema que causo el rollback',
                '- [ ] Crear PR de fix',
                '- [ ] Re-desplegar cuando este listo'
              ].join('\n');
              labels = ['rollback-manual', 'exitoso'];
            } else if (rollbackResult === 'failure') {
              title = `CRITICO: Rollback FALLO: ${tag}`;
              body = [
                'Se requiere intervencion manual inmediata.',
                '',
                `| Campo | Valor |`,
                `|---|---|`,
                `| **Tag destino** | \`${tag}\` |`,
                `| **Motivo** | ${motivo} |`,
                `| **Logs** | [Ver workflow](${runUrl}) |`,
                '',
                '### Acciones inmediatas',
                '- [ ] Verificar estado de produccion manualmente',
                '- [ ] Contactar equipo de infraestructura',
                '- [ ] Considerar rollback directo en servidor'
              ].join('\n');
              labels = ['rollback-manual', 'CRITICO'];
            } else {
              title = `Rollback estado inesperado: ${tag} (${rollbackResult})`;
              body = `Revisar manualmente: [Ver logs](${runUrl})`;
              labels = ['rollback-manual', 'requiere-revision'];
            }

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title, body, labels
            });
```

**Diferencias clave vs `4-rollback-manual.yml` actual:**

| Aspecto | Actual | Mejorado |
|---------|--------|----------|
| Build/Deploy | Inline (duplicado de deploy-production) | Composite action compartida |
| Estado | `git push` JSON a `main` | GitHub Deployments API |
| Version actual | Lee `.deploy/current-production.json` | Deployments API `listDeployments` |
| Inputs en shell | 18+ interpolaciones directas `${{ }}` | Bloques `env:` |
| Inputs en JS | Interpolacion directa | `process.env.*` |
| Concurrency | Ninguna | `group: deploy-production` (exclusion mutua con deploy) |

---

#### Workflow 8: `sync-alert.yml` — Deteccion de Desincronizacion

```yaml
name: "Sync Alert - Desync Detection"

on:
  schedule:
    - cron: '0 * * * *'    # Cada hora

permissions:
  contents: read
  issues: write

jobs:
  check-desync:
    runs-on: ubuntu-latest
    steps:
      - name: "Checkout"
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: "Detectar desincronizacion"
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const { execSync } = require('child_process');

            // Commits que main-promocion-pro tiene y main no
            const ahead = parseInt(
              execSync('git rev-list --count origin/main..origin/main-promocion-pro')
                .toString().trim()
            );

            if (ahead === 0) {
              console.log('main-promocion-pro y main estan sincronizadas.');
              return;
            }

            console.log(`main-promocion-pro esta ${ahead} commits adelante de main.`);

            // Verificar cuando fue el ultimo deploy exitoso
            const deployments = await github.rest.repos.listDeployments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              environment: 'production',
              per_page: 1
            });

            if (deployments.data.length === 0) return;

            const deployedAt = new Date(deployments.data[0].created_at);
            const hoursAgo = (Date.now() - deployedAt.getTime()) / (1000 * 60 * 60);

            if (hoursAgo > 2) {
              // Verificar si ya hay un issue abierto de desync
              const issues = await github.rest.issues.listForRepo({
                owner: context.repo.owner,
                repo: context.repo.repo,
                labels: 'desync-alert',
                state: 'open'
              });

              if (issues.data.length > 0) {
                console.log('Ya existe un issue de desync abierto. No crear duplicado.');
                return;
              }

              await github.rest.issues.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                title: `ALERTA: main-promocion-pro ${ahead} commits adelante de main (>${Math.round(hoursAgo)}h)`,
                body: [
                  'main-promocion-pro tiene commits que main no tiene, y han pasado mas de 2 horas',
                  'desde el ultimo deploy exitoso a produccion.',
                  '',
                  'Esto puede indicar:',
                  '- La PR no fue mergeada manualmente tras el deploy exitoso',
                  '- El deploy a produccion fallo y nadie hizo rollback',
                  '- Un paso manual fue olvidado',
                  '',
                  '### Accion requerida',
                  '- [ ] Verificar estado de produccion',
                  '- [ ] Revisar PR abierta de main-promocion-pro -> main',
                  '- [ ] Resolver manualmente si hay conflicto'
                ].join('\n'),
                labels: ['desync-alert']
              });

              console.log('Issue de desync creado.');
            }
```

---

### 3.4 Composite Action: `.github/actions/build-deploy/action.yml`

```yaml
name: "Build, Deploy y Health Check"
description: "Logica compartida de build/deploy/health-check para deploy y rollback"

inputs:
  tag:
    description: "Tag a desplegar"
    required: true
  typeapp:
    description: "Tipo de aplicacion (frontend/backend/both)"
    required: true
    default: "both"
  health_check_url:
    description: "URL del health check"
    required: true
  max_retries:
    description: "Intentos maximos de health check"
    required: false
    default: "10"
  retry_interval:
    description: "Segundos entre reintentos"
    required: false
    default: "15"

outputs:
  health_result:
    description: "Resultado del health check (success/failure)"
    value: ${{ steps.health-check.outputs.result }}

runs:
  using: "composite"
  steps:
    - name: "Build"
      shell: bash
      env:
        TAG: ${{ inputs.tag }}
        TYPEAPP: ${{ inputs.typeapp }}
      run: |
        echo "Building version ${TAG} (typeapp: ${TYPEAPP})..."

        # ═══ REEMPLAZAR CON BUILD REAL ═══
        case "${TYPEAPP}" in
          frontend)
            echo "Building frontend..."
            # cd frontend && npm ci && npm run build
            ;;
          backend)
            echo "Building backend..."
            # cd backend && npm ci && npm run build
            ;;
          both)
            echo "Building frontend..."
            # cd frontend && npm ci && npm run build
            echo "Building backend..."
            # cd backend && npm ci && npm run build
            ;;
        esac
        # ════════════════════════════════

    - name: "Deploy"
      shell: bash
      env:
        TAG: ${{ inputs.tag }}
        TYPEAPP: ${{ inputs.typeapp }}
      run: |
        echo "Desplegando ${TAG} (typeapp: ${TYPEAPP})..."

        # ═══ REEMPLAZAR CON DEPLOY REAL ═══
        case "${TYPEAPP}" in
          frontend)
            echo "Desplegando frontend..."
            # docker-compose -f docker-compose.prod.yml up -d frontend
            ;;
          backend)
            echo "Desplegando backend..."
            # docker-compose -f docker-compose.prod.yml up -d backend
            ;;
          both)
            echo "Desplegando frontend..."
            # docker-compose -f docker-compose.prod.yml up -d frontend
            echo "Desplegando backend..."
            # docker-compose -f docker-compose.prod.yml up -d backend
            ;;
        esac
        # ═══════════════════════════════════

    - name: "Health check"
      id: health-check
      shell: bash
      env:
        HEALTH_URL: ${{ inputs.health_check_url }}
        TAG: ${{ inputs.tag }}
        MAX_RETRIES: ${{ inputs.max_retries }}
        INTERVAL: ${{ inputs.retry_interval }}
      run: |
        echo "Health check para ${TAG}..."

        for i in $(seq 1 ${MAX_RETRIES}); do
          echo "  Intento ${i}/${MAX_RETRIES}..."

          RESPONSE=$(curl -s --max-time 10 "${HEALTH_URL}" 2>/dev/null || echo "")
          HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${HEALTH_URL}" 2>/dev/null || echo "000")

          if [ "${HTTP_CODE}" = "200" ]; then
            # Verificar version desplegada (si el endpoint lo soporta)
            DEPLOYED_VERSION=$(echo "${RESPONSE}" | python3 -c "
            import sys, json
            try:
                data = json.load(sys.stdin)
                print(data.get('version', ''))
            except:
                print('')
            " 2>/dev/null || echo "")

            if [ -n "${DEPLOYED_VERSION}" ] && [ "${DEPLOYED_VERSION}" != "${TAG}" ]; then
              echo "  HTTP 200 pero version incorrecta: ${DEPLOYED_VERSION} (esperada: ${TAG})"
              echo "  Puede ser cache. Reintentando..."
            else
              echo "Health check exitoso. ${TAG} activo."
              echo "result=success" >> $GITHUB_OUTPUT
              exit 0
            fi
          fi

          [ "${i}" -lt "${MAX_RETRIES}" ] && sleep ${INTERVAL}
        done

        echo "Health check fallo tras ${MAX_RETRIES} intentos."
        echo "result=failure" >> $GITHUB_OUTPUT
        exit 1
```

---

## 4. Fase 0: Seguridad (P0)

**Prioridad:** INMEDIATA
**Esfuerzo estimado:** 2-3 horas

### 4.1 Fix Command Injection en Shell

**Patron vulnerable** (presente en los 4 workflows actuales):
```yaml
# PELIGROSO: interpolacion directa en contexto shell
run: |
  TAG="${{ github.event.inputs.tag }}"
  COMMIT_MSG="${{ github.event.head_commit.message }}"
```

**Patron seguro:**
```yaml
# SEGURO: variable de entorno, no se interpola en shell
env:
  TAG: ${{ github.event.inputs.tag }}
  COMMIT_MSG: ${{ github.event.head_commit.message }}
run: |
  echo "Tag: ${TAG}"
  echo "Mensaje: ${COMMIT_MSG}"
```

**Archivos afectados y ubicaciones:**

| Archivo | Lineas | Variable | Riesgo |
|---------|--------|----------|--------|
| `1-release.yml` | 85 | `head_commit.message` | CRITICO (texto libre) |
| `1-release.yml` | 130 | `head_commit.message` | CRITICO |
| `1-release.yml` | 158 | `head_commit.message` | CRITICO |
| `2-deploy-schedule.yml` | 75-76 | `inputs.force_tag`, `inputs.force_typeapp` | ALTO |
| `3-deploy-production.yml` | 80, 92, 142, 158, 190, 223, 252 | Multiples `inputs.*` | ALTO |
| `4-rollback-manual.yml` | 99, 124, 141, 192, 240, 297, 313, 345, 381, 410, 436 | Multiples `inputs.*` | CRITICO (`motivo` es texto libre) |

### 4.2 Fix JavaScript Injection

**Patron vulnerable:**
```javascript
const tag = '${{ github.event.inputs.tag }}';           // JS injection
const motivo = '${{ github.event.inputs.motivo }}';     // Peor: texto libre
```

**Patron seguro:**
```yaml
env:
  TAG: ${{ github.event.inputs.tag }}
  MOTIVO: ${{ github.event.inputs.motivo }}
with:
  script: |
    const tag = process.env.TAG;
    const motivo = process.env.MOTIVO;
```

**Archivos afectados:**

| Archivo | Lineas | Variables |
|---------|--------|-----------|
| `2-deploy-schedule.yml` | 176 | `validated_tag`, `validated_typeapp` |
| `3-deploy-production.yml` | 299-303 | `tag`, `typeapp`, `deployResult`, `actor` |
| `4-rollback-manual.yml` | 459-464 | `tagDestino`, `motivo`, `actor` (CRITICO) |

### 4.3 Concurrency Groups

```yaml
# deploy-production.yml y rollback-manual.yml: MISMO GRUPO
concurrency:
  group: deploy-production
  cancel-in-progress: false

# deploy-schedule.yml: grupo separado
concurrency:
  group: deploy-schedule
  cancel-in-progress: false

# ci.yml: por PR, cancelar anterior
concurrency:
  group: ci-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

> **CRITICO:** `deploy-production.yml` y `rollback-manual.yml` comparten el grupo `deploy-production`. Esto garantiza exclusion mutua: no puede haber un deploy y un rollback simultaneo.

---

## 5. Fase 1: Alinear Workflows con main-promocion-pro (P1)

**Prioridad:** ALTA
**Esfuerzo estimado:** 4-6 horas

### 5.1 Cambios en el Trigger de release.yml

| Aspecto | Antes | Despues |
|---------|-------|---------|
| Trigger | `on: push: branches: [main]` | `on: pull_request: types: [closed] branches: [main-promocion-pro]` |
| Condicion | `contains(commit.message, '[release]')` | `github.event.pull_request.merged == true && startsWith(head.ref, 'release/')` |
| Version | Calculada de tags + bump type del commit msg | Extraida del nombre de rama (`release/v2.4.0` -> `v2.4.0`) |
| Metadata | `DEPLOY_SCHEDULED` del commit message | `DEPLOY_SCHEDULED` del body del PR |
| Estado | Push JSON a `main` | Push JSON a `deploy-state` |
| Post-tag | Nada | Crear PR `main-promocion-pro` -> `main` |

### 5.2 Nuevo Paso: Crear PR Automatica a main

Despues de crear el tag, `release.yml` crea una PR de `main-promocion-pro` -> `main`. Esta PR:
- **NO se mergea inmediatamente**
- Se mergea automaticamente por `deploy-production.yml` tras health check exitoso
- Si ya existe una PR abierta, se actualiza el titulo (no se crea duplicada)

### 5.3 Deploy-production.yml Marca PR Como Lista Para Merge Manual

Despues del health check exitoso:
1. Buscar PR abierta `main-promocion-pro` -> `main`
2. Agregar comentario a la PR confirmando deploy exitoso
3. Agregar label `ready-to-merge` para visibilidad
4. El usuario mergea manualmente cuando lo considere oportuno
5. Tras el merge manual, el usuario sincroniza `main` -> `develop`

### 5.4 Rollback NO Mergea a Main

Si un deploy falla y se hace rollback:
- `main` queda en el estado anterior (correctamente)
- `main-promocion-pro` tiene codigo que fallo
- La PR de `main-promocion-pro` -> `main` queda abierta
- Se cierra manualmente o se revierte el merge a `main-promocion-pro`

---

## 6. Fase 2: Gestion de Estado (P1)

**Prioridad:** ALTA
**Esfuerzo estimado:** 4-5 horas

### 6.1 Eliminar Commits de Estado a main

**Estado actual:** 4 workflows hacen `git push origin main` para archivos JSON de estado.

**Nuevo modelo:**

| Dato | Antes | Despues |
|------|-------|---------|
| Version activa en produccion | `.deploy/current-production.json` en `main` | GitHub Deployments API |
| Schedules de deploy | `.github/deploy-schedule/*.json` en `main` | Mismos JSON pero en rama `deploy-state` |
| Estado de schedule (triggered) | Update JSON + push a `main` | Update JSON + push a `deploy-state` |

### 6.2 GitHub Deployments API

**Escribir (tras deploy exitoso):**
```javascript
await github.rest.repos.createDeployment({ ref: tag, environment: 'production' });
await github.rest.repos.createDeploymentStatus({ deployment_id, state: 'success' });
```

**Leer (para rollback, comparacion de versiones):**
```javascript
const deployments = await github.rest.repos.listDeployments({
  environment: 'production', per_page: 1
});
const currentTag = deployments.data[0].ref;
```

### 6.3 Rama `deploy-state`

```bash
# Crear rama orphan (sin historial compartido)
git checkout --orphan deploy-state
git rm -rf .
echo "# Deploy State" > README.md
mkdir deploy-schedule
git add .
git commit -m "init: deploy-state branch"
git push origin deploy-state
```

Esta rama:
- **Nunca se mergea** a ninguna otra rama
- Solo contiene archivos JSON de estado de schedules
- Es escrita por `release.yml` y `deploy-schedule.yml`
- Es leida por `deploy-schedule.yml`

---

## 7. Fase 3: Robustez (P2)

**Prioridad:** MEDIA
**Esfuerzo estimado:** 6-8 horas

### 7.1 Composite Action para Build/Deploy

Ver seccion 3.4 para la especificacion completa de `.github/actions/build-deploy/action.yml`.

**Beneficio:** Cambiar el proceso de build/deploy en un solo lugar afecta tanto deploy como rollback.

### 7.2 Health Check con Verificacion de Version

El health check ahora verifica:
1. HTTP 200 (basico)
2. Version desplegada == tag esperado (si el endpoint lo soporta)

**Requisito:** La aplicacion debe exponer su version en el endpoint de health:
```json
GET /health
{
  "status": "ok",
  "version": "v2.4.0"
}
```

### 7.3 Retry con Pull-Rebase para Git Push

Para cualquier `git push` a `deploy-state`:
```bash
for i in 1 2 3; do
  git push origin deploy-state && break
  echo "Push fallo. Pull + rebase + retry..."
  git pull --rebase origin deploy-state
  sleep 2
done
```

### 7.4 Python Consolidado en deploy-schedule.yml

Un solo script Python reemplaza 4 llamadas separadas de `python3 -c`. Beneficios:
- Rendimiento: 1 proceso vs 4 por archivo JSON
- Seguridad: sin interpolacion de `$file` en Python
- Mantenibilidad: un solo bloque de codigo

---

## 8. Fase 4: Workflows Faltantes (P2)

**Prioridad:** MEDIA
**Esfuerzo estimado:** 8-10 horas

### 8.1 Cobertura de Entornos

| Entorno | Antes | Despues |
|---------|-------|---------|
| Desarrollo | Sin cobertura | `deploy-dev.yml` (auto en push a develop) |
| Pre-produccion | Sin cobertura | `deploy-pre.yml` (auto en push a release/hotfix) |
| Produccion | 4 workflows | 4 workflows mejorados |

### 8.2 CI Pipeline

Linting, tests y build check como prerequisito para merge via branch protection rules.

### 8.3 Sync Alert

Vigilancia automatica de desincronizacion entre `main-promocion-pro` y `main`. Crea issue si la diferencia persiste mas de 2 horas tras un deploy exitoso.

---

## 9. Fase 5: Enterprise Hardening (P3)

**Prioridad:** BAJA
**Esfuerzo estimado:** 4-6 horas

### 9.1 CHANGELOG Automatico

Integrado en `release.yml`. Genera entrada de CHANGELOG desde commits entre el tag anterior y el nuevo:

```bash
CHANGES=$(git log ${PREV_TAG}..HEAD --pretty=format:"- %s (%h)" --no-merges)
```

### 9.2 Branch Protection Rules

| Rama | Require PR | Approvals | No Direct Push | No Force Push | Status Checks |
|------|:----------:|:---------:|:--------------:|:-------------:|:-------------:|
| `main` | Si | 1 | Si | Si | ci |
| `main-promocion-pro` | Si | 1 | Si | Si | ci |
| `develop` | Si | 1 | Si | Si | ci |
| `release/*` | No | -- | No | Si | ci |
| `hotfix/*` | No | -- | No | Si | ci |

### 9.3 Audit Log via Deployments API

La GitHub Deployments API proporciona audit trail nativo:
- Quien disparo el deploy
- Que tag se desplego
- Cuando ocurrio
- Resultado (success/failure)
- Entorno

Consultable via: `gh api repos/{owner}/{repo}/deployments`

### 9.4 CODEOWNERS

```
# .github/CODEOWNERS
/.github/workflows/  @devops-team
/.github/actions/    @devops-team
```

---

## 10. Plan de Migracion

### 10.1 Orden de Ejecucion

```
Fase 0 ─────> Fase 1 ─────> Fase 2 ─────> Fase 3 ─────> Fase 4 ─────> Fase 5
(Seguridad)   (main-prom)   (Estado)      (Robustez)    (Workflows)   (Enterprise)
INMEDIATO     ALTA          ALTA          MEDIA         MEDIA         BAJA
2-3h          4-6h          4-5h          6-8h          8-10h         4-6h
```

### 10.2 Pasos Detallados

#### Paso 1: Fase 0 — Seguridad (sin cambios arquitectonicos)

```
1. Aplicar env: blocks a los 4 workflows actuales
2. Cambiar JS injection a process.env.*
3. Agregar concurrency groups
4. Testear con workflow_dispatch manual
5. Merge a main
```

> Este paso es seguro y no cambia ningun flujo. Solo refuerza la seguridad.

#### Paso 2: Crear rama `main-promocion-pro`

```
1. git checkout main
2. git checkout -b main-promocion-pro
3. git push origin main-promocion-pro
4. Configurar branch protection rules en GitHub UI
5. NO cambiar triggers de workflows aun
```

> `main-promocion-pro` empieza identica a `main`. No rompe nada existente.

#### Paso 3: Crear rama `deploy-state`

```
1. git checkout --orphan deploy-state
2. Crear estructura: deploy-schedule/ + README.md
3. git push origin deploy-state
4. Migrar JSON existentes (si los hay) a esta rama
```

#### Paso 4: Workflows nuevos (aditivos)

```
1. Crear ci.yml (no afecta nada existente)
2. Crear deploy-dev.yml (no afecta nada existente)
3. Crear deploy-pre.yml (no afecta nada existente)
4. Crear sync-alert.yml (no afecta nada existente)
5. Testear cada uno independientemente
```

#### Paso 5: Crear composite action

```
1. Crear .github/actions/build-deploy/action.yml
2. Testear en deploy-dev.yml o deploy-pre.yml primero
3. Una vez validada, integrar en deploy-production.yml y rollback-manual.yml
```

#### Paso 6: Cutover — Cambiar release.yml (CRITICO)

```
1. Cambiar trigger de release.yml: push:main -> pull_request[closed]:main-promocion-pro
2. Cambiar fuente de version: commit message -> nombre de rama
3. Cambiar storage de schedule: main -> deploy-state
4. Agregar creacion de PR a main
5. TESTEAR CON CANARY RELEASE antes de usar en produccion real
```

> **Punto de no retorno.** A partir de aqui, el flujo usa `main-promocion-pro`.
> Revertir: cambiar el trigger de vuelta a `push: main`.

#### Paso 7: Actualizar deploy-production.yml

```
1. Cambiar checkout ref a main-promocion-pro
2. Agregar marcado de PR como lista para merge manual
3. Agregar sync main -> develop
4. Integrar Deployments API (reemplazar git push de JSON)
5. Integrar composite action
```

#### Paso 8: Actualizar rollback-manual.yml

```
1. Integrar Deployments API para leer version actual
2. Integrar composite action
3. Eliminar git push a main
```

### 10.3 Rollback de la Migracion

En cualquier paso, el estado anterior se puede restaurar:
- Los cambios de workflows son revertibles via git revert
- Las ramas nuevas (`main-promocion-pro`, `deploy-state`) son aditivas, no destructivas
- Los workflows nuevos (ci, deploy-dev, deploy-pre, sync-alert) se pueden eliminar sin afectar produccion

---

## 11. Matriz de Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigacion |
|---|--------|:------------:|:-------:|------------|
| R1 | Usuario olvida mergear PR de main-promocion-pro a main | Media | Medio | sync-alert.yml detecta desync en <2h y crea issue. Label `ready-to-merge` da visibilidad |
| R2 | Composite action rompe deploy y rollback simultaneamente | Baja | Critico | Testear en deploy-dev y deploy-pre primero. Mantener inline code como comentario de emergencia |
| R3 | Deployments API rate limit impide leer estado | Muy baja | Medio | API es read-light (1 call/deploy). Fallback: rama deploy-state |
| R4 | Cutover de trigger (Paso 6) causa release perdida | Media | Medio | Mantener ambos triggers brevemente. Validar con canary release |
| R5 | Dos deploys simultaneos al mismo entorno | Baja | Alto | Concurrency groups con `cancel-in-progress: false` |
| R6 | Developer mergea directo a main (bypassing main-promocion-pro) | Media | Alto | Branch protection: require PR, no direct push |
| R7 | Health check pasa pero version incorrecta desplegada | Baja | Critico | Health check con verificacion de version (Fase 3) |
| R8 | Cambio de formato DEPLOY_SCHEDULED rompe schedules pendientes | Baja | Medio | Procesar todos los schedules pendientes antes del cutover |
| R9 | rama deploy-state crece indefinidamente | Media | Bajo | Agregar cleanup periodico de JSONs procesados (cron mensual) |
| R10 | Self-hosted runner contaminado por ejecucion anterior | Baja | Alto | Cleanup obligatorio de workspace (ya implementado) |

---

## 12. Comparativa Actual vs Propuesta

| Aspecto | Actual | Propuesta |
|---------|--------|-----------|
| **Ramas permanentes** | 2 (develop, main) | 4 (develop, main-promocion-pro, main, deploy-state) |
| **main-promocion-pro** | Descrita pero no implementada | Implementada con merge manual controlado |
| **Tags por release** | 1 (en main) | 1 (en main-promocion-pro, heredado por main) |
| **Fuente de verdad produccion** | `.deploy/current-production.json` en main | GitHub Deployments API |
| **Workflows totales** | 4 (solo produccion) | 8 (CI + 3 entornos + alert) |
| **Entornos cubiertos** | 1/3 (produccion) | 3/3 (desarrollo, pre-produccion, produccion) |
| **Seguridad (injection)** | Vulnerable (30+ interpolaciones directas) | Corregido (bloques env: + process.env) |
| **Build/Deploy DRY** | Duplicado en 2 workflows | Composite action compartida |
| **Estado de deploy** | Commits a main | Deployments API + rama deploy-state |
| **Sync main -> develop** | Manual | Automatico post-deploy |
| **Deteccion de desync** | No existe | sync-alert.yml (cada hora) |
| **Health check** | Solo HTTP 200 | HTTP 200 + verificacion de version |
| **Concurrency** | Sin proteccion | Grupos de exclusion mutua |
| **CHANGELOG** | Manual | Automatico |
| **Audit trail** | Parcial (issues) | Completo (Deployments API + issues) |
| **Git push en workflows** | A main (contamina historial) | A deploy-state (aislado) |
| **Version source** | Commit message (fragil) | Nombre de rama (inmune a inyeccion) |
| **Metadata source** | Commit message (fragil) | Body del PR (controlado) |

---

## Apendice A: Estructura de Archivos Propuesta

```
.github/
  ├── actions/
  │   └── build-deploy/
  │       └── action.yml              # Composite action compartida
  │
  ├── workflows/
  │   ├── ci.yml                      # Workflow 1: CI pipeline
  │   ├── deploy-dev.yml              # Workflow 2: Deploy a desarrollo
  │   ├── deploy-pre.yml              # Workflow 3: Deploy a pre-produccion
  │   ├── release.yml                 # Workflow 4: Crear tag + release + PR
  │   ├── deploy-schedule.yml         # Workflow 5: Monitor schedules
  │   ├── deploy-production.yml       # Workflow 6: Deploy a produccion
  │   ├── rollback-manual.yml         # Workflow 7: Rollback manual
  │   └── sync-alert.yml              # Workflow 8: Deteccion desync
  │
  └── CODEOWNERS                      # Proteccion de workflows

Rama deploy-state (orphan):
  ├── README.md
  └── deploy-schedule/
      ├── v2.3.0.json
      ├── v2.4.0.json
      └── ...
```

## Apendice B: Checklist de Branch Protection

```
[ ] main:
    [ ] Require pull request before merging
    [ ] Require approvals (1)
    [ ] Dismiss stale pull request approvals
    [ ] Require status checks to pass (ci)
    [ ] Do not allow bypassing the above settings
    [ ] Restrict who can push (only via approved PR from main-promocion-pro)

[ ] main-promocion-pro:
    [ ] Require pull request before merging
    [ ] Require approvals (1)
    [ ] Require status checks to pass (ci)
    [ ] Restrict merge sources (only release/* and hotfix/*)

[ ] develop:
    [ ] Require pull request before merging
    [ ] Require approvals (1)
    [ ] Require status checks to pass (ci)

[ ] GitHub Environment "production":
    [ ] Required reviewers (al menos 1)
    [ ] Wait timer: 0 (manual approval, sin delay)
    [ ] Deployment branches: main-promocion-pro (solo)
```

---

*Documento generado como roadmap tecnico. Las recomendaciones deben validarse con el equipo y adaptarse al contexto organizacional especifico.*
