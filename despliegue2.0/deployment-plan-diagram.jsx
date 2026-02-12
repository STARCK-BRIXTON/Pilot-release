import { useState } from "react";

// ─── TEMA ─────────────────────────────────────────────────────────
const T = {
  bg: "#090b10",
  surface: "#111419",
  surfaceHi: "#161a24",
  border: "#1e2330",
  borderHi: "#2a3040",
  text: "#b8bcc8",
  textDim: "#535866",
  textBright: "#eef0f4",

  // Workflows
  release: "#38bdf8",        // azul cielo
  releaseDim: "rgba(56,189,248,0.12)",
  schedule: "#a78bfa",       // violeta
  scheduleDim: "rgba(167,139,250,0.12)",
  deploy: "#34d399",         // verde esmeralda
  deployDim: "rgba(52,211,153,0.12)",
  rollbackAuto: "#fb923c",   // naranja
  rollbackAutoDim: "rgba(251,146,60,0.12)",
  rollbackManual: "#f472b6", // rosa
  rollbackManualDim: "rgba(244,114,182,0.12)",

  // Estados
  ok: "#34d399",
  okDim: "rgba(52,211,153,0.14)",
  fail: "#f87171",
  failDim: "rgba(248,113,113,0.14)",
  warn: "#fbbf24",
  warnDim: "rgba(251,191,36,0.14)",
  critical: "#ef4444",
  criticalDim: "rgba(239,68,68,0.18)",
};

// ─── DATOS ────────────────────────────────────────────────────────
const WORKFLOWS = [
  {
    id: "release",
    label: "release.yml",
    color: T.release,
    dim: T.releaseDim,
    icon: "🏷️",
    trigger: "push → main",
    runner: "github-hosted",
    desc: "Crea el tag semántico vX.Y.Z tras merge. No toca infraestructura.",
    steps: [
      { title: "Checkout (fetch-depth: 0)", why: "Sin historial completo no puede ver tags anteriores para calcular la versión." },
      { title: "Obtener último tag", why: "git describe --tags --abbrev=0. Si no existe ningún tag, usa v0.0.0 como base." },
      { title: "Calcular bump (major/minor/patch)", why: "Lee labels del PR en el mensaje de merge. Major > Minor > Patch. Default: patch (más seguro)." },
      { title: "Crear tag anotado", why: "Los tags anotados almacenan metadata (quién, cuándo). git describe los prefiere. Estándar de industria." },
      { title: "Extraer DEPLOY_SCHEDULED del commit", why: "El developer lo incluye en el PR. Formato ISO 8601 con timezone. Se valida y convierte a UTC." },
      { title: "Crear .github/deploy-schedule/vX.Y.Z.json", why: "El 'ticket de trabajo' para el cron. Comunicación explícita entre workflows via archivo en el repo." },
    ],
  },
  {
    id: "schedule",
    label: "deploy-schedule.yml",
    color: T.schedule,
    dim: T.scheduleDim,
    icon: "⏰",
    trigger: "cron */5 * * * * + workflow_dispatch",
    runner: "github-hosted",
    desc: "El 'reloj' del sistema. Escanea JSONs cada 5 min. Solo dispara, no deploya.",
    steps: [
      { title: "Checkout del repo", why: "Necesita leer los archivos de schedule. fetch-depth: 0 para ver tags." },
      { title: "¿Dispatch manual con tag forzado?", why: "Fallback de emergencia. Un admin puede desplegar sin esperar el cron." },
      { title: "Escanear schedules pendientes", why: "Loop sobre *.json en deploy-schedule/. Compara epoch actual vs epoch programado. FIFO si hay varios." },
      { title: "Validar existencia del tag en git", why: "Previene Race Condition: si el tag aún no existe por latencia, no dispara. El cron reintentará en 5 min." },
      { title: "Disparar deploy-production.yml via API", why: "workflow_dispatch via API permite pasar inputs (tag). Más flexible que workflow_call para workflows desacoplados." },
      { title: "Actualizar JSON a 'triggered'", why: "Previene que el cron dispare de nuevo la misma versión en la siguiente iteración." },
    ],
  },
  {
    id: "deploy",
    label: "deploy-production.yml",
    color: T.deploy,
    dim: T.deployDim,
    icon: "🚀",
    trigger: "workflow_dispatch (llamado por schedule o manual)",
    runner: "self-hosted 🖥️",
    desc: "El deploy real. Checkout del tag exacto, build, deploy, health check. Incluye rollback automático si falla.",
    steps: [
      { title: "[Job: validar] Formato + existencia del tag", why: "Corre en github-hosted. Si falla, el self-hosted nunca se ocupa. Principio de menor privilegio." },
      { title: "[Job: validar] Calcular tag anterior para rollback", why: "Si patch > 0, resta 1. Si patch = 0, busca el tag real anterior con git tag --sort. Verifica que existe." },
      { title: "[Job: deploy] Clean workspace", why: "Obligatorio en self-hosted. Sin esto, estado de ejecuciones anteriores puede contaminar el deploy." },
      { title: "[Job: deploy] Checkout exacto del tag (detached HEAD)", why: "ref: tag específico. Determinista: siempre el mismo código para el mismo tag." },
      { title: "[Job: deploy] Verificar checkout con git describe", why: "Nunca asumas que checkout funcionó. En producción crítica, este check puede evitar un desastre." },
      { title: "[Job: deploy] Build + Deploy", why: "El mecanismo de deploy debe ser el mismo que usa el rollback. No mezcles métodos." },
      { title: "[Job: deploy] Health Check (10 reintentos × 15s)", why: "El deploy no es 'exitoso' hasta que la app responde HTTP 200. Sin esto es un deploy ciego." },
      { title: "[Job: deploy] Actualizar .deploy/current-production.json", why: "Fuente de verdad de qué versión está activa. La lee rollback-manual para comparar versiones." },
      { title: "[Job: rollback] Solo si deploy falla (if: failure())", why: "Job separado por visibilidad en la UI y porque un step que falla detiene los siguientes." },
      { title: "[Job: rollback] Checkout del tag anterior + Deploy + Health Check", why: "Mismo mecanismo de deploy. Si este rollback también falla, se crea alerta crítica." },
      { title: "[Job: notify] Crear issue según resultado", why: "if: always(). Un solo lugar. Cubre: exitoso, rollback auto exitoso, rollback auto falló." },
    ],
  },
  {
    id: "rollback-manual",
    label: "rollback-manual.yml",
    color: T.rollbackManual,
    dim: T.rollbackManualDim,
    icon: "🔙",
    trigger: "workflow_dispatch (manual, desde la UI)",
    runner: "self-hosted 🖥️ (solo tras aprobación)",
    desc: "Rollback manual independiente. No comparte estado con otros workflows. Para emergencias o cuando el rollback automático falla.",
    steps: [
      { title: "[Job: validar] Verificar confirmación textual", why: "'CONFIRMO ROLLBACK' exacto. Un checkbox no es suficiente protección contra ejecuciones accidentales." },
      { title: "[Job: validar] Checkout (fetch-depth: 0) + validar formato regex", why: "vX.Y.Z estricto. Sin historial completo no puede ver otros tags para la comparación." },
      { title: "[Job: validar] Verificar que el tag existe en git", why: "Si no existe, muestra los últimos 10 tags disponibles para ayudar al operador." },
      { title: "[Job: validar] Leer .deploy/current-production.json", why: "Fuente de verdad compartida. Si no existe el archivo, permite continuar con warning (el environment approval es el último filtro)." },
      { title: "[Job: validar] Comparar versiones numéricamente", why: "Peso: Major×10⁶ + Minor×10³ + Patch. Verifica destino < actual. Previene forward-deploy disfrazado." },
      { title: "[Job: ejecutar] PAUSA — environment: production", why: "El workflow se detiene aquí hasta aprobación. El self-hosted runner aún no está ocupado. El reviewer ve el resumen completo." },
      { title: "[Job: ejecutar] Clean + Checkout exacto del tag destino", why: "El runner on-premise solo se activa DESPUÉS de la aprobación. Workspace limpio = estado determinista." },
      { title: "[Job: ejecutar] Verificar checkout con git describe", why: "Doble verificación. En rollback manual, un error aquí puede desplegar la versión incorrecta." },
      { title: "[Job: ejecutar] Build + Deploy (mismo mecanismo que deploy-production)", why: "Si uno usa docker-compose, el otro DEBE usar docker-compose. Consistencia es crítica." },
      { title: "[Job: ejecutar] Health Check (10 reintentos × 15s)", why: "Si falla, el job falla y la notificación marca como CRÍTICO con acciones requeridas." },
      { title: "[Job: ejecutar] Actualizar .deploy/current-production.json", why: "Mantiene la fuente de verdad en sync. El próximo rollback-manual leerá esta versión como 'actual'." },
      { title: "[Job: notificar] Issue según resultado (exitoso / falló / abortado)", why: "if: always(). Cubre todos los estados incluyendo aborto en validación." },
    ],
  },
];

// ─── COMPONENTES ──────────────────────────────────────────────────

function Badge({ color, children, small }) {
  return (
    <span style={{
      display: "inline-block",
      background: color + "18",
      border: `1px solid ${color}40`,
      color: color,
      fontSize: small ? 9 : 10,
      fontWeight: 700,
      letterSpacing: "0.07em",
      textTransform: "uppercase",
      padding: small ? "1px 6px" : "2px 8px",
      borderRadius: 4,
    }}>{children}</span>
  );
}

function Arrow({ color, label }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "2px 0" }}>
      {label && <span style={{ fontSize: 9, color: color, opacity: 0.7, letterSpacing: "0.04em" }}>{label}</span>}
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M10 2 L10 15" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M5 11 L10 16 L15 11" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    </div>
  );
}

function BranchArrow({ color, label, direction = "down" }) {
  // Flecha diagonal para rollback-manual (rama independiente)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0 2px 32px" }}>
      <svg width="40" height="30" viewBox="0 0 40 30" fill="none">
        <path d="M2 2 L2 20 L35 20" stroke={color} strokeWidth="1.5" strokeDasharray="4 3" strokeLinecap="round"/>
        <path d="M31 16 L36 20 L31 24" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
      {label && <span style={{ fontSize: 9, color: color, opacity: 0.8 }}>{label}</span>}
    </div>
  );
}

// ─── VISTA: ARQUITECTURA (mapa visual de los 4 workflows) ────────
function ArchitectureView() {
  const wfBox = (wf, style = {}) => (
    <div style={{
      background: wf.dim,
      border: `1px solid ${wf.color}35`,
      borderRadius: 8,
      padding: "10px 14px",
      textAlign: "center",
      minWidth: 130,
      ...style,
    }}>
      <div style={{ fontSize: 18, marginBottom: 2 }}>{wf.icon}</div>
      <div style={{ color: wf.color, fontSize: 11, fontWeight: 700 }}>{wf.label}</div>
      <div style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{wf.runner}</div>
    </div>
  );

  const release = WORKFLOWS[0];
  const schedule = WORKFLOWS[1];
  const deploy = WORKFLOWS[2];
  const rollbackManual = WORKFLOWS[3];

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
      {/* Fila superior: flujo principal */}
      <div style={{ color: T.textDim, fontSize: 10, marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Flujo principal (automático)
      </div>

      {/* main merge */}
      <div style={{
        background: T.surfaceHi,
        border: `1px solid ${T.borderHi}`,
        borderRadius: 6,
        padding: "6px 14px",
        color: T.textBright,
        fontSize: 11,
        fontWeight: 600,
      }}>
        📥 PR merge → <code style={{ color: T.release }}>main</code>
      </div>
      <Arrow color={T.release} />

      {wfBox(release)}
      <Arrow color={T.schedule} label="crea tag" />

      {wfBox(schedule)}
      <Arrow color={T.deploy} label="hora alcanzada → dispara" />

      {wfBox(deploy)}

      {/* Bifurcación: health OK vs health FAIL */}
      <div style={{ display: "flex", gap: 0, marginTop: 4, position: "relative", width: "100%", maxWidth: 380, justifyContent: "center" }}>
        {/* Línea horizontal divisora */}
        <div style={{ position: "absolute", top: 14, left: "25%", right: "25%", height: 1, background: T.borderHi }} />

        {/* Rama izquierda: OK */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
          <Arrow color={T.ok} />
          <div style={{
            background: T.okDim,
            border: `1px solid ${T.ok}40`,
            borderRadius: 6,
            padding: "5px 12px",
            color: T.ok,
            fontSize: 10,
            fontWeight: 600,
          }}>✅ Deploy exitoso</div>
        </div>

        {/* Rama derecha: FAIL → rollback auto */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
          <Arrow color={T.fail} />
          <div style={{
            background: T.failDim,
            border: `1px solid ${T.fail}40`,
            borderRadius: 6,
            padding: "5px 12px",
            color: T.fail,
            fontSize: 10,
            fontWeight: 600,
          }}>❌ Health check falló</div>
          <Arrow color={T.rollbackAuto} />
          <div style={{
            background: T.rollbackAutoDim,
            border: `1px solid ${T.rollbackAuto}40`,
            borderRadius: 6,
            padding: "6px 10px",
            textAlign: "center",
          }}>
            <div style={{ fontSize: 13 }}>🔄</div>
            <div style={{ color: T.rollbackAuto, fontSize: 10, fontWeight: 700 }}>Rollback AUTO</div>
            <div style={{ color: T.textDim, fontSize: 8 }}>(dentro de deploy-production)</div>
          </div>

          {/* Sub-bifurcación: rollback auto OK vs FAIL */}
          <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <Arrow color={T.ok} />
              <div style={{
                background: T.okDim,
                border: `1px solid ${T.ok}40`,
                borderRadius: 5,
                padding: "3px 8px",
                color: T.ok,
                fontSize: 9,
                fontWeight: 600,
              }}>✅ Rollback OK</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <Arrow color={T.critical} />
              <div style={{
                background: T.criticalDim,
                border: `1px solid ${T.critical}50`,
                borderRadius: 5,
                padding: "3px 8px",
                color: T.critical,
                fontSize: 9,
                fontWeight: 700,
              }}>🚨 Alerta crítica</div>
            </div>
          </div>
        </div>
      </div>

      {/* Separador + rollback manual como rama independiente */}
      <div style={{
        marginTop: 20,
        width: "100%",
        maxWidth: 380,
        borderTop: `1px dashed ${T.rollbackManual}40`,
        paddingTop: 14,
      }}>
        <div style={{ color: T.textDim, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8, textAlign: "center" }}>
          Rama independiente (intervención humana)
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <div style={{
            background: T.criticalDim,
            border: `1px solid ${T.critical}40`,
            borderRadius: 5,
            padding: "3px 10px",
            color: T.critical,
            fontSize: 9,
            fontWeight: 600,
          }}>🚨 Rollback auto falló</div>
          <svg width="28" height="16" viewBox="0 0 28 16" fill="none">
            <path d="M2 8 L22 8" stroke={T.rollbackManual} strokeWidth="1.5" strokeDasharray="4 3"/>
            <path d="M18 4 L24 8 L18 12" stroke={T.rollbackManual} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {wfBox(rollbackManual, { minWidth: 140 })}
        </div>
        <div style={{ color: T.textDim, fontSize: 9, textAlign: "center", marginTop: 6 }}>
          También se puede disparar manualmente en cualquier momento (emergencias, bugs post-deploy)
        </div>
      </div>
    </div>
  );
}

// ─── VISTA: DETALLE DE CADA WORKFLOW ──────────────────────────────
function WorkflowDetail({ wf }) {
  const [expandedStep, setExpandedStep] = useState(null);

  return (
    <div style={{ width: "100%" }}>
      {/* Header del workflow */}
      <div style={{
        background: wf.dim,
        border: `1px solid ${wf.color}40`,
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 18 }}>{wf.icon}</span>
          <span style={{ color: wf.color, fontSize: 14, fontWeight: 700 }}>{wf.label}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <Badge color={wf.color} small>trigger: {wf.trigger}</Badge>
          <Badge color={T.text} small>runner: {wf.runner}</Badge>
        </div>
        <div style={{ color: T.text, fontSize: 11, lineHeight: 1.5 }}>{wf.desc}</div>
      </div>

      {/* Steps */}
      {wf.steps.map((step, i) => {
        const isOpen = expandedStep === i;
        // Detectar si es un job boundary
        const jobMatch = step.title.match(/^\[Job: (.+?)\]/);
        const jobName = jobMatch ? jobMatch[1] : null;
        const prevJobMatch = i > 0 ? wf.steps[i - 1].title.match(/^\[Job: (.+?)\]/) : null;
        const prevJobName = prevJobMatch ? prevJobMatch[1] : null;
        const newJob = jobName && jobName !== prevJobName;

        return (
          <div key={i}>
            {/* Separador de job */}
            {newJob && (
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: i === 0 ? "0 0 6px" : "10px 0 6px",
              }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <Badge color={wf.color} small>Job: {jobName}</Badge>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>
            )}

            <div
              onClick={() => setExpandedStep(isOpen ? null : i)}
              style={{
                background: isOpen ? T.surfaceHi : T.surface,
                border: `1px solid ${isOpen ? wf.color + "40" : T.border}`,
                borderRadius: 6,
                marginBottom: 4,
                cursor: "pointer",
                overflow: "hidden",
                transition: "border-color 0.15s",
              }}
            >
              {/* Step header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px" }}>
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: wf.color + "20",
                  border: `1px solid ${wf.color}50`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: wf.color,
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0,
                }}>{i + 1}</div>
                <span style={{ color: T.textBright, fontSize: 11, flex: 1 }}>{step.title}</span>
                <span style={{ color: T.textDim, fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>
              </div>

              {/* Why (expandido) */}
              {isOpen && (
                <div style={{
                  padding: "0 10px 8px 38px",
                  borderTop: `1px solid ${T.border}`,
                  paddingTop: 8,
                }}>
                  <div style={{
                    background: wf.color + "0a",
                    borderLeft: `2px solid ${wf.color}`,
                    borderRadius: "0 4px 4px 0",
                    padding: "6px 10px",
                  }}>
                    <span style={{ color: wf.color, fontSize: 9, fontWeight: 700 }}>¿POR QUÉ? </span>
                    <span style={{ color: T.text, fontSize: 11 }}>{step.why}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── VISTA: RIESGOS ───────────────────────────────────────────────
const RISKS = [
  {
    title: "Race condition entre merge y tag",
    color: T.warn,
    mitigation: "El workflow de release calcula el tag de forma determinista desde el historial de commits. deploy-schedule verifica la existencia del tag antes de disparar. Si no existe, no dispara y reintenta en 5 min.",
  },
  {
    title: "El cron se ejecuta y el tag aún no existe",
    color: T.warn,
    mitigation: "deploy-schedule hace git rev-parse --verify antes de llamar a deploy-production. Si el tag no existe, el workflow termina con exit 0 (no falla) y el cron reintenta.",
  },
  {
    title: "Rollback apunta a un tag inexistente",
    color: T.fail,
    mitigation: "En deploy-production: si patch=0, busca el tag real anterior con git tag --sort. En rollback-manual: valida existencia del tag destino en la fase de validación.",
  },
  {
    title: "Self-hosted runner con estado sucio",
    color: T.warn,
    mitigation: "rm -rf del workspace antes de cada checkout. Es el primer paso en deploy y en rollback-manual. Sin esto, código de ejecuciones anteriores puede contaminar el deploy.",
  },
  {
    title: "Secrets expuestos en logs",
    color: T.fail,
    mitigation: "GitHub Environments escopa los secrets. Nunca se printean variables de entorno en logs. El health check URL viene de secrets, no de variables visibles.",
  },
  {
    title: "Timezone incorrecto en DEPLOY_SCHEDULED",
    color: T.warn,
    mitigation: "GitHub Actions usa UTC. El workflow valida que la fecha sea ISO 8601 con timezone explícito y la convierte a epoch UTC internamente.",
  },
  {
    title: "Deploy y rollback usan mecanismos diferentes",
    color: T.critical,
    mitigation: "El rollback-manual y el rollback automático deben usar exactamente el mismo mecanismo de deploy que deploy-production. Si uno usa docker-compose, todos deben usar docker-compose.",
  },
  {
    title: "rollback-manual se dispara por error",
    color: T.warn,
    mitigation: "Tres capas: (1) campo de confirmación textual 'CONFIRMO ROLLBACK', (2) validaciones automáticas, (3) aprobación obligatoria del environment production.",
  },
];

function RisksView() {
  const [expanded, setExpanded] = useState(null);
  return (
    <div style={{ width: "100%" }}>
      {RISKS.map((risk, i) => {
        const isOpen = expanded === i;
        return (
          <div
            key={i}
            onClick={() => setExpanded(isOpen ? null : i)}
            style={{
              background: isOpen ? T.surfaceHi : T.surface,
              border: `1px solid ${isOpen ? risk.color + "40" : T.border}`,
              borderRadius: 6,
              marginBottom: 4,
              cursor: "pointer",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
              <div style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: risk.color + "18",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                flexShrink: 0,
              }}>⚠️</div>
              <span style={{ color: T.textBright, fontSize: 11, flex: 1 }}>{risk.title}</span>
              <span style={{ color: T.textDim, fontSize: 10 }}>{isOpen ? "▲" : "▼"}</span>
            </div>
            {isOpen && (
              <div style={{ padding: "0 10px 10px 42px" }}>
                <div style={{
                  background: T.okDim,
                  borderLeft: `2px solid ${T.ok}`,
                  borderRadius: "0 4px 4px 0",
                  padding: "6px 10px",
                }}>
                  <span style={{ color: T.ok, fontSize: 9, fontWeight: 700 }}>MITIGACIÓN </span>
                  <span style={{ color: T.text, fontSize: 11 }}>{risk.mitigation}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── VISTA: ARCHIVO COMPARTIDO ────────────────────────────────────
function SharedFileView() {
  const writers = [
    { wf: "deploy-production.yml", color: T.deploy, action: "Escribe tras deploy exitoso", icon: "✅" },
    { wf: "rollback-manual.yml", color: T.rollbackManual, action: "Escribe tras rollback exitoso", icon: "✅" },
  ];
  const readers = [
    { wf: "rollback-manual.yml", color: T.rollbackManual, action: "Lee para comparar versiones", icon: "📖" },
  ];

  return (
    <div style={{ width: "100%" }}>
      <div style={{
        background: T.surfaceHi,
        border: `1px solid ${T.borderHi}`,
        borderRadius: 8,
        padding: 14,
        textAlign: "center",
        marginBottom: 12,
      }}>
        <div style={{ color: T.textBright, fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          📄 <code style={{ color: T.warn }}>.deploy/current-production.json</code>
        </div>
        <div style={{ color: T.textDim, fontSize: 10 }}>Única fuente de verdad compartida entre workflows</div>
      </div>

      {/* Estructura del archivo */}
      <div style={{
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 6,
        padding: "10px 14px",
        marginBottom: 12,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
      }}>
        <div style={{ color: T.textDim, fontSize: 9, marginBottom: 6 }}>ESTRUCTURA</div>
        {[
          ['"tag"', '"v2.4.0"', 'El tag actualmente desplegado'],
          ['"deployed_at"', '"2026-02-03T..."', 'Timestamp ISO 8601 UTC'],
          ['"deployed_by"', '"username"', 'GitHub actor que ejecutó'],
          ['"method"', '"deploy" | "manual-rollback"', 'Cómo llegó esta versión'],
          ['"workflow_run_id"', '"12345678"', 'Para trazabilidad'],
        ].map(([key, val, desc], i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", alignItems: "baseline" }}>
            <span style={{ color: T.warn, fontSize: 11 }}>{key}:</span>
            <span style={{ color: T.green, fontSize: 11 }}>{val}</span>
            <span style={{ color: T.textDim, fontSize: 9, marginLeft: "auto" }}>{desc}</span>
          </div>
        ))}
      </div>

      {/* Escritores */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: T.textDim, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>✏️ Escritores</div>
        {writers.map((w, i) => (
          <div key={i} style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: w.color + "0a",
            border: `1px solid ${w.color}25`,
            borderRadius: 5,
            padding: "5px 10px",
            marginBottom: 3,
          }}>
            <span style={{ fontSize: 14 }}>{w.icon}</span>
            <span style={{ color: w.color, fontSize: 11, fontWeight: 600 }}>{w.wf}</span>
            <span style={{ color: T.textDim, fontSize: 10 }}>{w.action}</span>
          </div>
        ))}
      </div>

      {/* Lectores */}
      <div>
        <div style={{ color: T.textDim, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>📖 Lectores</div>
        {readers.map((r, i) => (
          <div key={i} style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: r.color + "0a",
            border: `1px solid ${r.color}25`,
            borderRadius: 5,
            padding: "5px 10px",
            marginBottom: 3,
          }}>
            <span style={{ fontSize: 14 }}>{r.icon}</span>
            <span style={{ color: r.color, fontSize: 11, fontWeight: 600 }}>{r.wf}</span>
            <span style={{ color: T.textDim, fontSize: 10 }}>{r.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────
export default function DeploymentPlan() {
  // Tabs del top level
  const TABS = ["Arquitectura", "Workflows", "Riesgos", "Estado compartido"];
  const [activeTab, setActiveTab] = useState("Arquitectura");

  // Sub-tab dentro de Workflows
  const [activeWorkflow, setActiveWorkflow] = useState(0);

  return (
    <div style={{
      background: T.bg,
      minHeight: "100vh",
      color: T.text,
      fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
      padding: "24px 12px 40px",
    }}>
      <div style={{ maxWidth: 580, margin: "0 auto" }}>

        {/* ── Título ── */}
        <div style={{ textAlign: "center", marginBottom: 6 }}>
          <h1 style={{ color: T.textBright, fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
            🏗️ Plan de Despliegue a Producción
          </h1>
          <p style={{ color: T.textDim, fontSize: 10, margin: "4px 0 0" }}>
            GitHub Actions · Environments · Self-hosted runners · 4 workflows
          </p>
        </div>

        {/* ── Leyenda de workflows ── */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 16 }}>
          {WORKFLOWS.map(wf => (
            <div key={wf.id} style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: wf.dim,
              border: `1px solid ${wf.color}35`,
              borderRadius: 5,
              padding: "3px 8px",
              cursor: "pointer",
            }} onClick={() => { setActiveTab("Workflows"); setActiveWorkflow(WORKFLOWS.indexOf(wf)); }}>
              <span style={{ fontSize: 11 }}>{wf.icon}</span>
              <span style={{ color: wf.color, fontSize: 9, fontWeight: 700 }}>{wf.label}</span>
            </div>
          ))}
        </div>

        {/* ── Tabs principales ── */}
        <div style={{
          display: "flex",
          gap: 2,
          background: T.surface,
          borderRadius: 8,
          padding: 3,
          marginBottom: 16,
          border: `1px solid ${T.border}`,
        }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  flex: 1,
                  background: isActive ? T.surfaceHi : "transparent",
                  border: isActive ? `1px solid ${T.borderHi}` : "1px solid transparent",
                  borderRadius: 6,
                  color: isActive ? T.textBright : T.textDim,
                  fontSize: 10,
                  fontWeight: isActive ? 600 : 400,
                  padding: "5px 4px",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  fontFamily: "inherit",
                }}
              >{tab}</button>
            );
          })}
        </div>

        {/* ── Contenido según tab ── */}

        {activeTab === "Arquitectura" && <ArchitectureView />}

        {activeTab === "Workflows" && (
          <div>
            {/* Sub-tabs de workflows */}
            <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
              {WORKFLOWS.map((wf, i) => {
                const isActive = activeWorkflow === i;
                return (
                  <button
                    key={wf.id}
                    onClick={() => setActiveWorkflow(i)}
                    style={{
                      background: isActive ? wf.dim : T.surface,
                      border: `1px solid ${isActive ? wf.color + "50" : T.border}`,
                      borderRadius: 6,
                      color: isActive ? wf.color : T.textDim,
                      fontSize: 10,
                      fontWeight: isActive ? 700 : 400,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >{wf.icon} {wf.label}</button>
                );
              })}
            </div>
            <WorkflowDetail wf={WORKFLOWS[activeWorkflow]} />
          </div>
        )}

        {activeTab === "Riesgos" && <RisksView />}

        {activeTab === "Estado compartido" && <SharedFileView />}

        {/* ── Footer nota ── */}
        <div style={{
          marginTop: 20,
          padding: "10px 12px",
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 6,
        }}>
          <span style={{ color: T.textDim, fontSize: 10, lineHeight: 1.6 }}>
            <strong style={{ color: T.textBright }}>Principio clave:</strong> Cada workflow tiene una sola responsabilidad. La única comunicación entre workflows es el archivo <code style={{ color: T.warn }}>.deploy/current-production.json</code> (estado compartido) y la API de GitHub (disparar workflows). Sin globals, sin outputs volátiles entre jobs de distintos workflows.
          </span>
        </div>
      </div>
    </div>
  );
}
