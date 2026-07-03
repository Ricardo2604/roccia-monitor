import { useEffect, useRef, useState } from "react";
import {
  enqueueEvent,
  loadHogar,
  outboxLength,
  runSyncCycle,
  setupHogarExistente,
  setupHogarNuevo,
  subscribeRealtime,
  supabase,
  type HogarConfig,
  type SyncEvent,
} from "./sync";

/* ================= CONFIGURACIÓN Y PERSISTENCIA ================= */

const KEY_SESSION = "roccia_session_v1";
const KEY_CONSTANT = "roccia_constant_v1"; // constante aprendida (memoria entre sesiones)
const KEY_SESSIONS_LOG = "roccia_sessions_log_v1"; // historial de cierres verificados
const KEY_INSTALL_DISMISSED = "roccia_install_dismissed_v1"; // timestamp del último "no ahora"
const KEY_CALIBRATIONS_LOG = "roccia_calibrations_log_v1"; // mediciones por tramo (motor de auto-calibración)
const DEFAULT_CONSTANT = 5.89; // minutos por 1% (dato empírico del reporte)
const CAPACITY_WH = 111; // Roccia 30,000 mAh @ 3.7V
const SESSIONS_LOG_MAX = 20;
const CALIBRATIONS_LOG_MAX = 100;
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
  remoto?: boolean; // true = llegó como evento sincronizado de otro teléfono
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

// Cada entrada representa un tramo independiente de la curva de descarga:
// desde la última medición (calibración manual o cierre) hasta la actual.
type CalibrationLogEntry = {
  fecha: number;
  rangoBateria: [number, number]; // [% al inicio del tramo, % al final del tramo]
  minutosDelTramo: number;
  constanteMedida: number;
  tipo: "manual" | "cierre";
  origenDeviceId?: string; // presente cuando la medición llegó de otro teléfono
};

// Corrección de "dígito recién cambiado": el display del power bank solo
// muestra enteros, así que el valor real puede estar hasta 0.99 por debajo.
type DigitMode = "none" | "just_changed" | "unknown";

// Estado del indicador de sincronización (Mejora Supabase, punto 4).
type SyncStatus = { kind: "local" } | { kind: "pending"; count: number } | { kind: "synced"; at: number };

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
function loadCalibrationsLog(): CalibrationLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY_CALIBRATIONS_LOG);
    return raw ? (JSON.parse(raw) as CalibrationLogEntry[]) : [];
  } catch {
    return [];
  }
}
function saveCalibrationsLog(log: CalibrationLogEntry[]) {
  localStorage.setItem(KEY_CALIBRATIONS_LOG, JSON.stringify(log.slice(0, CALIBRATIONS_LOG_MAX)));
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

/* ================= MOTOR DE AUTO-CALIBRACIÓN POR TRAMOS ================= */

// Tramos de batería [inicio, fin], de mayor a menor porcentaje.
const TRAMOS: Array<[number, number]> = [
  [100, 90],
  [90, 70],
  [70, 40],
  [40, 0],
];
const TRAMO_MIN_MEASUREMENTS = 2; // por debajo de esto, "modo básico" (sin tramos)
const TRAMO_RECENT_COUNT = 10; // las últimas N mediciones pesan doble

type TramoModel = { range: [number, number]; constant: number }[];

function tramoIndexForPercent(p: number): number {
  if (p > 90) return 0;
  if (p > 70) return 1;
  if (p > 40) return 2;
  return 3;
}

function tramoLabelForPercent(p: number): string {
  const [hi, lo] = TRAMOS[tramoIndexForPercent(p)];
  return `${hi}-${lo}`;
}
function findTramoRangeByLabel(label: string): [number, number] {
  const found = TRAMOS.find((r) => `${r[0]}-${r[1]}` === label);
  return found ?? TRAMOS[TRAMOS.length - 1];
}

/* Media ponderada de las mediciones que caen en el tramo: peso = minutos del
   tramo, y las últimas TRAMO_RECENT_COUNT mediciones del log (global, no por
   tramo) pesan doble. Si el tramo no tiene mediciones, usa el fallback. */
function computeTramoConstant(log: CalibrationLogEntry[], tramoIdx: number, fallback: number): number {
  const recentSet = new Set(log.slice(0, TRAMO_RECENT_COUNT).map((e) => e.fecha));
  const entries = log.filter(
    (e) => tramoIndexForPercent((e.rangoBateria[0] + e.rangoBateria[1]) / 2) === tramoIdx
  );
  if (entries.length === 0) return fallback;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const e of entries) {
    let weight = Math.max(e.minutosDelTramo, 1);
    if (recentSet.has(e.fecha)) weight *= 2;
    weightedSum += weight * e.constanteMedida;
    weightTotal += weight;
  }
  return weightedSum / weightTotal;
}

function buildTramoModel(log: CalibrationLogEntry[], globalConstant: number): TramoModel {
  return TRAMOS.map((range, idx) => ({
    range,
    constant: computeTramoConstant(log, idx, globalConstant),
  }));
}

/* Constante del tramo desde la última medición (calibración manual o cierre)
   hasta la actual: constante_tramo = minutos_del_tramo / %_consumido_del_tramo.
   Devuelve null si el tramo no es válido (sin tiempo o consumo positivo). */
function computeSegmentFromLastAnchor(
  sess: Session,
  currentElapsedMin: number,
  currentRealPercent: number
): { rangoBateria: [number, number]; minutosDelTramo: number; constanteMedida: number } | null {
  const lastCal = sess.calibrations[0];
  const anchorPercent = lastCal ? lastCal.realPercent : sess.initialPercent;
  const anchorElapsedMin = lastCal ? lastCal.elapsedMin : 0;

  const minutosDelTramo = currentElapsedMin - anchorElapsedMin;
  const percentConsumed = anchorPercent - currentRealPercent;
  if (minutosDelTramo <= 0 || percentConsumed <= 0) return null;

  return {
    rangoBateria: [anchorPercent, currentRealPercent],
    minutosDelTramo: Math.round(minutosDelTramo),
    constanteMedida: minutosDelTramo / percentConsumed,
  };
}

/* Proyecta el % de batería avanzando tramo por tramo desde un punto de anclaje,
   cambiando de constante automáticamente al cruzar cada límite de tramo. */
function estimatePercentAndConstant(
  anchorPercent: number,
  minutesElapsedSinceAnchor: number,
  tramoModel: TramoModel
): { percent: number; constant: number; tramoLabel: string } {
  let percent = anchorPercent;
  let remaining = minutesElapsedSinceAnchor;
  let idx = tramoIndexForPercent(percent);
  let activeConstant = tramoModel[idx].constant;
  let activeLabel = `${tramoModel[idx].range[0]}-${tramoModel[idx].range[1]}%`;

  while (remaining > 0 && percent > 0) {
    idx = tramoIndexForPercent(percent);
    const { constant, range } = tramoModel[idx];
    activeConstant = constant;
    activeLabel = `${range[0]}-${range[1]}%`;

    const tramoFloor = range[1];
    const percentAvailable = percent - tramoFloor;
    const minutesToExhaustTramo = percentAvailable * constant;

    if (percentAvailable > 0 && remaining >= minutesToExhaustTramo) {
      remaining -= minutesToExhaustTramo;
      percent = tramoFloor;
      if (idx === TRAMOS.length - 1) break; // llegó a 0%
    } else {
      percent -= remaining / constant;
      remaining = 0;
    }
  }

  return { percent: clamp(percent, 0, 100), constant: activeConstant, tramoLabel: activeLabel };
}

/* Autonomía restante sumando minuto a minuto (tramo por tramo) desde el %
   actual hasta 0, usando la constante propia de cada tramo. */
function remainingMinutesFromPercent(percent: number, tramoModel: TramoModel): number {
  let p = percent;
  let totalMinutes = 0;
  while (p > 0) {
    const idx = tramoIndexForPercent(p);
    const { constant, range } = tramoModel[idx];
    const tramoFloor = range[1];
    totalMinutes += (p - tramoFloor) * constant;
    p = tramoFloor;
    if (idx === TRAMOS.length - 1) break;
  }
  return totalMinutes;
}

type LiveEstimate = {
  percent: number;
  remainingMin: number;
  activeConstant: number;
  tramoLabel: string | null; // null en "modo básico"
  mode: "tramos" | "basico";
};

/* Punto de entrada del motor: con menos de 2 mediciones en el log usa la
   lógica plana de siempre (anclada al inicio de sesión). Con 2 o más, ancla
   en la última calibración manual de la sesión (o el inicio si no hay) y
   proyecta con el modelo por tramos, recalculado en cada render. */
function computeLiveEstimate(
  sess: Session,
  elapsedMinTotal: number,
  calibrationsLog: CalibrationLogEntry[]
): LiveEstimate {
  if (calibrationsLog.length < TRAMO_MIN_MEASUREMENTS) {
    const lost = elapsedMinTotal / sess.constant;
    const percent = clamp(sess.initialPercent - lost, 0, 100);
    return {
      percent,
      remainingMin: percent * sess.constant,
      activeConstant: sess.constant,
      tramoLabel: null,
      mode: "basico",
    };
  }

  const tramoModel = buildTramoModel(calibrationsLog, sess.constant);
  const lastCal = sess.calibrations[0];
  const anchorPercent = lastCal ? lastCal.realPercent : sess.initialPercent;
  const anchorElapsedMin = lastCal ? lastCal.elapsedMin : 0;
  const minutesSinceAnchor = Math.max(0, elapsedMinTotal - anchorElapsedMin);

  const { percent, constant, tramoLabel } = estimatePercentAndConstant(
    anchorPercent,
    minutesSinceAnchor,
    tramoModel
  );

  return {
    percent,
    remainingMin: remainingMinutesFromPercent(percent, tramoModel),
    activeConstant: constant,
    tramoLabel,
    mode: "tramos",
  };
}

/* Corrección de "dígito recién cambiado": el display entero "75" puede ser
   cualquier valor real entre 75.0 y 75.99. */
function applyDigitCorrection(rawValue: number, mode: DigitMode, skipAt100 = false): number {
  if (mode === "none") return rawValue;
  if (skipAt100 && rawValue >= 100) return rawValue;
  return mode === "just_changed" ? rawValue + 0.99 : rawValue + 0.5;
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
function fmtFinishTime(nowTs: number, remainingMin: number): string {
  const now = new Date(nowTs);
  const finish = new Date(nowTs + remainingMin * 60000);
  const sameDay =
    finish.getFullYear() === now.getFullYear() &&
    finish.getMonth() === now.getMonth() &&
    finish.getDate() === now.getDate();
  const hm = finish.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? hm : `mañana ${hm}`;
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

/* Par de botones toggle (mutuamente excluyentes) para la corrección de
   "dígito recién cambiado". Se reutiliza en START, CALIBRAR y STOP/corregir. */
function DigitCorrectionToggle({ mode, onChange }: { mode: DigitMode; onChange: (m: DigitMode) => void }) {
  const optionStyle = (active: boolean): React.CSSProperties => ({
    ...S.btn,
    padding: "10px 4px",
    fontSize: 11.5,
    lineHeight: 1.3,
    background: active ? C.green : C.lcdDim,
    color: active ? C.greenDark : C.muted,
    border: `1px solid ${active ? C.green : C.border}`,
  });
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 4 }}>
      <button
        type="button"
        style={optionStyle(mode === "just_changed")}
        onClick={() => onChange(mode === "just_changed" ? "none" : "just_changed")}
      >
        Acabo de ver el dígito cambiar
      </button>
      <button
        type="button"
        style={optionStyle(mode === "unknown")}
        onClick={() => onChange(mode === "unknown" ? "none" : "unknown")}
      >
        No sé cuándo cambió
      </button>
    </div>
  );
}

/* ================= COMPONENTE PRINCIPAL ================= */

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [now, setNow] = useState(() => Date.now());
  const [initialInput, setInitialInput] = useState("100");
  const [calibInput, setCalibInput] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);
  const [sessionsLog, setSessionsLog] = useState<SessionLogEntry[]>(() => loadSessionsLog());
  const [calibrationsLog, setCalibrationsLog] = useState<CalibrationLogEntry[]>(() => loadCalibrationsLog());
  const [startDigitMode, setStartDigitMode] = useState<DigitMode>("none");
  const [calibDigitMode, setCalibDigitMode] = useState<DigitMode>("none");
  const [stopDigitMode, setStopDigitMode] = useState<DigitMode>("none");

  // Snapshot tomado al presionar STOP: congela el estimado y los minutos
  // transcurridos mientras el usuario decide en el panel de cierre.
  const [stopSnapshot, setStopSnapshot] = useState<{ ts: number; elapsedMin: number; estPercent: number } | null>(null);
  const [stopStage, setStopStage] = useState<"confirm" | "correct">("confirm");
  const [stopCorrectInput, setStopCorrectInput] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Sincronización multi-dispositivo (Supabase). Sin código de hogar, la app
  // funciona exactamente igual que en modo solo local.
  const [hogar, setHogar] = useState<HogarConfig | null>(() => loadHogar());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() =>
    loadHogar() ? { kind: "pending", count: outboxLength() } : { kind: "local" }
  );
  const [joinCodeInput, setJoinCodeInput] = useState("");

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

  // Sincronización: al abrir la app (si hay hogar), suscripción Realtime al
  // canal del hogar, y reintento al recuperar conexión. Todo silencioso.
  useEffect(() => {
    if (!hogar) {
      setSyncStatus({ kind: "local" });
      return;
    }
    void triggerSync();

    const unsubscribe = subscribeRealtime(hogar, (event) => {
      applyRemoteEvents([event]);
      void triggerSync();
    });
    function handleOnline() {
      void triggerSync();
    }
    window.addEventListener("online", handleOnline);

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hogar]);

  // Con sesión activa, reintenta cada 60s (además de al abrir y tras cada evento).
  useEffect(() => {
    if (!hogar || !session) return;
    const id = window.setInterval(() => void triggerSync(), 60000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hogar, !!session]);

  /* ---------- Cálculos en vivo (sección 5 del reporte) ---------- */
  const elapsedMin = session ? (now - session.startTs) / 60000 : 0;
  // Motor de auto-calibración por tramos (Mejora 1): ancla en la última
  // calibración de la sesión y usa la constante del tramo activo. Con menos
  // de 2 mediciones en el log global, cae en "modo básico" (lógica anterior).
  const liveEstimate = session ? computeLiveEstimate(session, elapsedMin, calibrationsLog) : null;
  const estPercent = liveEstimate ? liveEstimate.percent : 0;
  const remainingMin = liveEstimate ? liveEstimate.remainingMin : 0;
  const watts = session ? (CAPACITY_WH * (60 / session.constant)) / 100 : 0;
  const percentPerHour = session ? 60 / session.constant : 0;
  const batteryHealth = computeBatteryHealth(sessionsLog);

  /* ---------- Acciones ---------- */

  /* ---------- Sincronización multi-dispositivo (Supabase) ----------
     Regla de oro: localStorage manda siempre. Esto solo lee/escribe estado
     ya aplicado localmente; nunca bloquea ni lanza errores visibles. */

  // Acepta un hogar explícito para los llamados que ocurren en el mismo
  // tick en que se acaba de crear/vincular (el estado de React `hogar`
  // todavía no se actualizó ahí: setHogar es asíncrono).
  async function triggerSync(hogarOverride?: HogarConfig) {
    const target = hogarOverride ?? hogar;
    if (!target) {
      setSyncStatus({ kind: "local" });
      return;
    }
    const result = await runSyncCycle(target);
    if (result.newRemoteEvents.length > 0) applyRemoteEvents(result.newRemoteEvents);

    if (result.pendingCount > 0) {
      setSyncStatus({ kind: "pending", count: result.pendingCount });
    } else if (result.reached) {
      setSyncStatus({ kind: "synced", at: Date.now() });
    }
    // si no hay pendientes y no se alcanzó la red, se conserva el estado anterior
  }

  /* Aplica eventos remotos en orden de ts_evento sobre un estado de trabajo
     local (evita condiciones de carrera si llega más de uno en el mismo lote). */
  function applyRemoteEvents(events: SyncEvent[]) {
    if (events.length === 0) return;
    const sorted = [...events].sort((a, b) => a.ts_evento - b.ts_evento);

    let workingSession = session;
    let workingSessionsLog = sessionsLog;
    let workingCalibrationsLog = calibrationsLog;
    let notice: { text: string; tone: "ok" | "warn" | "err" } | null = null;
    let didReset = false;

    for (const event of sorted) {
      if (event.tipo === "sesion_inicio") {
        if (!workingSession) {
          const payload = event.payload as { porcentajeInicial: number; constante: number };
          workingSession = {
            startTs: event.ts_evento,
            initialPercent: payload.porcentajeInicial,
            constant: payload.constante,
            calibrations: [],
          };
          notice = { text: "Sesión iniciada desde otro teléfono.", tone: "ok" };
        }
      } else if (event.tipo === "calibracion") {
        const payload = event.payload as {
          porcentajeReal: number;
          nuevaConstante: number;
          tramo: string;
          minutos: number;
        };
        const range = findTramoRangeByLabel(payload.tramo);
        const remoteEntry: CalibrationLogEntry = {
          fecha: event.ts_evento,
          rangoBateria: range,
          minutosDelTramo: payload.minutos,
          constanteMedida: payload.nuevaConstante,
          tipo: "manual",
          origenDeviceId: event.device_id,
        };
        workingCalibrationsLog = [remoteEntry, ...workingCalibrationsLog].slice(0, CALIBRATIONS_LOG_MAX);

        if (workingSession) {
          const entry: Calibration = {
            hora: fmtClock(event.ts_evento),
            elapsedMin: Math.round((event.ts_evento - workingSession.startTs) / 60000),
            estPercent: payload.porcentajeReal,
            realPercent: payload.porcentajeReal,
            deviation: 0,
            newConstant: payload.nuevaConstante,
            remoto: true,
          };
          workingSession = {
            ...workingSession,
            constant: payload.nuevaConstante,
            calibrations: [entry, ...workingSession.calibrations].slice(0, 8),
          };
        }
      } else if (event.tipo === "sesion_fin") {
        const payload = event.payload as {
          porcentajeFinal: number;
          verificado: boolean;
          desfase: number;
          constanteFinal: number;
          startTs?: number;
          initialPercent?: number;
          elapsedMin?: number;
        };
        const startTs = workingSession?.startTs ?? payload.startTs;
        const initialPercent = workingSession?.initialPercent ?? payload.initialPercent;
        if (startTs != null && initialPercent != null) {
          const elapsedMinEntry = payload.elapsedMin ?? Math.round((event.ts_evento - startTs) / 60000);
          workingSessionsLog = [
            {
              startTs,
              endTs: event.ts_evento,
              initialPercent,
              estFinalPercent: payload.porcentajeFinal,
              realFinalPercent: payload.porcentajeFinal,
              deviation: payload.desfase,
              elapsedMin: elapsedMinEntry,
              constant: payload.constanteFinal,
              verified: payload.verificado,
            },
            ...workingSessionsLog,
          ].slice(0, SESSIONS_LOG_MAX);
        }
        if (workingSession && workingSession.startTs === startTs) {
          workingSession = null;
          notice = { text: "Sesión finalizada desde otro teléfono.", tone: "ok" };
        }
      } else if (event.tipo === "reset") {
        workingSession = null;
        workingSessionsLog = [];
        workingCalibrationsLog = [];
        didReset = true;
        notice = { text: "Los datos fueron restablecidos desde otro teléfono.", tone: "warn" };
      }
    }

    setSession(workingSession);
    saveSession(workingSession);
    setSessionsLog(workingSessionsLog);
    saveSessionsLog(workingSessionsLog);
    setCalibrationsLog(workingCalibrationsLog);
    saveCalibrationsLog(workingCalibrationsLog);
    if (didReset) {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("roccia_"))
        .forEach((k) => localStorage.removeItem(k));
      setHogar(null);
    }
    if (notice) setMsg(notice);
  }

  // Sube como eventos históricos el log de sesiones y calibraciones existentes
  // (y la sesión en curso, si hay una) para que el otro teléfono los herede.
  function migrateHistoryToHogar(cfg: HogarConfig, sesionActiva: Session | null) {
    for (const s of sessionsLog) {
      enqueueEvent(
        cfg,
        "sesion_fin",
        {
          porcentajeFinal: s.realFinalPercent,
          verificado: s.verified,
          desfase: s.deviation,
          constanteFinal: s.constant,
          startTs: s.startTs,
          initialPercent: s.initialPercent,
          elapsedMin: s.elapsedMin,
        },
        s.endTs
      );
    }
    for (const c of calibrationsLog) {
      enqueueEvent(
        cfg,
        "calibracion",
        {
          porcentajeReal: c.rangoBateria[1],
          nuevaConstante: c.constanteMedida,
          tramo: tramoLabelForPercent((c.rangoBateria[0] + c.rangoBateria[1]) / 2),
          minutos: c.minutosDelTramo,
        },
        c.fecha
      );
    }
    if (sesionActiva) {
      enqueueEvent(
        cfg,
        "sesion_inicio",
        { porcentajeInicial: sesionActiva.initialPercent, constante: sesionActiva.constant },
        sesionActiva.startTs
      );
    }
  }

  function handleCreateHogar() {
    const cfg = setupHogarNuevo();
    setHogar(cfg);
    migrateHistoryToHogar(cfg, session);
    setMsg({
      text: `Hogar creado: ${cfg.codigo}. Compártelo con el otro teléfono para vincularlo y sincronizar el historial.`,
      tone: "ok",
    });
    void triggerSync(cfg);
  }

  function handleJoinHogar() {
    const codigo = joinCodeInput.trim().toUpperCase();
    if (!codigo) {
      setMsg({ text: "Ingresa un código de hogar válido.", tone: "err" });
      return;
    }
    const cfg = setupHogarExistente(codigo);
    setHogar(cfg);
    setJoinCodeInput("");
    migrateHistoryToHogar(cfg, session);
    setMsg({ text: `Vinculado al hogar ${cfg.codigo}. Sincronizando historial existente...`, tone: "ok" });
    void triggerSync(cfg);
  }

  function handleCopyCode() {
    if (!hogar) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(hogar.codigo).then(
        () => setMsg({ text: "Código copiado. Compártelo por WhatsApp con el otro teléfono.", tone: "ok" }),
        () => setMsg({ text: `Código del hogar: ${hogar.codigo}`, tone: "ok" })
      );
    } else {
      setMsg({ text: `Código del hogar: ${hogar.codigo}`, tone: "ok" });
    }
  }

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
    const pRaw = parseFloat(initialInput);
    if (!Number.isFinite(pRaw) || pRaw <= 0 || pRaw > 100) {
      setMsg({ text: "Ingresa un porcentaje inicial válido (1 – 100).", tone: "err" });
      return;
    }
    const p = applyDigitCorrection(pRaw, startDigitMode, true); // 100% no se corrige
    const s: Session = {
      startTs: Date.now(),
      initialPercent: p,
      constant: loadLearnedConstant(), // arranca con la constante aprendida
      calibrations: [],
    };
    setSession(s);
    saveSession(s);
    setStartDigitMode("none");
    if (hogar) {
      enqueueEvent(hogar, "sesion_inicio", { porcentajeInicial: p, constante: s.constant }, s.startTs);
      void triggerSync();
    }

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
    setStopDigitMode("none");
  }

  function handleStopCancel() {
    setStopSnapshot(null);
    setStopStage("confirm");
    setStopCorrectInput("");
    setStopDigitMode("none");
  }

  function recordCalibrationLog(entry: CalibrationLogEntry) {
    const updated = [entry, ...loadCalibrationsLog()].slice(0, CALIBRATIONS_LOG_MAX);
    saveCalibrationsLog(updated);
    setCalibrationsLog(updated);
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
    if (hogar) {
      enqueueEvent(
        hogar,
        "sesion_fin",
        {
          porcentajeFinal: finalPercent,
          verificado: true,
          desfase: 0,
          constanteFinal: constant,
          startTs: session.startTs,
          initialPercent: session.initialPercent,
          elapsedMin: Math.round(stopSnapshot.elapsedMin),
        },
        stopSnapshot.ts
      );
      void triggerSync();
    }

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
    const realRaw = parseFloat(stopCorrectInput);
    if (!Number.isFinite(realRaw) || realRaw < 0 || realRaw > session.initialPercent) {
      setMsg({
        text: `Ingresa el % real que muestra el power bank (entre 0 y ${session.initialPercent}).`,
        tone: "err",
      });
      return;
    }
    const real = applyDigitCorrection(realRaw, stopDigitMode, true);

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
      if (hogar) {
        enqueueEvent(
          hogar,
          "sesion_fin",
          {
            porcentajeFinal: real,
            verificado: false,
            desfase: deviation,
            constanteFinal: constantUnchanged,
            startTs: session.startTs,
            initialPercent: session.initialPercent,
            elapsedMin: elapsedMinRounded,
          },
          stopSnapshot.ts
        );
        void triggerSync();
      }
      setSession(null);
      saveSession(null);
      setStopSnapshot(null);
      setCalibInput("");
      setStopDigitMode("none");
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
    // Registro de tramo para el motor de auto-calibración (no afecta session.constant).
    const segment = computeSegmentFromLastAnchor(session, stopSnapshot.elapsedMin, real);

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
    if (segment) {
      recordCalibrationLog({
        fecha: Date.now(),
        rangoBateria: segment.rangoBateria,
        minutosDelTramo: segment.minutosDelTramo,
        constanteMedida: segment.constanteMedida,
        tipo: "cierre",
      });
      if (hogar) {
        enqueueEvent(
          hogar,
          "calibracion",
          {
            porcentajeReal: real,
            nuevaConstante: segment.constanteMedida,
            tramo: tramoLabelForPercent((segment.rangoBateria[0] + segment.rangoBateria[1]) / 2),
            minutos: segment.minutosDelTramo,
          },
          stopSnapshot.ts
        );
      }
    }
    if (hogar) {
      enqueueEvent(
        hogar,
        "sesion_fin",
        {
          porcentajeFinal: real,
          verificado: false,
          desfase: deviation,
          constanteFinal: newConstantRounded,
          startTs: session.startTs,
          initialPercent: session.initialPercent,
          elapsedMin: elapsedMinRounded,
        },
        stopSnapshot.ts
      );
      void triggerSync();
    }

    setSession(null);
    saveSession(null);
    setStopSnapshot(null);
    setCalibInput("");
    setStopDigitMode("none");

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
    const realRaw = parseFloat(calibInput);
    if (!Number.isFinite(realRaw) || realRaw < 0 || realRaw > session.initialPercent) {
      setMsg({
        text: `Ingresa el % real que muestra el power bank (entre 0 y ${session.initialPercent}).`,
        tone: "err",
      });
      return;
    }
    const real = applyDigitCorrection(realRaw, calibDigitMode, true);
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
    // Registro de tramo para el motor de auto-calibración (no afecta session.constant).
    const segment = computeSegmentFromLastAnchor(session, elapsedMin, real);

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
    setCalibDigitMode("none");
    if (segment) {
      recordCalibrationLog({
        fecha: Date.now(),
        rangoBateria: segment.rangoBateria,
        minutosDelTramo: segment.minutosDelTramo,
        constanteMedida: segment.constanteMedida,
        tipo: "manual",
      });
      if (hogar) {
        enqueueEvent(hogar, "calibracion", {
          porcentajeReal: real,
          nuevaConstante: segment.constanteMedida,
          tramo: tramoLabelForPercent((segment.rangoBateria[0] + segment.rangoBateria[1]) / 2),
          minutos: segment.minutosDelTramo,
        });
        void triggerSync();
      }
    }

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
  async function handleFactoryReset() {
    // Aviso best-effort a los otros teléfonos antes de borrar el emparejamiento
    // local (la cola/outbox también se va a borrar, así que no tiene caso encolarlo).
    if (hogar) {
      try {
        const { error } = await supabase.from("eventos").insert({
          id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          hogar_codigo: hogar.codigo,
          device_id: hogar.deviceId,
          tipo: "reset",
          ts_evento: Date.now(),
          payload: {},
        });
        if (error) console.error("[sync] fallo al avisar el reset a Supabase:", error);
      } catch (err) {
        // sin conexión: el otro teléfono simplemente no se entera de este reset
        console.error("[sync] excepción al avisar el reset a Supabase (sin conexión?):", err);
      }
    }
    Object.keys(localStorage)
      .filter((k) => k.startsWith("roccia_"))
      .forEach((k) => localStorage.removeItem(k));
    setSessionsLog([]);
    setCalibrationsLog([]);
    setHogar(null);
    setSyncStatus({ kind: "local" });
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

        {/* ===== INDICADOR DE SINCRONIZACIÓN ===== */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 4px 12px", fontSize: 11 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              display: "inline-block",
              background: syncStatus.kind === "synced" ? C.lcd : syncStatus.kind === "pending" ? C.amber : C.muted,
            }}
          />
          <span style={{ color: C.muted }}>
            {syncStatus.kind === "synced" && `Sincronizado ${fmtClock(syncStatus.at)}`}
            {syncStatus.kind === "pending" &&
              `${syncStatus.count} evento${syncStatus.count === 1 ? "" : "s"} pendiente${syncStatus.count === 1 ? "" : "s"}`}
            {syncStatus.kind === "local" && "Solo local"}
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

        {/* ===== HORA ESTIMADA DE FIN ===== */}
        {session && liveEstimate && (
          <div style={{ ...S.metric, marginTop: 14 }}>
            <div style={S.metricLabel}>Batería agotada a las</div>
            <div style={S.metricValue}>{fmtFinishTime(now, liveEstimate.remainingMin)}</div>
          </div>
        )}

        {/* ===== MÉTRICAS ===== */}
        {session && liveEstimate && (
          <div style={S.grid}>
            <div style={S.metric}>
              <div style={S.metricLabel}>Autonomía restante</div>
              <div style={S.metricValue}>{fmtHM(remainingMin)}</div>
            </div>
            <div style={S.metric}>
              <div style={S.metricLabel}>Ritmo actual</div>
              <div style={S.metricValue}>{liveEstimate.activeConstant.toFixed(2)} m/%</div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                {liveEstimate.mode === "tramos" ? `auto-ajuste: tramo ${liveEstimate.tramoLabel}` : "modo básico"}
              </div>
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
            <DigitCorrectionToggle mode={startDigitMode} onChange={setStartDigitMode} />
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
                    <DigitCorrectionToggle mode={stopDigitMode} onChange={setStopDigitMode} />
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
                <DigitCorrectionToggle mode={calibDigitMode} onChange={setCalibDigitMode} />
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
                    <span>
                      {c.hora}
                      {c.remoto ? " ↔" : ""}
                    </span>
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

        {/* ===== SINCRONIZACIÓN ===== */}
        {!session && (
          <div style={S.section}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sincronización</div>
            {hogar ? (
              <>
                <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
                  Este teléfono está vinculado al hogar. Toca el código para copiarlo y
                  compartirlo por WhatsApp con el otro teléfono.
                </div>
                <div
                  style={{ ...S.input, cursor: "pointer", letterSpacing: 1 }}
                  onClick={handleCopyCode}
                >
                  {hogar.codigo}
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
                  Vincula este teléfono con otro para compartir el monitoreo y el aprendizaje
                  de la batería. Sin código configurado, la app sigue funcionando 100% local.
                </div>
                <div style={S.btnRow}>
                  <button
                    style={{ ...S.btn, background: C.green, color: C.greenDark }}
                    onClick={handleCreateHogar}
                  >
                    Crear código de hogar
                  </button>
                </div>
                <div style={{ fontSize: 12, color: C.muted, margin: "12px 0 6px", textAlign: "center" }}>
                  o ingresa un código existente
                </div>
                <input
                  style={S.input}
                  type="text"
                  placeholder="ROCCIA-XXXX"
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                />
                <div style={S.btnRow}>
                  <button
                    style={{ ...S.btn, background: C.card, color: C.text, border: `1px solid ${C.border}` }}
                    onClick={handleJoinHogar}
                  >
                    Vincular
                  </button>
                </div>
              </>
            )}
          </div>
        )}

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
