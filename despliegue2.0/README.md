# Production Deployment System

Sistema de despliegue a producción con GitHub Actions, environments con aprobación obligatoria y runners self-hosted on-premise. Incluye versionado semántico automático, deploy programado, y rollback automático y manual.

---

## Contenido

- [Arquitectura](#arquitectura)
- [Workflows](#workflows)
- [Configuración inicial](#configuración-inicial)
- [Secrets y variables](#secrets-y-variables)
- [Estructura de archivos del repo](#estructura-de-archivos-del-repo)
- [Versionado semántico](#versionado-semántico)
- [Cómo crear un release](#cómo-crear-un-release)
- [Cómo hacer rollback manual](#cómo-hacer-rollback-manual)
- [Rollback automático vs manual](#rollback-automático-vs-manual)
- [Labels de issues](#labels-de-issues)
- [Riesgos conocidos y mitigaciones](#riesgos-conocidos-y-mitigaciones)
- [FAQ](#faq)

---

## Arquitectura

El sistema está compuesto por 4 workflows. Cada uno tiene una única responsabilidad. La única comunicación entre workflows es un archivo JSON en el repo y la API de GitHub para disparar workflows.

```
PR merge → main
    │
    ▼
┌─────────────────────┐
│   1. release.yml    │  → Crea tag vX.Y.Z
│   github-hosted     │  → Crea archivo de schedule
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. deploy-schedule  │  → Cron cada 5 min
│    .yml             │  → Espera la hora programada
│   github-hosted     │  → Dispara deploy-production via API
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  3. deploy-         │  → Checkout del tag exacto
│     production.yml  │  → Build + Deploy
│   self-hosted       │  → Health check
│                     │  → Rollback AUTO si falla
└──────────┬──────────┘
           │
     ┌─────┴──────┐
     ▼            ▼
  Exitoso     Falla → Rollback AUTO
                          │
                    ┌─────┴──────┐
                    ▼            ▼
                 Exitoso     Falla → Alerta crítica
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  4. rollback-manual  │
                              │     .yml             │
                              │   self-hosted        │
                              │   (intervención      │
                              │    humana)           │
                              └─────────────────────┘
```

`rollback-manual.yml` también se puede disparar directamente en cualquier momento, no solo cuando el rollback automático falla. Se usa para cualquier situación que requiera revertir a una versión conocida.

---

## Workflows

| # | Archivo | Trigger | Runner | Responsabilidad |
|---|---------|---------|--------|-----------------|
| 1 | `release.yml` | `push` a `main` | `github-hosted` | Crear tag semántico y archivo de schedule |
| 2 | `deploy-schedule.yml` | `cron */5 * * * *` + `workflow_dispatch` | `github-hosted` | Vigilar la hora y disparar el deploy |
| 3 | `deploy-production.yml` | `workflow_dispatch` | `self-hosted` (deploy y rollback) | Deploy real, health check, rollback automático |
| 4 | `rollback-manual.yml` | `workflow_dispatch` | `self-hosted` (ejecución) | Rollback manual independiente |

### Permisos por workflow

| Workflow | `contents` | `actions` | `issues` | `deployments` |
|----------|:----------:|:---------:|:--------:|:-------------:|
| `release.yml` | `write` | — | — | — |
| `deploy-schedule.yml` | `read` | `write` | — | — |
| `deploy-production.yml` | `write` | — | `write` | `write` |
| `rollback-manual.yml` | `write` | — | `write` | `write` |

### Runners por job

Solo los jobs que necesitan acceder a la infraestructura on-premise usan `self-hosted`. El resto corre en `github-hosted` para minimizar el tiempo de ocupación del runner.

| Workflow | Job | Runner |
|----------|-----|--------|
| `release.yml` | `create-tag` | `github-hosted` |
| `deploy-schedule.yml` | `check-schedule` | `github-hosted` |
| `deploy-production.yml` | `validar` | `github-hosted` |
| `deploy-production.yml` | `deploy` | `self-hosted` |
| `deploy-production.yml` | `rollback` | `self-hosted` |
| `deploy-production.yml` | `notificar` | `github-hosted` |
| `rollback-manual.yml` | `validar` | `github-hosted` |
| `rollback-manual.yml` | `ejecutar-rollback` | `self-hosted` |
| `rollback-manual.yml` | `notificar` | `github-hosted` |

---

## Configuración inicial

### 1. GitHub Environment

Crear el environment `production` desde la UI de GitHub:

```
Settings → Environments → New environment

Nombre: production

Protection Rules:
  ✓ Required reviewers    → seleccionar al menos 1 persona del equipo
  ○ Wait timer            → 0 minutos (el wait lo maneja el cron)

Deployment branches:
  ✓ Solo permitir desde: main
```

Los secrets de esta sección solo son accesibles por jobs que declaren `environment: production`. Esto aplica a los jobs `deploy` y `ejecutar-rollback` de los workflows 3 y 4.

### 2. Runner self-hosted

El runner debe estar conectado al repositorio y tener acceso de red a los servidores de producción.

```
Settings → Actions → Runners → New self-hosted runner

Instalar según el SO del servidor on-premise.
Etiquetar el runner con: self-hosted
```

### 3. Labels de issues

Crear estos labels en el repositorio antes de usar el sistema, para que las notificaciones funcionen sin errores:

```
deploy
exitoso
fallo
rollback-auto
rollback-manual
abortado
requiere-revision
intervención-manual
CRÍTICO
```

### 4. Directorio `.deploy`

Crear el directorio en el repo raíz con un `.gitkeep`:

```
.deploy/
  .gitkeep
```

El archivo `current-production.json` se crea automáticamente tras el primer deploy exitoso.

---

## Secrets y variables

Todos los secrets se configuran en el environment `production` (no en el repositorio general), excepto `GITHUB_TOKEN` que es automático.

| Secret | Descripción | Ejemplo |
|--------|-------------|---------|
| `DEPLOY_HEALTH_CHECK_URL` | URL que retorna HTTP 200 cuando la app está sana | `https://api.produccion.com/health` |

El `GITHUB_TOKEN` es proporcionado automáticamente por GitHub Actions en cada ejecución. No se configura manualmente.

Si tu mecanismo de deploy requiere acceso SSH o credenciales adicionales (ej: registro de Docker, kubeconfig), agrégalos como secrets adicionales en el environment `production` y referencíalos en los steps de deploy y rollback.

---

## Estructura de archivos del repo

Estos archivos son creados y gestionados automáticamente por los workflows. No los edites manualmente.

```
.github/
  workflows/
    release.yml                          # Workflow 1
    deploy-schedule.yml                  # Workflow 2
    deploy-production.yml                # Workflow 3
    rollback-manual.yml                  # Workflow 4
  deploy-schedule/
    v1.0.0.json                          # Creado por release.yml tras cada merge
    v1.1.0.json                          # Uno por cada versión
    ...

.deploy/
  current-production.json                # Fuente de verdad: qué versión está activa
```

### `.github/deploy-schedule/vX.Y.Z.json`

Creado por `release.yml`. Leído por `deploy-schedule.yml`.

```json
{
  "tag": "v2.4.0",
  "scheduled_date_original": "2026-02-10T22:00:00+01:00",
  "scheduled_epoch_utc": 1739228400,
  "status": "pending",
  "created_at": "2026-02-10T10:00:00Z"
}
```

El campo `status` pasa de `pending` a `triggered` cuando el cron dispara el deploy. Una vez en `triggered`, el cron lo ignora en las siguientes iteraciones.

### `.deploy/current-production.json`

Escrito por `deploy-production.yml` tras un deploy exitoso, y por `rollback-manual.yml` tras un rollback exitoso. Es la única forma en que los workflows comparten estado.

```json
{
  "tag": "v2.4.0",
  "deployed_at": "2026-02-10T21:00:00+00:00",
  "deployed_by": "username",
  "method": "deploy",
  "workflow_run_id": "12345678",
  "triggered_by": "schedule"
}
```

El campo `method` puede ser `deploy` o `manual-rollback`, según qué workflow lo escribió.

---

## Versionado semántico

El sistema usa Semantic Versioning estricto con formato `vX.Y.Z`.

| Campo | Significa | Ejemplo |
|-------|-----------|---------|
| `X` (Major) | Breaking changes | API incompatible con versión anterior |
| `Y` (Minor) | Nuevas funcionalidades | Nuevo endpoint, nueva feature |
| `Z` (Patch) | Bugfixes | Corrección de un error |

### Cómo se calcula el bump

El bump se determina automáticamente leyendo el mensaje del commit de merge. El orden de prioridad es `major > minor > patch`.

| Contenido en el mensaje del PR | Bump | Ejemplo |
|-------------------------------|------|---------|
| `[major]` | Major | `v2.3.1` → `v3.0.0` |
| `[minor]` | Minor | `v2.3.1` → `v2.4.0` |
| `[patch]` o ninguno | Patch | `v2.3.1` → `v2.3.2` |

Si el mensaje no contiene ninguna marca, el default es `patch`. Es el más seguro como fallback.

---

## Cómo crear un release

Este es el flujo completo desde el punto de vista del desarrollador.

### Paso 1: Crear la branch de release

```bash
git checkout develop
git pull origin develop
git checkout -b release/v2.4.0
```

### Paso 2: Hacer los cambios y abrir el PR

Crear un Pull Request de `release/v2.4.0` hacia `main`. En la descripción del PR incluir dos cosas obligatorias.

La marca de tipo de cambio (una de las tres):

```
[release] [minor] Se agrega nuevo endpoint de exportación
```

La fecha y hora de deploy programado en formato ISO 8601 con timezone:

```
DEPLOY_SCHEDULED: 2026-02-10T22:00:00+01:00
```

Ejemplo completo de descripción del PR:

```
[release] [minor] Se agrega nuevo endpoint de exportación

DEPLOY_SCHEDULED: 2026-02-10T22:00:00+01:00

- Nuevo endpoint GET /api/export
- Soporta formatos CSV y XLSX
- Tests unitarios y de integración incluidos
```

> **Nota sobre timezones:** GitHub Actions opera en UTC. El sistema convierte automáticamente la fecha que escribas (con cualquier timezone válido) a UTC internamente. Si escribes `22:00:00+01:00` (Madrid), el sistema lo convierte a `21:00:00Z` (UTC).

### Paso 3: Aprobar y hacer merge

El PR debe recibir la aprobación requerida por las reglas del repositorio. Al hacer merge a `main`, el sistema se activa automáticamente:

1. `release.yml` detecta el push a `main`, lee `[release]` en el mensaje, crea el tag `v2.4.0` y el archivo de schedule.
2. `deploy-schedule.yml` escanea cada 5 minutos. Cuando la hora actual alcanza la hora programada, dispara `deploy-production.yml`.
3. `deploy-production.yml` hace checkout del tag `v2.4.0` en el runner self-hosted, ejecuta build, deploy, y health check.

No hay nada más que hacer. El sistema maneja el resto.

---

## Cómo hacer rollback manual

### Cuándo usar rollback manual

- El rollback automático falló (la notificación en GitHub lo indica con label `CRÍTICO`).
- Se detectó un bug después de un deploy exitoso y se necesita revertir.
- Intervención de emergencia fuera de horario.

### Pasos

Ir a `Actions → Manual Rollback - Production → Run workflow` y rellenar los campos:

| Campo | Ejemplo | Requerido |
|-------|---------|:---------:|
| `tag_destino` | `v2.3.1` | ✓ |
| `motivo` | `Bug crítico en v2.4.0 que afecta checkout` | ✓ |
| `confirmación` | `CONFIRMO ROLLBACK` | ✓ |

El campo `confirmación` debe contener exactamente el texto `CONFIRMO ROLLBACK`. Es un filtro deliberado contra ejecuciones accidentales. Si no coincide exactamente, el workflow se detiene en el primer paso sin ejecutar nada.

Tras rellenar los campos y dar a `Run workflow`, el sistema ejecuta las validaciones automáticamente. Si todas pasan, el workflow se pausa esperando la aprobación del environment `production`. Un miembro del equipo debe aprobar desde la UI de GitHub antes de que el rollback se ejecute en el runner.

### Tres capas de protección

El rollback manual tiene tres capas de seguridad independientes, aplicadas en orden:

```
Capa 1: Confirmación textual
  → El usuario debe escribir "CONFIRMO ROLLBACK" exactamente.
  → Si no coincide, el workflow muere. Nada se ejecuta.

Capa 2: Validaciones automáticas
  → Formato del tag (regex vX.Y.Z estricto)
  → Existencia del tag en git
  → El tag destino no es igual al que está activo
  → El tag destino es menor versión que el activo (es un rollback real)
  → Si cualquier validación falla, el workflow muere.

Capa 3: Aprobación del environment
  → El workflow se pausa hasta que un reviewer apruebe desde GitHub
  → El reviewer ve el resumen de todas las validaciones antes de aprobar
  → El runner self-hosted no se ocupa hasta que hay aprobación
```

---

## Rollback automático vs manual

| Aspecto | Automático | Manual |
|---------|-----------|--------|
| Workflow | Dentro de `deploy-production.yml` (job `rollback`) | `rollback-manual.yml` (workflow independiente) |
| Se activa | Automáticamente cuando el health check del deploy falla | Manualmente por un operador |
| Requiere aprobación | No (ya fue aprobado cuando se aprobó el deploy) | Sí (environment `production`) |
| Versión destino | Calculada automáticamente (tag anterior) | Especificada por el operador |
| Comparte estado con otros workflows | Sí (parte de deploy-production) | No (completamente independiente) |
| Confirmación textual | No | Sí (`CONFIRMO ROLLBACK`) |

Ambos tipos de rollback usan exactamente el mismo mecanismo de deploy y los mismos parámetros de health check: 10 reintentos cada 15 segundos. Si cambias cómo se deploya en uno, debe cambiarse en el otro.

---

## Labels de issues

El sistema crea issues automáticamente como notificación de cada evento. Estos son los labels que se usan y qué significan:

| Labels | Situación | Acción requerida |
|--------|-----------|------------------|
| `deploy`, `exitoso` | Deploy completado sin problemas | Ninguna |
| `deploy`, `rollback-auto`, `requiere-revision` | Deploy falló, rollback automático exitoso | Investigar qué falló |
| `deploy`, `rollback-auto`, `CRÍTICO` | Deploy falló y rollback automático también falló | Usar `rollback-manual.yml` inmediatamente |
| `deploy`, `fallo`, `intervención-manual` | Deploy falló, no hay versión anterior | Intervención manual |
| `rollback-manual`, `exitoso` | Rollback manual completado | Investigar causa original |
| `rollback-manual`, `abortado` | Rollback manual abortado en validación | Revisar los logs |
| `rollback-manual`, `CRÍTICO` | Rollback manual falló | Intervenir directamente en el servidor |
| `rollback-manual`, `requiere-revision` | Estado inesperado | Revisar manualmente |

---

## Riesgos conocidos y mitigaciones

### Race condition entre merge y creación de tag

Si hay latencia entre el merge a `main` y la creación del tag por `release.yml`, el cron de `deploy-schedule` puede buscar un tag que aún no existe.

**Mitigación:** `deploy-schedule.yml` verifica la existencia del tag con `git rev-parse` antes de disparar el deploy. Si no existe, no dispara y el cron reintenta en 5 minutos. No falla el workflow.

### Self-hosted runner con estado sucio

Los runners self-hosted mantienen el estado entre ejecuciones. Código o artefactos de un deploy anterior pueden contaminar el siguiente.

**Mitigación:** Cada job que corre en self-hosted hace `rm -rf` del workspace como primer paso, antes de cualquier checkout.

### Secrets expuestos en logs

Los runners self-hosted tienen mayor riesgo de leak de secrets que los github-hosted.

**Mitigación:** Los secrets se configuran en el environment `production`, no en el repositorio general. Solo son accesibles por jobs que declaren ese environment. Ningún workflow printea variables de entorno en los logs.

### Timezone incorrecto en DEPLOY_SCHEDULED

GitHub Actions opera en UTC. Un desarrollador puede programar una hora sin notar el offset del timezone.

**Mitigación:** El formato requerido es ISO 8601 con timezone explícito (`2026-02-10T22:00:00+01:00`). El workflow valida que sea un formato válido y lo convierte a UTC epoch internamente. Si el formato es inválido, el workflow falla con mensaje claro.

### Deploy y rollback usan mecanismos diferentes

Si el deploy usa docker-compose y el rollback usa otro método, el rollback puede no funcionar correctamente.

**Mitigación:** Los comentarios en el código de los tres places donde hay deploy (deploy-production job `deploy`, deploy-production job `rollback`, rollback-manual job `ejecutar-rollback`) indican explícitamente que deben usar el mismo mecanismo. Busca los comentarios marcados con `═══ REEMPLAZAR ═══`.

### Rollback manual disparado por error

Un click accidental en "Run workflow" puede iniciar un rollback a producción.

**Mitigación:** Tres capas de protección independientes (confirmación textual, validaciones automáticas, aprobación del environment). Las tres deben pasar para que algo se ejecute en el runner.

---

## FAQ

**¿Qué pasa si el cron de deploy-schedule no se ejecuta exactamente a la hora programada?**

GitHub no garantiza precisión al segundo en los cron de schedule. En la práctica la latencia es de segundos a unos minutos. Como el cron corre cada 5 minutos, la latencia máxima es de aproximadamente 5 minutos. Para deploys programados en producción esto es aceptable.

**¿Qué pasa si hay dos merges rápidos a main antes de que el primer deploy se ejecute?**

Cada merge crea un tag y un archivo de schedule independiente. El cron de deploy-schedule procesa los archivos en orden FIFO (el más antiguo primero). En la práctica no debería haber más de un deploy pendiente a la vez, pero el sistema lo maneja correctamente si ocurre.

**¿Puedo desplegar una versión específica sin esperar al cron?**

Sí. `deploy-schedule.yml` tiene un `workflow_dispatch` con un campo `force_tag`. Introduci el tag y el workflow dispara el deploy inmediatamente, sin esperar al cron.

**¿Qué pasa si es la primera versión (v1.0.0) y el deploy falla?**

No existe versión anterior para rollback automático. El rollback automático se marca como no disponible y se crea una alerta crítica. Se debe usar `rollback-manual.yml` o intervenir directamente en el servidor.

**¿Puedo hacer rollback a una versión que no es la inmediatamente anterior?**

Sí, pero solo con `rollback-manual.yml`. El rollback automático siempre va al tag inmediatamente anterior. El rollback manual permite especificar cualquier tag que exista en el repositorio, siempre que sea menor versión que la activa.

**¿Qué archivo debo editar para cambiar el mecanismo de deploy?**

Hay tres places donde está el deploy: el job `deploy` y el job `rollback` de `deploy-production.yml`, y el job `ejecutar-rollback` de `rollback-manual.yml`. Los tres deben usar exactamente el mismo mecanismo. Busca los comentarios marcados con `═══ REEMPLAZAR ═══` en cada archivo.

**¿Quién puede aprobar deploys y rollbacks?**

Cualquier persona que esté configurada como "Required reviewer" en el environment `production` de GitHub. Esto se configura en `Settings → Environments → production → Protection Rules`.
