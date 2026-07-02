import { useEffect, useRef, useState } from "react";

/* ================= CONFIGURACIÓN Y PERSISTENCIA ================= */

const KEY_SESSION = "roccia_session_v1";
const KEY_CONSTANT = "roccia_constant_v1"; // constante aprendida (memoria entre sesiones)
const KEY_SESSIONS_LOG = "roccia_sessions_log_v1"; // historial de cierres verificados
const KEY_INSTALL_DISMISSED = "roccia_install_dismissed_v1"; // timestamp del último "no ahora"
const DEFAULT_CONSTANT = 5.89; // minutos por 1% (dato empírico del reporte)
const CAPACITY_WH = 111; // Roccia 30,000 mAh @ 3.7V
const SESSIONS_LOG_MAX = 20;
const BASELINE = 5.89; // constante de referencia por defecto para la salud de la batería
const HEALTH_MIN_SESSION_MIN = 60; // duración mínima para que una sesión cuente como "válida"
const HEALTH_SAMPLE_SIZE = 3; // cuántas sesiones válidas se promedian para cada extremo
const INSTALL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000; // reintentar el banner a los 7 días

// Tipo mínimo del evento no estándar "beforeinstallprompt" (no está en lib.dom.d.ts).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Calibration = {
  hora: string;
  elapsedMin: number;
  estPercent: number;
  realPercent: number;
  deviation: number; // estimado - real (+ = app optimista / adelantada)
  newConstant: number;
};

type Session = {
  startTs: number;
  initialPercent: number;
  constant: number;
  calibrations: Calibration[];
};

type SessionLogEntry = {
  startTs: number;
  endTs: number;
  initialPercent: number;
  estFinalPercent: number;
  realFinalPercent: number;
  deviation: number; // estimado - real (+ = app adelantada, - = app atrasada)
  elapsedMin: number;
  constant: number; // constante vigente al cierre de la sesión
  verified: boolean; // true = el estimado coincidió con el real ("SÍ, coincide")
};

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY_SESSION);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null) {
  if (s) localStorage.setItem(KEY_SESSION, JSON.stringify(s));
  else localStorage.removeItem(KEY_SESSION);
}
function loadLearnedConstant(): number {
  const v = parseFloat(localStorage.getItem(KEY_CONSTANT) || "");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CONSTANT;
}
function saveLearnedConstant(v: number) {
  localStorage.setItem(KEY_CONSTANT, String(v));
}
function loadSessionsLog(): SessionLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY_SESSIONS_LOG);
    return raw ? (JSON.parse(raw) as SessionLogEntry[]) : [];
  } catch {
    return [];
  }
}
function saveSessionsLog(log: SessionLogEntry[]) {
  localStorage.setItem(KEY_SESSIONS_LOG, JSON.stringify(log.slice(0, SESSIONS_LOG_MAX)));
}

/* ================= DETECCIÓN DE DESGASTE DE LA BATERÍA ================= */

type BatteryHealth =
  | { status: "collecting"; validCount: number }
  | {
      status: "ok" | "warn" | "critical";
      health: number;
      referenceConstant: number;
      currentConstant: number;
    };

function average(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/* sessionsLog viene ordenado del más reciente al más antiguo (ver recordSessionLog).
   Referencia = promedio de las 3 sesiones válidas más antiguas del log (estado "sano"
   inicial). Actual = promedio de las 3 sesiones válidas más recientes. Solo se
   consideran sesiones de más de 60 minutos para evitar ruido estadístico. */
function computeBatteryHealth(log: SessionLogEntry[]): BatteryHealth {
  const valid = log.filter((s) => s.elapsedMin > HEALTH_MIN_SESSION_MIN);
  if (valid.length < HEALTH_SAMPLE_SIZE) {
    return { status: "collecting", validCount: valid.length };
  }
  const referenceConstant =
    valid.length >= HEALTH_SAMPLE_SIZE
      ? average(valid.slice(-HEALTH_SAMPLE_SIZE).map((s) => s.constant))
      : BASELINE;
  const currentConstant = average(valid.slice(0, HEALTH_SAMPLE_SIZE).map((s) => s.constant));
  const health = Math.min(100, (currentConstant / referenceConstant) * 100);
  const status = health >= 92 ? "ok" : health >= 80 ? "warn" : "critical";
  return { status, health, referenceConstant, currentConstant };
}

/* ================= UTILIDADES ================= */

function fmtHM(totalMin: number): string {
  const m = Math.max(0, Math.round(totalMin));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-VE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function fmtDateShort(ts: number): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString("es-VE", { day: "2-digit", month: "2-digit" });
  return `${day} ${fmtClock(ts)}`;
}
function isStandaloneMode(): boolean {
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || iosStandalone;
}

/* ================= ESTILOS ================= */

const C = {
  bg: "#0A0E15",
  panel: "#10151F",
  card: "#161D29",
  border: "#26303F",
  lcd: "#5DCAA5",
  lcdDim: "#1A2230",
  text: "#E8EDF5",
  muted: "#8B96A8",
  green: "#1D9E75",
  greenDark: "#04342C",
  red: "#E24B4A",
  amber: "#EF9F27",
};

const S: Record<string, React.CSSProperties> = {
  app: {
    minHeight: "100dvh",
    background: C.bg,
    display: "flex",
    justifyContent: "center",
    padding: "16px 12px 32px",
    fontFamily: "'Inter', system-ui, sans-serif",
    color: C.text,
  },
  shell: { width: "100%", maxWidth: 420 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 4px 16px",
  },
  brand: { fontSize: 14, letterSpacing: 2, color: C.muted, fontWeight: 600 },
  lcdBox: {
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 20,
    padding: "26px 18px 20px",
    textAlign: "center",
  },
  lcdValue: {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 72,
    lineHeight: 1,
    color: C.lcd,
    textShadow: `0 0 18px ${C.lcd}44`,
  },
  barTrack: {
    marginTop: 18,
    height: 10,
    background: C.lcdDim,
    borderRadius: 6,
    overflow: "hidden",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginTop: 14,
  },
  metric: {
    background: C.card,
    borderRadius: 12,
    padding: "10px 14px",
    textAlign: "left",
  },
  metricLabel: { fontSize: 12, color: C.muted },
  metricValue: {
    fontSize: 18,
    fontFamily: "'Share Tech Mono', monospace",
    marginTop: 2,
  },
  btnRow: { display: "flex", gap: 10, marginTop: 16 },
  btn: {
    flex: 1,
    border: "none",
    borderRadius: 12,
    padding: "14px 0",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: C.lcdDim,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    color: C.text,
    fontSize: 18,
    padding: "12px 14px",
    fontFamily: "'Share Tech Mono', monospace",
    textAlign: "center",
    outline: "none",
  },
  section: {
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 16,
    marginTop: 14,
  },
  badge: {
    marginTop: 10,
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13.5,
    lineHeight: 1.5,
  },
  histRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    padding: "6px 0",
    borderBottom: `1px solid ${C.border}`,
    fontFamily: "'Share Tech Mono', monospace",
  },
};

/* ================= COMPONENTE PRINCIPAL ================= */

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [now, setNow] = useState(() => Date.now());
  const [initialInput, setInitialInput] = useState("100");
  const [calibInput, setCalibInput] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);
  const [sessionsLog, setSessionsLog] = useState<SessionLogEntry[]>(() => loadSessionsLog());

  // Snapshot tomado al presionar STOP: congela el estimado y los minutos
  // transcurridos mientras el usuario decide en el panel de cierre.
  const [stopSnapshot, setStopSnapshot] = useState<{ ts: number; elapsedMin: number; estPercent: number } | null>(null);
  const [stopStage, setStopStage] = useState<"confirm" | "correct">("confirm");
  const [stopCorrectInput, setStopCorrectInput] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Banner de instalación: "prompt" = hay beforeinstallprompt disponible,
  // "manual" = fallback (Safari iOS y otros navegadores que no lo disparan).
  const [installBanner, setInstallBanner] = useState<{ mode: "prompt" | "manual" } | null>(null);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  // Reloj: refresco de UI cada segundo
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Captura beforeinstallprompt y decide si corresponde ofrecer instalación:
  // nunca si ya corre standalone, y no si el usuario la descartó hace menos de 7 días.
  useEffect(() => {
    if (isStandaloneMode()) return;

    const dismissedTs = Number(localStorage.getItem(KEY_INSTALL_DISMISSED));
    if (Number.isFinite(dismissedTs) && dismissedTs > 0 && Date.now() - dismissedTs < INSTALL_DISMISS_MS) {
      return;
    }

    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setInstallBanner({ mode: "prompt" });
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);

    // Si el evento nativo nunca llega (Safari iOS y algunos otros), ofrecemos
    // igual el banner con instrucciones manuales de instalación.
    const fallbackTimer = window.setTimeout(() => {
      if (!deferredPromptRef.current) {
        setInstallBanner({ mode: "manual" });
      }
    }, 2500);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  /* ---------- Cálculos en vivo (sección 5 del reporte) ---------- */
  const elapsedMin = session ? (now - session.startTs) / 60000 : 0;
  const lost = session ? elapsedMin / session.constant : 0;
  const estPercent = session ? clamp(session.initialPercent - lost, 0, 100) : 0;
  const remainingMin = session ? estPercent * session.constant : 0;
  const watts = session ? (CAPACITY_WH * (60 / session.constant)) / 100 : 0;
  const percentPerHour = session ? 60 / session.constant : 0;
  const batteryHealth = computeBatteryHealth(sessionsLog);

  /* ---------- Acciones ---------- */

  function dismissInstallBanner() {
    localStorage.setItem(KEY_INSTALL_DISMISSED, String(Date.now()));
    setInstallBanner(null);
  }

  function handleInstallAccept() {
    const prompt = deferredPromptRef.current;
    if (!prompt) {
      dismissInstallBanner();
      return;
    }
    prompt.prompt();
    prompt.userChoice
      .then((choice) => {
        if (choice.outcome === "accepted") {
          setInstallBanner(null); // instalada: standalone la ocultará permanentemente
        } else {
          dismissInstallBanner(); // rechazada: reintentar a los 7 días
        }
      })
      .finally(() => {
        deferredPromptRef.current = null;
      });
  }

  /* Compara la constante final de la sesión que se está cerrando contra el
     promedio de las 3 sesiones válidas anteriores (ya guardadas en el log,
     antes de agregar esta). Si cayó más de 15%, es una caída brusca. */
  function buildSuddenDropWarning(newConstant: number): string | null {
    const prevValid = sessionsLog.filter((s) => s.elapsedMin > HEALTH_MIN_SESSION_MIN);
    if (prevValid.length < HEALTH_SAMPLE_SIZE) return null;
    const avgPrev = average(prevValid.slice(0, HEALTH_SAMPLE_SIZE).map((s) => s.constant));
    if (newConstant < avgPrev * 0.85) {
      return "Esta sesión se descargó notablemente más rápido de lo habitual. Puede ser un pico de consumo puntual o inicio de degradación — verifica que la carga conectada sea la misma (solo ONU + router).";
    }
    return null;
  }

  function handleStart() {
    const p = parseFloat(initialInput);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      setMsg({ text: "Ingresa un porcentaje inicial válido (1 – 100).", tone: "err" });
      return;
    }
    const s: Session = {
      startTs: Date.now(),
      initialPercent: p,
      constant: loadLearnedConstant(), // arranca con la constante aprendida
      calibrations: [],
    };
    setSession(s);
    saveSession(s);

    const healthNote =
      batteryHealth.status !== "collecting" && batteryHealth.health < 92
        ? ` Nota: se detecta desgaste (salud ${Math.round(batteryHealth.health)}%), las estimaciones ya están ajustadas a la condición actual del equipo.`
        : "";
    setMsg({
      text: `Sesión iniciada al ${p}% con constante de ${s.constant.toFixed(2)} min/% (memoria del sistema).${healthNote}`,
      tone: "ok",
    });
  }

  function handleStop() {
    if (!session) return;
    setStopSnapshot({ ts: Date.now(), elapsedMin, estPercent });
    setStopStage("confirm");
    setStopCorrectInput("");
  }

  function handleStopCancel() {
    setStopSnapshot(null);
    setStopStage("confirm");
    setStopCorrectInput("");
  }

  function recordSessionLog(entry: SessionLogEntry) {
    const updated = [entry, ...loadSessionsLog()].slice(0, SESSIONS_LOG_MAX);
    saveSessionsLog(updated);
    setSessionsLog(updated);
  }

  /* ---------- Verificación final de cierre ("SÍ, coincide") ----------
     El estimado coincidió con el real: no hay desfase, la constante
     vigente se confirma como válida y queda en memoria permanente. */
  function handleStopConfirmMatch() {
    if (!session || !stopSnapshot) return;
    const constant = Math.round(session.constant * 100) / 100;
    const finalPercent = Math.round(stopSnapshot.estPercent * 10) / 10;
    const suddenDrop = buildSuddenDropWarning(constant);

    recordSessionLog({
      startTs: session.startTs,
      endTs: stopSnapshot.ts,
      initialPercent: session.initialPercent,
      estFinalPercent: finalPercent,
      realFinalPercent: finalPercent,
      deviation: 0,
      elapsedMin: Math.round(stopSnapshot.elapsedMin),
      constant,
      verified: true,
    });
    saveLearnedConstant(session.constant);

    setSession(null);
    saveSession(null);
    setStopSnapshot(null);
    setCalibInput("");
    setMsg({
      text: `Sesión finalizada y verificada al ${finalPercent}%. Registro guardado para retroalimentación. Constante confirmada en ${constant.toFixed(2)} min/%.${
        suddenDrop ? ` ${suddenDrop}` : ""
      }`,
      tone: suddenDrop ? "warn" : "ok",
    });
  }

  /* ---------- Corrección final de cierre ("NO, corregir") ----------
     Misma fórmula y validación mínima que la calibración en caliente,
     pero aplicada al cierre: recalcula la constante con los minutos y
     el % real congelados en el snapshot de STOP. */
  function handleStopConfirmCorrect() {
    if (!session || !stopSnapshot) return;
    const real = parseFloat(stopCorrectInput);
    if (!Number.isFinite(real) || real < 0 || real > session.initialPercent) {
      setMsg({
        text: `Ingresa el % real que muestra el power bank (entre 0 y ${session.initialPercent}).`,
        tone: "err",
      });
      return;
    }

    const consumed = session.initialPercent - real;
    const deviation = Math.round((stopSnapshot.estPercent - real) * 10) / 10;
    const estFinalPercent = Math.round(stopSnapshot.estPercent * 10) / 10;
    const elapsedMinRounded = Math.round(stopSnapshot.elapsedMin);

    if (stopSnapshot.elapsedMin < 5 || consumed < 1) {
      const constantUnchanged = Math.round(session.constant * 100) / 100;
      const suddenDrop = buildSuddenDropWarning(constantUnchanged);
      recordSessionLog({
        startTs: session.startTs,
        endTs: stopSnapshot.ts,
        initialPercent: session.initialPercent,
        estFinalPercent,
        realFinalPercent: real,
        deviation,
        elapsedMin: elapsedMinRounded,
        constant: constantUnchanged,
        verified: false,
      });
      setSession(null);
      saveSession(null);
      setStopSnapshot(null);
      setCalibInput("");
      setMsg({
        text: `Datos insuficientes para ajustar la constante (mínimo 5 minutos y 1% de consumo real). Sesión finalizada y registro guardado sin modificar la constante.${
          suddenDrop ? ` ${suddenDrop}` : ""
        }`,
        tone: "warn",
      });
      return;
    }

    const newConstant = stopSnapshot.elapsedMin / consumed; // misma fórmula del reporte
    const newConstantRounded = Math.round(newConstant * 100) / 100;
    const suddenDrop = buildSuddenDropWarning(newConstantRounded);

    recordSessionLog({
      startTs: session.startTs,
      endTs: stopSnapshot.ts,
      initialPercent: session.initialPercent,
      estFinalPercent,
      realFinalPercent: real,
      deviation,
      elapsedMin: elapsedMinRounded,
      constant: newConstantRounded,
      verified: false,
    });
    saveLearnedConstant(newConstant); // memoria permanente entre sesiones

    setSession(null);
    saveSession(null);
    setStopSnapshot(null);
    setCalibInput("");

    const dir = deviation > 0 ? "adelantada" : "atrasada";
    setMsg({
      text: `Desfase de ${deviation > 0 ? "+" : ""}${deviation}% detectado (la app iba ${dir}). Constante ajustada de ${session.constant.toFixed(2)} a ${newConstantRounded.toFixed(2)} min/% y guardada en memoria.${
        suddenDrop ? ` ${suddenDrop}` : ""
      }`,
      tone: "warn",
    });
  }

  /* ---------- Calibración en caliente (feedback loop) ----------
     Nueva constante = minutos reales transcurridos / porcentaje real consumido.
     Detecta desfase (app optimista) o atraso (app pesimista) y reescribe
     la constante en la sesión Y en la memoria permanente. */
  function handleCalibrate() {
    if (!session) return;
    const real = parseFloat(calibInput);
    if (!Number.isFinite(real) || real < 0 || real > session.initialPercent) {
      setMsg({
        text: `Ingresa el % real que muestra el power bank (entre 0 y ${session.initialPercent}).`,
        tone: "err",
      });
      return;
    }
    const consumed = session.initialPercent - real;
    if (elapsedMin < 5 || consumed < 1) {
      setMsg({
        text: "Datos insuficientes para calibrar: espera al menos 5 minutos y 1% de consumo real.",
        tone: "warn",
      });
      return;
    }

    const newConstant = elapsedMin / consumed; // fórmula del reporte
    const deviation = estPercent - real; // + = la app iba adelantada (optimista)

    const entry: Calibration = {
      hora: fmtClock(Date.now()),
      elapsedMin: Math.round(elapsedMin),
      estPercent: Math.round(estPercent * 10) / 10,
      realPercent: real,
      deviation: Math.round(deviation * 10) / 10,
      newConstant: Math.round(newConstant * 100) / 100,
    };

    const updated: Session = {
      ...session,
      constant: newConstant,
      calibrations: [entry, ...session.calibrations].slice(0, 8),
    };
    setSession(updated);
    saveSession(updated);
    saveLearnedConstant(newConstant); // memoria permanente entre sesiones
    setCalibInput("");

    if (Math.abs(deviation) < 0.5) {
      setMsg({
        text: `Calibrado. Desfase mínimo (${deviation > 0 ? "+" : ""}${entry.deviation}%). Constante ajustada a ${entry.newConstant} min/%.`,
        tone: "ok",
      });
    } else if (deviation > 0) {
      setMsg({
        text: `Desfase detectado: la app iba ADELANTADA ${entry.deviation}% (la batería real se descarga más rápido). Constante reducida a ${entry.newConstant} min/% y guardada en memoria.`,
        tone: "warn",
      });
    } else {
      setMsg({
        text: `Desfase detectado: la app iba ATRASADA ${Math.abs(entry.deviation)}% (la batería real se descarga más lento). Constante aumentada a ${entry.newConstant} min/% y guardada en memoria.`,
        tone: "warn",
      });
    }
  }

  /* Borra toda clave con prefijo "roccia_" (sesión, constante aprendida,
     log de sesiones, marca del banner de instalación, y cualquier futura). */
  function handleFactoryReset() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("roccia_"))
      .forEach((k) => localStorage.removeItem(k));
    setSessionsLog([]);
    setShowResetConfirm(false);
    setMsg({
      text: "Datos restablecidos. El sistema vuelve a la constante de fábrica 5.89 min/%",
      tone: "ok",
    });
  }

  /* ---------- Render ---------- */

  const toneColors = {
    ok: { bg: "#0F2E23", border: C.green, color: C.lcd },
    warn: { bg: "#2E230F", border: C.amber, color: C.amber },
    err: { bg: "#2E0F0F", border: C.red, color: "#F09595" },
  };

  return (
    <div style={S.app}>
      <div style={S.shell}>
        {/* ===== BANNER DE INSTALACIÓN ===== */}
        {installBanner && (
          <div style={{ ...S.section, marginTop: 0, marginBottom: 14, background: C.card, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5, marginBottom: 12 }}>
              {installBanner.mode === "prompt"
                ? "Instala Roccia Monitor en tu teléfono: funcionará sin internet y podrás abrirla desde la pantalla de inicio durante los apagones."
                : "Para instalar: abre el menú ⋮ del navegador y elige \"Agregar a pantalla de inicio\"."}
            </div>
            {installBanner.mode === "prompt" ? (
              <div style={S.btnRow}>
                <button style={{ ...S.btn, background: C.green, color: C.greenDark }} onClick={handleInstallAccept}>
                  INSTALAR
                </button>
                <button
                  style={{ ...S.btn, background: "transparent", color: C.muted, border: `1px solid ${C.border}` }}
                  onClick={dismissInstallBanner}
                >
                  Ahora no
                </button>
              </div>
            ) : (
              <div style={S.btnRow}>
                <button style={{ ...S.btn, background: C.green, color: C.greenDark }} onClick={dismissInstallBanner}>
                  Entendido
                </button>
              </div>
            )}
          </div>
        )}

        <div style={S.header}>
          <span style={S.brand}>ROCCIA MONITOR</span>
          <span style={{ fontSize: 12, color: C.muted }}>
            30,000 mAh · {CAPACITY_WH} Wh
          </span>
        </div>

        {/* ===== DISPLAY LCD ===== */}
        <div style={S.lcdBox}>
          <div style={S.lcdValue}>
            {session ? estPercent.toFixed(1) : "--"}
            <span style={{ fontSize: 30 }}>%</span>
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
            {session ? "estimado en tiempo real" : "sin sesión activa"}
          </div>
          <div style={S.barTrack}>
            <div
              style={{
                width: `${session ? estPercent : 0}%`,
                height: "100%",
                background:
                  estPercent > 20 || !session ? C.lcd : estPercent > 10 ? C.amber : C.red,
                transition: "width 1s linear",
              }}
            />
          </div>
        </div>

        {/* ===== MÉTRICAS ===== */}
        {session && (
          <div style={S.grid}>
            <div style={S.metric}>
              <div style={S.metricLabel}>Autonomía restante</div>
              <div style={S.metricValue}>{fmtHM(remainingMin)}</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Ritmo actual</div>
              <div style={S.metricValue}>{session.constant.toFixed(2)} m/%</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Inicio de sesión</div>
              <div style={S.metricValue}>{fmtClock(session.startTs)}</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Transcurrido</div>
              <div style={S.metricValue}>{fmtHM(elapsedMin)}</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Potencia estimada</div>
              <div style={S.metricValue}>{watts.toFixed(2)} W</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Consumo por hora</div>
              <div style={S.metricValue}>{percentPerHour.toFixed(2)} %/h</div>
            </div>
          </div>
        )}

        {/* ===== START / STOP ===== */}
        {!session ? (
          <div style={S.section}>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
              Porcentaje inicial del power bank
            </div>
            <input
              style={S.input}
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
            />
            <div style={S.btnRow}>
              <button
                style={{ ...S.btn, background: C.green, color: C.greenDark }}
                onClick={handleStart}
              >
                ▶ START
              </button>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10, textAlign: "center" }}>
              Constante en memoria: {loadLearnedConstant().toFixed(2)} min por 1%
            </div>
          </div>
        ) : (
          <>
            {stopSnapshot ? (
              /* ===== CIERRE DE SESIÓN (verificación final) ===== */
              <div style={S.section}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  Cierre de sesión
                </div>
                {stopStage === "confirm" ? (
                  <>
                    <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
                      La app estima que el power bank está en{" "}
                      <span style={{ color: C.text, fontFamily: "'Share Tech Mono', monospace" }}>
                        {stopSnapshot.estPercent.toFixed(1)}%
                      </span>
                      . ¿Es ese el porcentaje real que muestra el equipo?
                    </div>
                    <div style={S.btnRow}>
                      <button
                        style={{ ...S.btn, background: C.green, color: C.greenDark }}
                        onClick={handleStopConfirmMatch}
                      >
                        SÍ, coincide
                      </button>
                      <button
                        style={{ ...S.btn, background: C.card, color: C.text, border: `1px solid ${C.border}` }}
                        onClick={() => setStopStage("correct")}
                      >
                        NO, corregir
                      </button>
                    </div>
                    <div style={S.btnRow}>
                      <button
                        style={{ ...S.btn, background: "transparent", color: C.muted, border: `1px solid ${C.border}` }}
                        onClick={handleStopCancel}
                      >
                        CANCELAR
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
                      Ingresa el % real que muestra el power bank para ajustar la constante.
                    </div>
                    <input
                      style={S.input}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={session.initialPercent}
                      placeholder={`% real (ej. ${Math.round(stopSnapshot.estPercent)})`}
                      value={stopCorrectInput}
                      onChange={(e) => setStopCorrectInput(e.target.value)}
                    />
                    <div style={S.btnRow}>
                      <button
                        style={{ ...S.btn, background: C.green, color: C.greenDark }}
                        onClick={handleStopConfirmCorrect}
                      >
                        GUARDAR Y AJUSTAR
                      </button>
                      <button
                        style={{ ...S.btn, background: "transparent", color: C.muted, border: `1px solid ${C.border}` }}
                        onClick={handleStopCancel}
                      >
                        CANCELAR
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              /* ===== CALIBRACIÓN ===== */
              <div style={S.section}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  Calibración en caliente
                </div>
                <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
                  Mira la pantalla del power bank e ingresa el % real. La app detecta si va
                  adelantada o atrasada y ajusta la constante en su memoria.
                </div>
                <input
                  style={S.input}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={session.initialPercent}
                  placeholder={`% real (ej. ${Math.round(estPercent)})`}
                  value={calibInput}
                  onChange={(e) => setCalibInput(e.target.value)}
                />
                <div style={S.btnRow}>
                  <button
                    style={{ ...S.btn, background: C.card, color: C.text, border: `1px solid ${C.border}` }}
                    onClick={handleCalibrate}
                  >
                    ⚙ CALIBRAR
                  </button>
                  <button
                    style={{ ...S.btn, background: "#2E1414", color: "#F09595", border: `1px solid ${C.red}55` }}
                    onClick={handleStop}
                  >
                    ■ STOP
                  </button>
                </div>
              </div>
            )}

            {/* ===== HISTORIAL DE CALIBRACIONES ===== */}
            {session.calibrations.length > 0 && (
              <div style={S.section}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  Historial de calibraciones
                </div>
                <div style={{ ...S.histRow, color: C.muted, fontFamily: "inherit", fontSize: 12 }}>
                  <span>Hora</span>
                  <span>Est. → Real</span>
                  <span>Desfase</span>
                  <span>Nueva cte.</span>
                </div>
                {session.calibrations.map((c, i) => (
                  <div key={i} style={S.histRow}>
                    <span>{c.hora}</span>
                    <span>
                      {c.estPercent}% → {c.realPercent}%
                    </span>
                    <span style={{ color: Math.abs(c.deviation) < 0.5 ? C.lcd : C.amber }}>
                      {c.deviation > 0 ? "+" : ""}
                      {c.deviation}%
                    </span>
                    <span>{c.newConstant}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ===== SALUD DE LA BATERÍA ===== */}
        {!session && (
          <div style={S.section}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              Salud de la batería
            </div>
            {batteryHealth.status === "collecting" ? (
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                Recopilando datos de referencia ({batteryHealth.validCount}/3 sesiones de +1h)
              </div>
            ) : (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color:
                    batteryHealth.status === "ok"
                      ? C.lcd
                      : batteryHealth.status === "warn"
                      ? C.amber
                      : C.red,
                }}
              >
                {batteryHealth.status === "ok" &&
                  `Batería en buen estado — salud estimada ${Math.round(batteryHealth.health)}%.`}
                {batteryHealth.status === "warn" &&
                  `Desgaste leve detectado — salud estimada ${Math.round(
                    batteryHealth.health
                  )}%. La autonomía bajó de ${fmtHM(batteryHealth.referenceConstant * 100)} a ${fmtHM(
                    batteryHealth.currentConstant * 100
                  )} respecto a la línea base.`}
                {batteryHealth.status === "critical" &&
                  `Desgaste significativo — salud estimada ${Math.round(
                    batteryHealth.health
                  )}%. Considera reemplazar el power bank o reducir la carga conectada. Autonomía actual: ${fmtHM(
                    batteryHealth.currentConstant * 100
                  )} (antes: ${fmtHM(batteryHealth.referenceConstant * 100)}).`}
              </div>
            )}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
              El cálculo asume la misma carga conectada (ONU VSOL + Archer AX10). Cambiar los
              equipos alimentados invalida la comparación.
            </div>
          </div>
        )}

        {/* ===== HISTORIAL DE SESIONES ===== */}
        {sessionsLog.length > 0 && (
          <div style={S.section}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              Historial de sesiones
            </div>
            <div style={{ ...S.histRow, color: C.muted, fontFamily: "inherit", fontSize: 12 }}>
              <span>Fecha</span>
              <span>Duración</span>
              <span>Inicial → Real</span>
              <span>Desfase</span>
              <span>Cte. final</span>
            </div>
            {sessionsLog.map((s, i) => (
              <div key={i} style={S.histRow}>
                <span>{fmtDateShort(s.startTs)}</span>
                <span>{fmtHM(s.elapsedMin)}</span>
                <span>
                  {s.initialPercent}% → {s.realFinalPercent}%
                </span>
                <span style={{ color: s.verified ? C.lcd : C.amber }}>
                  {s.verified ? "✓" : "⚠"} {s.deviation > 0 ? "+" : ""}
                  {s.deviation}%
                </span>
                <span>{s.constant}</span>
              </div>
            ))}
          </div>
        )}

        {/* ===== MENSAJES ===== */}
        {msg && (
          <div
            style={{
              ...S.badge,
              background: toneColors[msg.tone].bg,
              border: `1px solid ${toneColors[msg.tone].border}`,
              color: toneColors[msg.tone].color,
            }}
          >
            {msg.text}
          </div>
        )}

        <div style={{ fontSize: 11.5, color: C.muted, textAlign: "center", marginTop: 20 }}>
          ONU VSOL + TP-Link Archer AX10 · cables boost 5V→12V · base empírica: 277 min
        </div>

        {/* ===== RESTABLECER DATOS DE FÁBRICA ===== */}
        {!session && (
          <div style={{ textAlign: "center", marginTop: 16 }}>
            {showResetConfirm ? (
              <div style={{ ...S.section, textAlign: "left" }}>
                <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5, marginBottom: 12 }}>
                  Esto borrará el historial de sesiones, calibraciones y la constante aprendida
                  (volverá a 5.89 min/%). Esta acción no se puede deshacer.
                </div>
                <div style={S.btnRow}>
                  <button style={{ ...S.btn, background: C.red, color: "#2E0F0F" }} onClick={handleFactoryReset}>
                    SÍ, BORRAR TODO
                  </button>
                  <button
                    style={{ ...S.btn, background: "transparent", color: C.muted, border: `1px solid ${C.border}` }}
                    onClick={() => setShowResetConfirm(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <span
                style={{ fontSize: 11, color: C.muted, cursor: "pointer" }}
                onClick={() => setShowResetConfirm(true)}
              >
                Restablecer datos de fábrica
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
