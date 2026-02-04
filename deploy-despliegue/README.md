# 🚀 Production Deployment System

Sistema profesional de despliegue a producción con GitHub Actions, environments con aprobación obligatoria y runners self-hosted on-premise.

**Características principales:**
- ✅ Versionado semántico automático (SemVer)
- ⏰ Deploy programado con fecha y hora específica
- 🔄 Rollback automático ante fallos
- 🔙 **Rollback manual independiente con triple protección**
- 🏥 Health checks automáticos
- 📋 Notificaciones automáticas vía GitHub Issues
- 🔐 Aprobación obligatoria para producción

---

## 📚 Contenido

### Inicio rápido
- [Arquitectura general](#arquitectura-general)
- [Configuración inicial](#configuración-inicial)
- [Guía para desarrolladores: Crear un release](#guía-para-desarrolladores-crear-un-release)

### Operaciones críticas
- [🔙 **Rollback manual** (IMPORTANTE)](#-rollback-manual)
- [Rollback automático vs manual](#rollback-automático-vs-manual)
- [Troubleshooting](#troubleshooting)

### Referencia técnica
- [Workflows en detalle](#workflows-en-detalle)
- [Secrets y variables](#secrets-y-variables)
- [Estructura de archivos](#estructura-de-archivos-del-repo)
- [Versionado semántico](#versionado-semántico)
- [Labels de issues](#labels-de-issues)
- [Riesgos y mitigaciones](#riesgos-conocidos-y-mitigaciones)
- [FAQ](#faq)

---

## 🏗️ Arquitectura general

El sistema está compuesto por **4 workflows independientes**. Cada uno tiene una única responsabilidad. La comunicación entre workflows es explícita: archivo JSON en el repo + API de GitHub.

```
┌─────────────────────────────────────────────────────────────────┐
│                        FLUJO NORMAL                              │
└─────────────────────────────────────────────────────────────────┘

PR merge → main (con [release] y DEPLOY_SCHEDULED)
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. RELEASE.YML                            Runner: github-hosted  │
│ ─────────────────────────────────────────────────────────────── │
│ • Lee [major], [minor], o [patch] del PR                        │
│ • Crea tag semántico vX.Y.Z                                     │
│ • Extrae DEPLOY_SCHEDULED del PR                                │
│ • Crea archivo .github/deploy-schedule/vX.Y.Z.json              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. DEPLOY-SCHEDULE.YML                    Runner: github-hosted  │
│ ─────────────────────────────────────────────────────────────── │
│ • Cron cada 5 minutos                                           │
│ • Lee archivos de schedule                                      │
│ • Compara hora actual vs hora programada                        │
│ • Si hora >= programada → dispara deploy-production via API     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. DEPLOY-PRODUCTION.YML                  Runner: self-hosted   │
│ ─────────────────────────────────────────────────────────────── │
│ • Validaciones (github-hosted, rápido)                          │
│ • Checkout del tag exacto en self-hosted                        │
│ • Build de la aplicación                                        │
│ • Deploy a producción                                           │
│ • Health check (10 reintentos × 15s)                            │
│ • Si exitoso → actualiza .deploy/current-production.json        │
│ • Si falla → ROLLBACK AUTOMÁTICO ↓                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                   ┌─────────┴──────────┐
                   ▼                    ▼
             ✅ EXITOSO            ❌ FALLA
                                        │
                                        ▼
                         ┌──────────────────────────┐
                         │ ROLLBACK AUTOMÁTICO      │
                         │ (dentro del mismo        │
                         │  workflow)               │
                         └─────────┬────────────────┘
                                   │
                         ┌─────────┴─────────┐
                         ▼                   ▼
                    ✅ EXITOSO          ❌ FALLA
                                            │
                                            ▼
                                   🚨 ALERTA CRÍTICA
                                   Requiere intervención
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. ROLLBACK-MANUAL.YML                    Runner: self-hosted   │
│ ─────────────────────────────────────────────────────────────── │
│ • Workflow INDEPENDIENTE (no comparte estado)                   │
│ • Se dispara manualmente desde GitHub UI                        │
│ • Triple protección (ver sección dedicada)                      │
│ • Permite rollback a cualquier versión anterior                 │
└─────────────────────────────────────────────────────────────────┘

NOTA: rollback-manual.yml también se puede usar en cualquier momento,
      no solo cuando el automático falla. Ejemplo: bug detectado
      horas después de un deploy exitoso.
```

---

## ⚙️ Configuración inicial

### 1. GitHub Environment `production`

```
Ruta: Settings → Environments → New environment

┌──────────────────────────────────────────────────────┐
│ Environment name: production                          │
├──────────────────────────────────────────────────────┤
│                                                       │
│ ✓ Environment protection rules:                      │
│   ✓ Required reviewers                               │
│     → Seleccionar al menos 1 persona del equipo      │
│     → Recomendado: 2 personas del equipo DevOps      │
│                                                       │
│   ○ Wait timer: 0 minutes                            │
│     (el tiempo de espera lo maneja el cron)          │
│                                                       │
│ ✓ Deployment branches:                               │
│   ✓ Selected branches                                │
│     → main                                           │
│                                                       │
│ Secrets (accesibles solo desde este environment):   │
│   → DEPLOY_HEALTH_CHECK_URL                          │
│   → [otros secrets según tu mecanismo de deploy]     │
└──────────────────────────────────────────────────────┘
```

### 2. Runner self-hosted

```bash
# En tu servidor on-premise:

# 1. Ir a Settings → Actions → Runners → New self-hosted runner
# 2. Seguir las instrucciones según tu SO
# 3. Al configurar, usar esta etiqueta:

./config.sh --labels self-hosted

# 4. Iniciar el runner
./run.sh

# 5. Verificar que aparece "Idle" en GitHub UI
```

**Requisitos del runner:**
- Acceso de red a servidores de producción
- Herramientas instaladas según tu stack (docker, kubectl, npm, etc.)
- Permisos para ejecutar el mecanismo de deploy

### 3. Labels de GitHub Issues

Crear estos labels para las notificaciones automáticas:

| Label | Color | Uso |
|-------|-------|-----|
| `deploy` | `#0052CC` | Todos los eventos de deploy |
| `exitoso` | `#00875A` | Deploy/rollback exitoso |
| `fallo` | `#DE350B` | Deploy/rollback falló |
| `rollback-auto` | `#FF991F` | Rollback automático |
| `rollback-manual` | `#6554C0` | Rollback manual |
| `abortado` | `#97A0AF` | Abortado en validación |
| `requiere-revision` | `#FFAB00` | Requiere investigación |
| `intervención-manual` | `#FF5630` | Requiere acción humana |
| `CRÍTICO` | `#BF2600` | Estado crítico del sistema |

### 4. Estructura de directorios

```bash
# Crear estos directorios en el repo raíz:
mkdir -p .github/deploy-schedule
mkdir -p .deploy

# Agregar .gitkeep para commitear directorios vacíos:
touch .github/deploy-schedule/.gitkeep
touch .deploy/.gitkeep

git add .github/deploy-schedule/.gitkeep .deploy/.gitkeep
git commit -m "chore: crear estructura para deploy system"
git push origin main
```

---

## 👨‍💻 Guía para desarrolladores: Crear un release

### Paso 1: Crear la branch de release

```bash
git checkout develop
git pull origin develop
git checkout -b release/v2.4.0
```

### Paso 2: Preparar el PR

Abrir un Pull Request de `release/v2.4.0` hacia `main`.

**Descripción del PR (incluir AMBOS campos):**

```markdown
[release] [minor] Se agrega nuevo endpoint de exportación

DEPLOY_SCHEDULED: 2026-02-10T22:00:00+01:00

## Cambios incluidos
- ✨ Nuevo endpoint GET /api/export
- 📝 Soporta formatos CSV y XLSX
- ✅ Tests incluidos
```

**Campos obligatorios:**

1. **Marca de tipo**: `[major]`, `[minor]`, `[patch]` o ninguno (default: patch)
2. **Fecha y hora**: `DEPLOY_SCHEDULED: YYYY-MM-DDTHH:MM:SS±HH:MM`

### Paso 3: Aprobar y hacer merge

Al hacer merge a `main` → el sistema se activa automáticamente.

---

## 🔙 Rollback manual

### 🚨 Cuándo usar

- ❌ Deploy falló y rollback automático también falló (CRÍTICO)
- 🐛 Bug detectado horas después de un deploy exitoso
- ⚠️ Problema de performance en producción
- 🔥 Emergencia fuera de horario

### 🛡️ Triple sistema de protección

```
┌─────────────────────────────────────────────────────────────┐
│ CAPA 1: CONFIRMACIÓN TEXTUAL                                │
├─────────────────────────────────────────────────────────────┤
│ El operador debe escribir exactamente:                       │
│     CONFIRMO ROLLBACK                                        │
│ ❌ Si NO coincide → workflow muere                           │
│ ✅ Si coincide → continúa a Capa 2                           │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ CAPA 2: VALIDACIONES AUTOMÁTICAS                            │
├─────────────────────────────────────────────────────────────┤
│ ✓ Formato del tag (vX.Y.Z)                                  │
│ ✓ El tag existe en git                                      │
│ ✓ Tag destino ≠ versión actual                              │
│ ✓ Tag destino < versión actual                              │
│ ❌ Si CUALQUIERA falla → workflow muere                      │
│ ✅ Si TODAS pasan → continúa a Capa 3                        │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ CAPA 3: APROBACIÓN HUMANA                                   │
├─────────────────────────────────────────────────────────────┤
│ El workflow PAUSA y espera aprobación.                       │
│ El reviewer ve:                                              │
│   • Tag destino                                             │
│   • Versión actual                                          │
│   • Motivo                                                  │
│   • Resumen de validaciones                                 │
│ ❌ Si rechaza → workflow muere                              │
│ ✅ Si aprueba → ejecución en self-hosted                     │
└─────────────────────────────────────────────────────────────┘
```

### 📋 Pasos para ejecutar

#### 1. Ir a GitHub Actions

```
GitHub → Tu repo → Actions → "Manual Rollback - Production" → "Run workflow"
```

#### 2. Rellenar formulario

| Campo | Ejemplo | Obligatorio |
|-------|---------|:-----------:|
| `tag_destino` | `v2.3.1` | ✅ |
| `motivo` | `Bug crítico en checkout` | ✅ |
| `confirmacion` | `CONFIRMO ROLLBACK` | ✅ |

#### 3. Validaciones automáticas

El sistema valida automáticamente (1-2 min).

#### 4. Aprobar

Solo para reviewers autorizados. El workflow se pausa y muestra resumen completo antes de ejecutar.

#### 5. Ejecución

Tras aprobación (5-10 min):
- Checkout del tag destino
- Build
- Deploy
- Health check
- Actualización de `.deploy/current-production.json`
- Issue de notificación

### 📊 Resultado

**Si exitoso ✅:**
- Issue: "✅ Rollback manual exitoso: producción ahora en v2.3.1"
- Labels: `rollback-manual`, `exitoso`

**Si falla ❌:**
- Issue: "🚨 CRÍTICO: Rollback manual FALLÓ"
- Labels: `rollback-manual`, `CRÍTICO`
- Requiere intervención directa en servidor

### 💡 Casos de uso

**Caso 1: Bug crítico**
```
23:00 - Bug detectado
23:03 - Inicia rollback manual a v2.3.1
23:05 - Aprobación
23:10 - Rollback completado ✅
```

**Caso 2: Rollback automático falló**
```
22:05 - Deploy falla
22:06 - Rollback automático falla ❌
22:08 - Issue crítico creado
22:10 - Inicia rollback manual
22:15 - Rollback manual exitoso ✅
```

---

## 🔄 Rollback automático vs manual

| Aspecto | Automático | Manual |
|---------|-----------|--------|
| **Workflow** | Dentro de deploy-production.yml | rollback-manual.yml independiente |
| **Trigger** | Automático (health check falla) | Manual desde GitHub UI |
| **Versión** | Tag anterior automático | Especificada por operador |
| **Aprobación** | No (ya aprobado en deploy) | Sí (environment production) |
| **Confirmación** | No | Sí (CONFIRMO ROLLBACK) |
| **Tiempo** | ~3-5 min | ~5-10 min |

**Ambos usan:**
- ✅ Mismo mecanismo de deploy
- ✅ Mismo health check (10 × 15s)
- ✅ Mismo runner (self-hosted)

---

## 📁 Workflows en detalle

| # | Workflow | Trigger | Runner | Timeout |
|---|----------|---------|--------|---------|
| 1 | release.yml | push → main | github-hosted | — |
| 2 | deploy-schedule.yml | cron */5 * * * * | github-hosted | — |
| 3 | deploy-production.yml | workflow_dispatch | mixed | 30 min |
| 4 | rollback-manual.yml | workflow_dispatch | mixed | 30 min |

---

## 🔐 Secrets y variables

### Secrets en environment `production`

| Secret | Descripción | Ejemplo |
|--------|-------------|---------|
| `DEPLOY_HEALTH_CHECK_URL` | URL health check | `https://api.prod.com/health` |
| `GITHUB_TOKEN` | Automático | (proporcionado por GitHub) |

Agregar según tu stack: `DOCKER_*`, `KUBECONFIG_*`, `AWS_*`, `SSH_*`, etc.

---

## 📂 Estructura de archivos del repo

```
.github/
  workflows/
    release.yml
    deploy-schedule.yml
    deploy-production.yml
    rollback-manual.yml
  deploy-schedule/
    v1.0.0.json
    v1.1.0.json
    ...

.deploy/
  current-production.json
```

### `.github/deploy-schedule/vX.Y.Z.json`

```json
{
  "tag": "v2.4.0",
  "scheduled_date_original": "2026-02-10T22:00:00+01:00",
  "scheduled_epoch_utc": 1739228400,
  "status": "pending",
  "created_at": "2026-02-10T10:00:00Z"
}
```

### `.deploy/current-production.json`

```json
{
  "tag": "v2.4.0",
  "deployed_at": "2026-02-10T21:00:00+00:00",
  "deployed_by": "username",
  "method": "deploy",
  "workflow_run_id": "12345678"
}
```

---

## 🏷️ Versionado semántico

```
vX.Y.Z

X = Major → Breaking changes
Y = Minor → Nuevas features
Z = Patch → Bugfixes
```

| Marca | Bump | Ejemplo |
|-------|------|---------|
| `[major]` | v2.3.1 → v3.0.0 | Breaking |
| `[minor]` | v2.3.1 → v2.4.0 | Features |
| `[patch]` | v2.3.1 → v2.3.2 | Fixes |
| (ninguno) | v2.3.1 → v2.3.2 | Default |

---

## 🏷️ Labels de issues

| Labels | Situación | Acción |
|--------|-----------|--------|
| `deploy`, `exitoso` | Deploy OK | Ninguna |
| `deploy`, `rollback-auto`, `requiere-revision` | Deploy falló, rollback OK | Investigar |
| `deploy`, `rollback-auto`, `CRÍTICO` | Ambos fallaron | Rollback manual YA |
| `rollback-manual`, `exitoso` | Rollback manual OK | Investigar causa |
| `rollback-manual`, `CRÍTICO` | Rollback manual falló | Intervención servidor |

---

## ⚠️ Riesgos conocidos y mitigaciones

### 1. Race condition tag

**Mitigación:** deploy-schedule verifica existencia antes de disparar.

### 2. Runner con estado sucio

**Mitigación:** `rm -rf workspace` antes de cada checkout.

### 3. Secrets expuestos

**Mitigación:** Secrets en environment production, no en logs.

### 4. Timezone incorrecto

**Mitigación:** ISO 8601 obligatorio con timezone, conversión automática.

### 5. Mecanismos diferentes

**Mitigación:** Comentarios explícitos (`═══ REEMPLAZAR ═══`) en 3 lugares.

### 6. Rollback accidental

**Mitigación:** Triple capa de protección.

---

## 🛠️ Troubleshooting

### Cron no dispara

1. Verificar archivo schedule existe
2. Verificar `status: pending`
3. Ver runs de deploy-schedule
4. Usar fallback manual: `force_tag`

### Rollback falla en validaciones

| Error | Causa | Solución |
|-------|-------|----------|
| Confirmación inválida | Texto no coincide | Escribir exactamente |
| Formato inválido | No es vX.Y.Z | Corregir formato |
| Tag no existe | No está en git | Ver `git tag -l` |
| Es igual al actual | Misma versión | Elegir otra |
| No es menor | Es forward deploy | Elegir versión anterior |

### Health check falla siempre

1. Verificar secret `DEPLOY_HEALTH_CHECK_URL`
2. Verificar conectividad desde runner
3. Verificar endpoint `/health` existe y retorna 200

### Runner offline

```bash
cd ~/actions-runner
./svc.sh stop
./svc.sh start
./svc.sh status
```

---

## ❓ FAQ

**¿Qué pasa si el cron no es exacto?**  
Latencia de segundos a minutos. Con cron cada 5 min, máximo ~5 min de retraso. Aceptable para prod.

**¿Dos merges rápidos?**  
Ambos se procesan en orden FIFO.

**¿Desplegar sin esperar?**  
Sí: `deploy-schedule.yml` → Run workflow → `force_tag: v2.4.0`

**¿Primera versión sin anterior?**  
Rollback automático crea alerta. Usar rollback manual con otra estrategia.

**¿Rollback a versión no-inmediata?**  
Sí, con rollback manual.

**¿Dónde cambio mecanismo deploy?**  
3 lugares (buscar `═══ REEMPLAZAR ═══`):
1. deploy-production → job deploy
2. deploy-production → job rollback
3. rollback-manual → job ejecutar-rollback

**¿Quién puede aprobar?**  
Required reviewers del environment production.

**¿Cambiar frecuencia cron?**  
Editar `deploy-schedule.yml` → `cron: '*/10 * * * *'`

---

**Última actualización:** 2026-02-03  
**Mantenido por:** DevOps Team
